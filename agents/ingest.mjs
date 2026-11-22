// Ingest — yt-dlp download (rights-confirmed only), audio extract,
// resolution probe, faster-whisper transcript with word timestamps.
// Retry 2x, then fail with a clear message. No speech in the source =>
// transcript is empty and Viral Moments cuts on visual moments instead —
// a fixture transcript is NEVER used for a real job.
import { copyFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ffprobe, extractWav, run } from '../packages/shared/media.mjs';
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';
import { r2Config, mirrorJobFile } from '../packages/shared/store.mjs';
import { sendSourceToTelegram, postJobSnapshot } from './telegram.mjs';
import { deskAvailable, silenceCut, denoiseWav, losslessTrim } from './editing-desk.mjs';

const WHISPER_SCRIPT = new URL('../scripts/whisper.py', import.meta.url).pathname;

export async function runIngest(job, ctx) {
  const { emit } = ctx;
  const dir = job.dirAbs;
  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    job.agents.ingest.attempts = attempt;
    try {
      return await ingestOnce(job, ctx);
    } catch (err) {
      logEvent(job, 'ingest', 'failed', `Ingest attempt ${attempt} failed: ${err.message}`, emit);
      if (attempt >= 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

async function ingestOnce(job, ctx) {
  const { emit } = ctx;
  const dir = job.dirAbs;
  let sourcePath;
  if (job.input.sourceFile) {
    sourcePath = join(dir, job.input.sourceFile);
    logEvent(job, 'ingest', 'running', 'Ingest: using your uploaded file — no download needed.', emit);
  } else {
    // URL jobs reach here only after the Guard rejected unconfirmed rights.
    sourcePath = join(dir, 'source.mp4');
    logEvent(job, 'ingest', 'running', 'Ingest: downloading with yt-dlp (rights-confirmed source only)…', emit);
    await run('python3', ['-m', 'yt_dlp',
      '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist', '--no-warnings',
      '-o', sourcePath, job.input.sourceUrl,
    ], { timeoutMs: 600000 });
  }
  let probe = await ffprobe(sourcePath);
  logEvent(job, 'ingest', 'running', `Ingest: source probed — ${probe.width}x${probe.height}, ${probe.duration.toFixed(1)}s, audio ${probe.hasAudio ? 'present' : 'MISSING'}.`, emit);

  // Editing-desk stages (all optional, default OFF, env-gated — see
  // agents/editing-desk.mjs). Each stage either produces a new working
  // source or fails soft and the original is kept. Downstream agents only
  // ever see the final working source, so transcript timings stay valid.
  const desk = job.input.desk || {};
  let workingFile = job.input.sourceFile || 'source.mp4';
  const deskUsed = {};
  if (desk.losslessTrim && Number.isFinite(desk.trimStart) && Number.isFinite(desk.trimEnd)) {
    try {
      const trimmed = join(dir, 'source-trimmed.mp4');
      const r = await losslessTrim(sourcePath, trimmed, desk.trimStart, desk.trimEnd);
      sourcePath = trimmed; workingFile = 'source-trimmed.mp4';
      probe = await ffprobe(sourcePath);
      deskUsed.losslessTrim = { start: desk.trimStart, end: desk.trimEnd, outDuration: +r.outDuration.toFixed(2) };
      logEvent(job, 'ingest', 'running', `Ingest: lossless pre-trim ${desk.trimStart}s–${desk.trimEnd}s (ffmpeg -c copy, LosslessCut concept) — working source is now ${r.outDuration.toFixed(1)}s.`, emit);
    } catch (err) {
      logEvent(job, 'ingest', 'running', `Ingest: lossless pre-trim skipped (${err.message.slice(0, 120)}) — using the full source.`, emit);
    }
  }
  if (desk.silenceCut && probe.hasAudio) {
    if (!deskAvailable()) {
      logEvent(job, 'ingest', 'running', 'Ingest: silence cut is ON but EDITING_DESK is not set on this host — skipping, job continues as before.', emit);
    } else {
      try {
        const cut = join(dir, 'source-cut.mp4');
        const r = await silenceCut(sourcePath, cut);
        sourcePath = cut; workingFile = 'source-cut.mp4';
        probe = await ffprobe(sourcePath);
        deskUsed.silenceCut = { inDuration: +r.inDuration.toFixed(2), outDuration: +r.outDuration.toFixed(2), removedSeconds: r.removedSeconds };
        logEvent(job, 'ingest', 'running', `Ingest: silence cut removed ${r.removedSeconds}s of silence (auto-editor) — working source is now ${r.outDuration.toFixed(1)}s.`, emit);
      } catch (err) {
        logEvent(job, 'ingest', 'running', `Ingest: silence cut skipped (${err.message.slice(0, 120)}) — using the uncut source.`, emit);
      }
    }
  }
  // The working source is what every later agent cuts from, and what the
  // Telegram/R2 mirrors save — keep the record in sync.
  job.input.sourceFile = workingFile;

  // Transcript — Whisper can take 90s+ on the free tier for long videos, and
  // the job looked frozen (no progress, stale updatedAt) while it ran. Log
  // the start and heartbeat every 15s so the Studio never reads "stuck".
  const wav = join(dir, 'audio.wav');
  let transcript = { segments: [], words: [], language: null, empty: true, engine: 'faster-whisper' };
  if (probe.hasAudio) {
    await extractWav(sourcePath, wav);
    let transcribeWav = wav;
    if (desk.denoise) {
      if (!deskAvailable()) {
        logEvent(job, 'ingest', 'running', 'Ingest: denoise is ON but EDITING_DESK is not set on this host — transcribing the raw audio.', emit);
      } else {
        try {
          const r = await denoiseWav(wav, join(dir, 'denoised'));
          transcribeWav = r.out;
          deskUsed.denoise = { out: 'denoised/audio.wav', duration: +r.duration.toFixed(2) };
          logEvent(job, 'ingest', 'running', 'Ingest: audio denoised (DeepFilterNet) — transcribing the clean track.', emit);
        } catch (err) {
          logEvent(job, 'ingest', 'running', `Ingest: denoise skipped (${err.message.slice(0, 120)}) — transcribing the raw audio.`, emit);
        }
      }
    }
    logEvent(job, 'ingest', 'running', 'Ingest: audio extracted — transcribing with faster-whisper (tiny model). Longer videos take a while; progress updates every 15s.', emit);
    const heartbeat = setInterval(() => {
      logEvent(job, 'ingest', 'running', 'Ingest: still transcribing…', emit);
      saveJob(job).catch(() => {});
    }, 15000);
    try {
      const { stdout } = await run('python3', [WHISPER_SCRIPT, transcribeWav, '--model', process.env.WHISPER_MODEL || 'tiny'], { timeoutMs: 600000 });
      const parsed = JSON.parse(stdout);
      transcript = { ...parsed, engine: 'faster-whisper' };
      transcript.empty = (transcript.words || []).length === 0;
    } catch (err) {
      logEvent(job, 'ingest', 'running', `Ingest: Whisper failed (${err.message.slice(0, 120)}) — transcript unavailable, continuing with no transcript.`, emit);
      transcript = { segments: [], words: [], language: null, empty: true, engine: 'faster-whisper (failed)' };
    } finally {
      clearInterval(heartbeat);
    }
  }
  if (transcript.empty) {
    logEvent(job, 'ingest', 'done', 'Ingest: transcript empty — no speech detected. Clips will be cut on visual moments instead.', emit);
  } else {
    logEvent(job, 'ingest', 'done', `Ingest: transcript ready — ${(transcript.words || []).length} words, ${(transcript.segments || []).length} sentences.`, emit);
  }
  const output = {
    sourcePath, sourceFile: workingFile,
    probe, transcript,
    transcriptEmpty: transcript.empty,
    desk: deskUsed,
  };
  job.agents.ingest.output = output;
  setAgent(job, 'ingest', 'done', output, null, emit);
  await saveJob(job);
  // Best-effort: mirror the source file — it is the input every later
  // agent needs, so a wiped job can only resume if this copy survives.
  const srcName = job.input.sourceFile || 'source.mp4';
  await mirrorJobFile({ config: r2Config(process.env), jobId: job.id, dirAbs: job.dirAbs, filename: srcName, contentType: 'video/mp4' });
  // Telegram storage: source video + job snapshot to the channel.
  await sendSourceToTelegram(job, ctx);
  await postJobSnapshot(job, ctx, { stage: 'ingest' });
  return output;
}
