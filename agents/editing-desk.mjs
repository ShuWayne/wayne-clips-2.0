// Editing Desk — optional pipeline stages from ~/workspace/editing-desk.
//
// ARCHITECTURE (read before changing anything):
// - The desk lives on the local VM only. Render's free tier (512 MB RAM,
//   ephemeral disk) CANNOT run the torch tools (demucs, Real-ESRGAN,
//   rembg, chatterbox) or headless Chrome (hyperframes). So EVERY stage
//   here is env-gated and graceful: it runs only when EDITING_DESK points
//   at a desk dir AND the tool binary is actually present. When either is
//   missing, the stage SKIPS silently and the job continues exactly as it
//   did before the desk existed. Never break existing behaviour.
// - Stages are also job-gated: each one needs job.input.desk.<stage> ===
//   true (Settings toggles, default OFF). No stage runs by accident.
// - No stage ever contacts hf.co (HuggingFace). Shu banned hf.co fetches
//   (22 Nov 2026, standing rule — "Ab mat bejhna"). All model weights
//   used here are already local (repo clone or ~/.cache). Child processes
//   run with HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1, so a missing
//   cache FAILS the stage instead of downloading.
// - Chatterbox voiceover is WIRED AS DISABLED: its weights (~1 GB) come
//   only from HuggingFace. See chatterboxVoiceover() — it never spawns.
// - DaVinci Resolve MCP is EXCLUDED entirely: Resolve is a desktop app,
//   the MCP server cannot control anything server-side. See docs.
// - yt-dlp + faster-whisper are NOT desk stages — they are already wired
//   in the app (packages/shared/media.mjs, scripts/whisper.py) using
//   system Python, which already works. The desk venv's faster-whisper
//   needed `av` pinned to 14.2.0; the app does not use the desk venv.
import { access, constants, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { ffprobe, run } from '../packages/shared/media.mjs';

export const DESK_STAGES = [
  { id: 'losslessTrim', name: 'Lossless pre-trim', where: 'ingest', note: 'ffmpeg stream copy (-c copy); the LosslessCut concept. Needs only ffmpeg, so it also works on Render.' },
  { id: 'silenceCut', name: 'Silence cut (auto-editor)', where: 'ingest', note: 'Cuts silence before moment-picking. Rejected if it would remove >40% of the source.' },
  { id: 'denoise', name: 'Denoise audio (DeepFilterNet)', where: 'ingest', note: 'Denoises the extracted wav before Whisper. Model is local, zero download.' },
  { id: 'demucsVocals', name: 'Vocal isolation (demucs)', where: 'effects/render', note: 'Vocals stem replaces the clip audio. ~50s per 15s of audio on CPU — slow, optional.' },
  { id: 'rembgPoster', name: 'Background-removed poster (rembg)', where: 'render', note: 'u2net ONLY. The default bria-rmbg model OOM-kills this 6 GB box.' },
  { id: 'upscalePoster', name: 'Upscaled poster (Real-ESRGAN)', where: 'render', note: '2x upscale, tiled (--tile 400). Untiled OOM-kills this box.' },
  { id: 'titleCard', name: 'Animated title card (hyperframes)', where: 'render', note: 'Portrait 1080x1920 title card as a job deliverable. Title is centred in the 80% title-safe box (fixed 22 Nov — the scaffold left-aligns it to the frame edge).' },
  { id: 'wordpop', name: 'Word-pop captions (remotion style)', where: 'subtitle', note: 'Caption STYLE, not a binary — the spoken word pops big + highlighted. No new dependency.' },
  { id: 'chatterbox', name: 'Chatterbox voiceover', where: 'publish', note: 'DISABLED — weights (~1 GB) come only from HuggingFace, which Shu has banned. Never fetches.' },
];

// --- gating ---------------------------------------------------------------
export function deskRoot() {
  const r = (process.env.EDITING_DESK || '').trim();
  return r || null;
}

export function deskAvailable() {
  const r = deskRoot();
  return !!r && existsSync(r);
}

export async function toolExists(relPath) {
  const r = deskRoot();
  if (!r) return false;
  try { await access(join(r, relPath), constants.X_OK); return true; }
  catch { return false; }
}

export function stageEnabled(job, stage) {
  return job?.input?.desk?.[stage] === true;
}

// Env for desk child processes. TMPDIR is the desk scratch dir — /tmp is a
// 512 MB tmpfs and several tools refuse it or fill it. HF_*_OFFLINE=1
// makes a missing model cache fail the stage instead of downloading.
export function deskEnv(extra = {}) {
  const r = deskRoot();
  const venvBin = r ? join(r, 'venv/bin') : '';
  return {
    ...process.env,
    ...(venvBin ? { PATH: `${venvBin}:${process.env.PATH || ''}` } : {}),
    TMPDIR: r ? join(r, '.tmp') : process.env.TMPDIR,
    OMP_NUM_THREADS: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HYPERFRAMES_CACHE_DIR: process.env.HYPERFRAMES_CACHE_DIR || '/opt/hyperframes-cache',
    ...extra,
  };
}

async function ensureDeskTmp() {
  const r = deskRoot();
  if (r) await mkdir(join(r, '.tmp'), { recursive: true });
}

function fail(msg) { return Object.assign(new Error(msg), { deskStage: true }); }

// ffprobe on audio-only files: the shared ffprobe() requires a video
// stream, so denoise/demucs wav outputs need their own duration probe.
async function probeAudioDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { timeoutMs: 60000 });
  const d = parseFloat(JSON.parse(stdout).format?.duration || 0);
  if (!Number.isFinite(d) || d <= 0) throw fail(`could not probe duration of ${file}`);
  return { duration: d };
}

