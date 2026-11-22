// Ingest — yt-dlp download (rights-confirmed only), audio extract,
// resolution probe, faster-whisper transcript with word timestamps.
// Retry 2x, then fail with a clear message. No speech in the source =>
// transcript is empty and Viral Moments cuts on visual moments instead —
// a fixture transcript is NEVER used for a real job.
import { copyFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ffprobe, extractWav, run } from '../packages/shared/media.mjs';
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';

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
  const probe = await ffprobe(sourcePath);
  logEvent(job, 'ingest', 'running', `Ingest: source probed — ${probe.width}x${probe.height}, ${probe.duration.toFixed(1)}s, audio ${probe.hasAudio ? 'present' : 'MISSING'}.`, emit);

  // Transcript — Whisper can take 90s+ on the free tier for long videos, and
  // the job looked frozen (no progress, stale updatedAt) while it ran. Log
  // the start and heartbeat every 15s so the Studio never reads "stuck".
  const wav = join(dir, 'audio.wav');
  let transcript = { segments: [], words: [], language: null, empty: true, engine: 'faster-whisper' };
  if (probe.hasAudio) {
    await extractWav(sourcePath, wav);
    logEvent(job, 'ingest', 'running', 'Ingest: audio extracted — transcribing with faster-whisper (tiny model). Longer videos take a while; progress updates every 15s.', emit);
    const heartbeat = setInterval(() => {
      logEvent(job, 'ingest', 'running', 'Ingest: still transcribing…', emit);
      saveJob(job).catch(() => {});
    }, 15000);
    try {
      const { stdout } = await run('python3', [WHISPER_SCRIPT, wav, '--model', process.env.WHISPER_MODEL || 'tiny'], { timeoutMs: 600000 });
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
    sourcePath, sourceFile: job.input.sourceFile || 'source.mp4',
    probe, transcript,
    transcriptEmpty: transcript.empty,
  };
  job.agents.ingest.output = output;
  setAgent(job, 'ingest', 'done', output, null, emit);
  await saveJob(job);
  return output;
}