// --- 1. auto-editor: silence-cut ------------------------------------------
export async function silenceCut(sourcePath, outPath, { timeoutMs = 600000, runImpl = run, probeImpl = ffprobe } = {}) {
  const venv = join(deskRoot(), 'venv/bin/auto-editor');
  if (!(await toolExists('venv/bin/auto-editor'))) throw fail('auto-editor not installed in the editing desk');
  await ensureDeskTmp();
  const before = await probeImpl(sourcePath);
  await runImpl(venv, [sourcePath, '--edit', 'audio', '--margin', '0.5s', '-o', outPath],
    { timeoutMs, env: deskEnv() });
  if (!existsSync(outPath)) throw fail('auto-editor produced no output file');
  const after = await probeImpl(outPath);
  // Safety: never accept a cut that removes more than 40% of the source.
  // (The smoke test cut a quiet sine 6s -> 2.2s; real speech keeps ~80%.)
  if (after.duration < before.duration * 0.6) {
    throw fail(`auto-editor would remove too much (${before.duration.toFixed(1)}s -> ${after.duration.toFixed(1)}s) — keeping the original`);
  }
  if (!after.hasAudio) throw fail('auto-editor output has no audio — keeping the original');
  return { inDuration: before.duration, outDuration: after.duration, removedSeconds: +(before.duration - after.duration).toFixed(2) };
}

// --- 2. DeepFilterNet: denoise --------------------------------------------
export const DF_MODEL = 'repos/DeepFilterNet/models/DeepFilterNet3_onnx.tar.gz';

export async function denoiseWav(wavPath, outDir, { timeoutMs = 300000, runImpl = run, probeImpl = probeAudioDuration } = {}) {
  const bin = join(deskRoot(), 'deepfilternet/deep-filter');
  if (!(await toolExists('deepfilternet/deep-filter'))) throw fail('DeepFilterNet binary not installed in the editing desk');
  const model = join(deskRoot(), DF_MODEL);
  if (!existsSync(model)) throw fail('DeepFilterNet model not found in the desk repo clone');
  await mkdir(outDir, { recursive: true });
  // Gotcha: -o takes an OUTPUT DIRECTORY, not a file.
  await runImpl(bin, ['-m', model, wavPath, '-o', outDir], { timeoutMs, env: deskEnv() });
  const out = join(outDir, basename(wavPath));
  if (!existsSync(out)) throw fail('DeepFilterNet produced no output wav');
  const probe = await probeImpl(out);
  return { out, duration: probe.duration };
}

// --- 3. demucs: vocal isolation -------------------------------------------
// Runs offline (HF_HUB_OFFLINE=1): the htdemucs model is already cached in
// ~/.cache/torch/hub/checkpoints. A missing cache fails instead of fetching.
export async function isolateVocals(audioPath, outDir, { timeoutMs = 600000, runImpl = run, probeImpl = probeAudioDuration } = {}) {
  if (!(await toolExists('venv/bin/demucs'))) throw fail('demucs not installed in the editing desk');
  await ensureDeskTmp();
  await mkdir(outDir, { recursive: true });
  const stem = basename(audioPath, extname(audioPath));
  await runImpl(join(deskRoot(), 'venv/bin/demucs'), ['-o', outDir, audioPath],
    { timeoutMs, env: deskEnv() });
  const vocals = join(outDir, 'htdemucs', stem, 'vocals.wav');
  if (!existsSync(vocals)) throw fail('demucs produced no vocals stem');
  const probe = await probeImpl(vocals);
  return { vocals, duration: probe.duration };
}

// --- 4. rembg: background-removed poster -----------------------------------
// CRITICAL: -m u2net ONLY. The 2.0.87 default model (bria-rmbg, ~1 GB)
// OOM-kills this 6 GB box during inference. Never use the default.
export async function removeBg(imagePath, outPath, { timeoutMs = 300000, runImpl = run } = {}) {
  if (!(await toolExists('venv/bin/rembg'))) throw fail('rembg not installed in the editing desk');
  await runImpl(join(deskRoot(), 'venv/bin/rembg'), ['i', '-m', 'u2net', imagePath, outPath],
    { timeoutMs, env: deskEnv() });
  if (!existsSync(outPath)) throw fail('rembg produced no output image');
  return { out: outPath };
}

// --- 5. Real-ESRGAN: upscale a poster --------------------------------------
// The inference script must NOT run from inside the repo: the repo copy of
// the `realesrgan` package shadows the installed one (no version.py) and
// the import fails. Copy the script to desk scratch and run it from there.
// Untiled inference OOM-kills this box on 1080x1920 input — always tile.
export async function upscaleImage(imagePath, outDir, { outscale = 2, tile = 400, timeoutMs = 600000, runImpl = run, probeImpl = ffprobe } = {}) {
  if (!(await toolExists('venv/bin/python'))) throw fail('editing-desk venv python not found');
  const weights = join(deskRoot(), 'weights/RealESRGAN_x4plus.pth');
  if (!existsSync(weights)) throw fail('Real-ESRGAN weights not found in the editing desk');
  await ensureDeskTmp();
  const scriptSrc = join(deskRoot(), 'repos/Real-ESRGAN/inference_realesrgan.py');
  if (!existsSync(scriptSrc)) throw fail('Real-ESRGAN inference script not found in the desk repo clone');
  const script = join(deskRoot(), '.tmp/inference_realesrgan.py');
  await copyFile(scriptSrc, script);
  await mkdir(outDir, { recursive: true });
  const before = await probeImpl(imagePath);
  await runImpl(join(deskRoot(), 'venv/bin/python'),
    [script, '-i', imagePath, '-o', outDir, '-n', 'RealESRGAN_x4plus',
     '--model_path', weights, '--outscale', String(outscale), '--fp32', '--tile', String(tile)],
    { timeoutMs, env: deskEnv(), cwd: deskRoot() });
  const out = join(outDir, `${basename(imagePath, extname(imagePath))}_out${extname(imagePath)}`);
  if (!existsSync(out)) throw fail('Real-ESRGAN produced no output image');
  const after = await probeImpl(out);
  return { out, inWidth: before.width, inHeight: before.height, outWidth: after.width, outHeight: after.height, outscale };
}

// --- 6. LosslessCut concept: ffmpeg stream-copy pre-trim -------------------
// The LosslessCut GUI cannot run headless, so the CONCEPT is wired: a fast
// lossless rough-cut with ffmpeg -c copy. Needs only ffmpeg, so it works
// wherever the app runs (including Render) — no desk dir required.
export async function losslessTrim(sourcePath, outPath, start, end, { timeoutMs = 300000, runImpl = run, probeImpl = ffprobe } = {}) {
  const before = await probeImpl(sourcePath);
  if (!(start >= 0) || !(end > start) || end > before.duration + 0.5) {
    throw fail(`trim range ${start}-${end}s is outside the source (${before.duration.toFixed(1)}s)`);
  }
  await runImpl('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-to', String(end),
    '-i', sourcePath, '-c', 'copy', outPath], { timeoutMs });
  if (!existsSync(outPath)) throw fail('lossless trim produced no output file');
  const after = await probeImpl(outPath);
  return { inDuration: before.duration, outDuration: after.duration };
}

// --- 7. hyperframes: portrait title card -----------------------------------
// Builds a 1080x1920 title card from the clip hook as a job deliverable
// (title-card.mp4). The CLI needs HYPERFRAMES_CACHE_DIR (its default
// ~/.cache is group-writable here and refused) and TMPDIR at desk scratch.
// KNOWN CAVEAT: in the 22 Nov smoke the title rendered right of centre in
// a 1920x1080 frame; the portrait render has the same risk — verify the
// frame before trusting the layout (see docs/editing-desk-wiring.md).
const HF_BIN = 'node-tools/node_modules/.bin/hyperframes';

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function titleCard(hook, outPath, { duration = 3, timeoutMs = 600000, runImpl = run, probeImpl = ffprobe } = {}) {
  if (!(await toolExists(HF_BIN))) throw fail('hyperframes CLI not installed in the editing desk');
  await ensureDeskTmp();
  const dir = dirname(outPath);
  const project = join(dir, 'titlecard');
  const bin = join(deskRoot(), HF_BIN);
  const env = deskEnv();
  await runImpl(bin, ['init', 'titlecard', '-e', 'blank', '--resolution', 'portrait',
    '--non-interactive', '--skip-skills'], { timeoutMs, env, cwd: dir });
  const htmlPath = join(project, 'index.html');
  if (!existsSync(htmlPath)) throw fail('hyperframes init produced no index.html');
  let html = await readFile(htmlPath, 'utf8');
  const text = htmlEscape((hook || 'WATCH THIS').toUpperCase().slice(0, 80));
  html = html.replace(/>Title</, `>${text}<`);
  // Centre the title inside the 80% title-safe box. The blank scaffold's
  // #title is a full-width left-aligned block — a long hook runs to the
  // frame edge (verified on a real portrait frame, 22 Nov 2026). The
  // /hyperframes skill contract wants key text inside 80% title-safe
  // (864px of 1080). Patch the #title rule when present; otherwise append
  // an override style block before </head>.
  const centreDecls = 'text-align: center; max-width: 864px; margin-left: auto; margin-right: auto;';
  if (/#title\s*{[^}]*}/.test(html)) {
    html = html.replace(/#title\s*{([^}]*)}/, (m, body) => `#title {${body} ${centreDecls}}`);
  } else if (html.includes('</head>')) {
    html = html.replace('</head>', `<style>#title{${centreDecls}}</style></head>`);
  }
  html = html.replaceAll('data-duration="10"', `data-duration="${duration}"`);
  html = html.replace('duration: function () { return 10; }', `duration: function () { return ${duration}; }`);
  await writeFile(htmlPath, html);
  await runImpl(bin, ['render', project, '-o', outPath, '-w', '1'],
    { timeoutMs, env });
  if (!existsSync(outPath)) throw fail('hyperframes render produced no output file');
  const probe = await probeImpl(outPath);
  if (probe.width !== 1080 || probe.height !== 1920) {
    throw fail(`title card is ${probe.width}x${probe.height}, not 1080x1920`);
  }
  return { out: outPath, duration: probe.duration, width: probe.width, height: probe.height };
}

// --- 8. chatterbox: DISABLED BY POLICY --------------------------------------
// The voiceover stage is intentionally unwired. Chatterbox weights (~1 GB)
// come only from HuggingFace, and Shu banned hf.co fetches on 22 Nov 2026
// ("Ab mat bejhna"). This function never spawns a process, never fetches,
// never asks for approval. It exists so callers have one honest place to
// check: voiceover is off until Shu approves the weights another way.
export function chatterboxVoiceover() {
  return {
    disabled: true,
    reason: 'Chatterbox voiceover is disabled — model weights (~1 GB) come only from HuggingFace, and Shu banned hf.co fetches (22 Nov 2026). No weights have been downloaded and no fetch is attempted.',
  };
}

// --- toolkit probes (GET /api/toolkit) --------------------------------------
export async function probeDeskTools() {
  const probes = [];
  const check = async (id, name, fn, disabledNote) => {
    if (!deskAvailable()) {
      probes.push({ id, name, version: null, status: 'not_connected', note: 'EDITING_DESK not set on this host — the stage skips here and the job runs as before.' });
      return;
    }
    try {
      const version = await fn();
      probes.push({ id, name, version: version || null, status: disabledNote ? 'not_connected' : 'connected', note: disabledNote || '' });
    } catch (e) {
      probes.push({ id, name, version: null, status: 'not_connected', note: e.message.slice(0, 140) });
    }
  };
  const ver = async (cmd, args, parse) => {
    const { stdout } = await run(cmd, args, { timeoutMs: 15000, env: deskEnv() });
    return parse ? parse(stdout) : (stdout || '').trim().split('\n')[0].trim() || null;
  };
  await check('auto-editor', 'auto-editor (silence cut)', async () =>
    ver(join(deskRoot(), 'venv/bin/auto-editor'), ['--version'], s => s.trim()));
  await check('deepfilter', 'DeepFilterNet (denoise)', async () =>
    ver(join(deskRoot(), 'deepfilternet/deep-filter'), ['--version'], s => s.trim()));
  await check('demucs', 'demucs (vocal isolation)', async () => {
    await run(join(deskRoot(), 'venv/bin/demucs'), ['--help'], { timeoutMs: 15000, env: deskEnv() });
    return null;
  });
  await check('rembg', 'rembg (bg removal, u2net)', async () =>
    ver(join(deskRoot(), 'venv/bin/python'), ['-c', 'import rembg; print(rembg.__version__)'], s => s.trim()));
  await check('realesrgan', 'Real-ESRGAN (upscale)', async () =>
    ver(join(deskRoot(), 'venv/bin/python'), ['-c', 'import realesrgan; print(realesrgan.__version__)'], s => s.trim()));
  await check('hyperframes', 'hyperframes (title cards)', async () =>
    ver(join(deskRoot(), HF_BIN), ['--version'], s => s.trim()));
  await check('chatterbox', 'Chatterbox voiceover', async () => {
    await run(join(deskRoot(), 'venv-chatterbox/bin/python'), ['-c', 'import chatterbox; print(chatterbox.__version__)'], { timeoutMs: 15000, env: deskEnv() });
    return '0.1.7';
  }, 'Installed, but voiceover is DISABLED — weights (~1 GB) come only from HuggingFace, which Shu banned on 22 Nov 2026. No fetch is attempted.');
  probes.push({
    id: 'losslesscut', name: 'LosslessCut (GUI)', version: '3.70.2', status: 'not_connected',
    note: 'Desktop Electron GUI — cannot run headless. The ffmpeg stream-copy pre-trim stage is wired instead.',
  });
  probes.push({
    id: 'davinci-resolve', name: 'DaVinci Resolve MCP', version: null, status: 'not_connected',
    note: 'EXCLUDED — DaVinci Resolve is a desktop app; the MCP server cannot control anything server-side.',
  });
  return probes;
}
