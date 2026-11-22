// Editing-desk wiring tests. Unit tests use a fake desk dir (stub binaries
// + stubbed run/probe) and never spawn the real tools. Integration tests
// run the REAL tools but only when EDITING_DESK points at a real desk —
// run them with: EDITING_DESK=$HOME/workspace/editing-desk npm test -- tests/editing-desk.test.mjs
// Plain `npm test` skips the integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  deskRoot, deskAvailable, deskEnv, stageEnabled, chatterboxVoiceover,
  silenceCut, denoiseWav, isolateVocals, removeBg, upscaleImage,
  losslessTrim, titleCard, DESK_STAGES,
} from '../agents/editing-desk.mjs';
import { buildAss, checkAssSafeArea, CAPTION_STYLES } from '../agents/subtitle.mjs';
import { ffprobe, run } from '../packages/shared/media.mjs';

const REAL_DESK = process.env.EDITING_DESK || '';
const realDeskAvailable = !!REAL_DESK && existsSync(REAL_DESK);

// --- fake desk dir (unit tests) -------------------------------------------
let fakeDesk = null;
async function makeFakeDesk() {
  if (fakeDesk) return fakeDesk;
  fakeDesk = await mkdtemp(join(tmpdir(), 'fake-desk-'));
  for (const rel of ['venv/bin/auto-editor', 'venv/bin/demucs', 'venv/bin/rembg', 'venv/bin/python', 'deepfilternet/deep-filter', 'node-tools/node_modules/.bin/hyperframes', 'venv-chatterbox/bin/python']) {
    const p = join(fakeDesk, rel);
    await mkdir(join(fakeDesk, rel.split('/').slice(0, -1).join('/')), { recursive: true }).catch(() => {});
    await writeFile(p, '#!/bin/sh\nexit 0\n');
    await chmod(p, 0o755);
  }
  await mkdir(join(fakeDesk, 'repos/DeepFilterNet/models'), { recursive: true });
  await writeFile(join(fakeDesk, 'repos/DeepFilterNet/models/DeepFilterNet3_onnx.tar.gz'), 'fake-model');
  await mkdir(join(fakeDesk, 'repos/Real-ESRGAN'), { recursive: true });
  await writeFile(join(fakeDesk, 'repos/Real-ESRGAN/inference_realesrgan.py'), '# fake inference script\n');
  await mkdir(join(fakeDesk, 'weights'), { recursive: true });
  await writeFile(join(fakeDesk, 'weights/RealESRGAN_x4plus.pth'), 'fake-weights');
  await mkdir(join(fakeDesk, '.tmp'), { recursive: true });
  return fakeDesk;
}

async function withFakeDesk(fn) {
  const prev = process.env.EDITING_DESK;
  const dir = await makeFakeDesk();
  process.env.EDITING_DESK = dir;
  try { return await fn(dir); }
  finally {
    if (prev === undefined) delete process.env.EDITING_DESK;
    else process.env.EDITING_DESK = prev;
  }
}

function stubRunFactory(calls, { createFiles = [] } = {}) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    for (const f of createFiles) await writeFile(f, 'x').catch(() => {});
    return { stdout: '', stderr: '' };
  };
}
const probe = (duration, extra = {}) => async () => ({ duration, width: 1080, height: 1920, hasAudio: true, ...extra });

// --- gating ---------------------------------------------------------------
test('deskRoot is null and deskAvailable false without EDITING_DESK', () => {
  const prev = process.env.EDITING_DESK;
  delete process.env.EDITING_DESK;
  try {
    assert.equal(deskRoot(), null);
    assert.equal(deskAvailable(), false);
  } finally {
    if (prev !== undefined) process.env.EDITING_DESK = prev;
  }
});

test('stageEnabled reads job.input.desk only', () => {
  assert.equal(stageEnabled({ input: { desk: { denoise: true } } }, 'denoise'), true);
  assert.equal(stageEnabled({ input: { desk: { denoise: false } } }, 'denoise'), false);
  assert.equal(stageEnabled({ input: {} }, 'denoise'), false);
  assert.equal(stageEnabled({}, 'denoise'), false);
});

test('deskEnv never points at hf.co and forces offline model use', async () => {
  await withFakeDesk((dir) => {
    const env = deskEnv();
    assert.equal(env.HF_HUB_OFFLINE, '1');
    assert.equal(env.TRANSFORMERS_OFFLINE, '1');
    assert.equal(env.TMPDIR, join(dir, '.tmp'));
    assert.equal(env.OMP_NUM_THREADS, '1');
    // Only the keys the desk itself sets are asserted — the inherited
    // process env carries runtime metadata (e.g. JARVIS_TRACE_CONTEXT)
    // that may mention hf.co in conversation text; the desk never adds
    // a fetch destination.
    for (const k of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'TMPDIR', 'HYPERFRAMES_CACHE_DIR']) {
      assert.ok(!String(env[k]).includes('huggingface'), `${k} must not point at HuggingFace`);
      assert.ok(!String(env[k]).includes('hf.co'), `${k} must not point at hf.co`);
    }
    return null;
  });
});

test('chatterbox voiceover is disabled and never fetches', () => {
  const r = chatterboxVoiceover();
  assert.equal(r.disabled, true);
  assert.match(r.reason, /HuggingFace/);
});

// --- argv tests (stubbed run) ---------------------------------------------
test('rembg always uses -m u2net, never the default bria-rmbg model', async () => {
  await withFakeDesk(async (dir) => {
    const calls = [];
    const out = join(dir, 'nobg.png');
    await removeBg(join(dir, 'in.jpg'), out, { runImpl: stubRunFactory(calls, { createFiles: [out] }) });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('u2net'), 'u2net model');
    assert.ok(!calls[0].args.join(' ').includes('bria-rmbg'), 'bria-rmbg must never appear');
    assert.equal(calls[0].args[0], 'i');
  });
});

test('silenceCut uses auto-editor audio edit and rejects >40% removal', async () => {
  await withFakeDesk(async (dir) => {
    const calls = [];
    const out = join(dir, 'cut.mp4');
    const r = await silenceCut(join(dir, 'src.mp4'), out, {
      runImpl: stubRunFactory(calls, { createFiles: [out] }),
      probeImpl: async (p) => ({ duration: p === out ? 80 : 100, hasAudio: true }),
    });
    assert.ok(calls[0].args.includes('audio'));
    assert.ok(calls[0].args.includes('--margin'));
    assert.equal(r.outDuration, 80);
    // 100s -> 50s is a 50% cut: must throw, never silently accept.
    await assert.rejects(() => silenceCut(join(dir, 'src.mp4'), out, {
      runImpl: stubRunFactory([], { createFiles: [out] }),
      probeImpl: async (p) => ({ duration: p === out ? 50 : 100, hasAudio: true }),
    }), /too much/);
  });
});

test('denoise passes the model path and -o as a directory', async () => {
  await withFakeDesk(async (dir) => {
    const calls = [];
    const outDir = join(dir, 'df-out');
    await mkdir(outDir, { recursive: true });
    const out = join(outDir, 'audio.wav');
    await denoiseWav(join(dir, 'audio.wav'), outDir, {
      runImpl: stubRunFactory(calls, { createFiles: [out] }),
      probeImpl: probe(6),
    });
    const args = calls[0].args;
    assert.ok(args.includes('-o') && args[args.indexOf('-o') + 1] === outDir, '-o is the output directory');
    assert.ok(args.some(a => a.includes('DeepFilterNet3_onnx.tar.gz')), 'local model path');
  });
});

test('demucs runs offline (cached model only) and returns the vocals stem path', async () => {
  await withFakeDesk(async (dir) => {
    const calls = [];
    const outDir = join(dir, 'demucs-out');
    const vocals = join(outDir, 'htdemucs', 'clip-1-audio', 'vocals.wav');
    await mkdir(join(outDir, 'htdemucs', 'clip-1-audio'), { recursive: true });
    const r = await isolateVocals(join(dir, 'clip-1-audio.wav'), outDir, {
      runImpl: stubRunFactory(calls, { createFiles: [vocals] }),
      probeImpl: probe(15),
    });
    assert.equal(calls[0].opts.env.HF_HUB_OFFLINE, '1');
    assert.equal(r.vocals, vocals);
  });
});

test('upscaleImage tiles (never untiled) and runs the script outside the repo', async () => {
  await withFakeDesk(async (dir) => {
    const calls = [];
    const outDir = join(dir, 'esrgan-out');
    await mkdir(outDir, { recursive: true });
    const out = join(outDir, 'clip-1_out.jpg');
    const r = await upscaleImage(join(dir, 'clip-1.jpg'), outDir, {
      outscale: 2,
      runImpl: stubRunFactory(calls, { createFiles: [out] }),
      probeImpl: async (p) => (p === out
        ? { width: 2160, height: 3840, duration: 0 }
        : { width: 1080, height: 1920, duration: 0 }),
    });
    const args = calls[0].args;
    assert.ok(args.includes('--tile') && args[args.indexOf('--tile') + 1] === '400', 'tiled inference');
    assert.ok(args.includes('--outscale') && args[args.indexOf('--outscale') + 1] === '2');
    assert.ok(!calls[0].cmd.includes('repos/Real-ESRGAN'), 'script copy must not run from inside the repo');
    assert.equal(r.outWidth, 2160);
  });
});

test('losslessTrim is a stream copy with -ss/-to and rejects bad ranges', async () => {
  await withFakeDesk(async (dir) => {
    const calls = [];
    const out = join(dir, 'trimmed.mp4');
    const r = await losslessTrim(join(dir, 'src.mp4'), out, 10, 40, {
      runImpl: stubRunFactory(calls, { createFiles: [out] }),
      probeImpl: async (p) => ({ duration: p === out ? 30 : 120, hasAudio: true }),
    });
    assert.deepEqual(calls[0].args.slice(0, 8), ['-y', '-v', 'error', '-ss', '10', '-to', '40', '-i']);
    assert.ok(calls[0].args.includes('-c') && calls[0].args.includes('copy'));
    assert.equal(r.outDuration, 30);
    await assert.rejects(() => losslessTrim(join(dir, 'src.mp4'), out, 50, 40, {
      runImpl: stubRunFactory([]),
      probeImpl: probe(120),
    }), /outside the source/);
  });
});

test('titleCard scaffolds portrait and escapes the hook text', async () => {
  await withFakeDesk(async (dir) => {
    const calls = [];
    const jobDir = join(dir, 'job1');
    await mkdir(jobDir, { recursive: true });
    const out = join(jobDir, 'title-card.mp4');
    const runImpl = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (args[0] === 'init') {
        const proj = join(jobDir, 'titlecard');
        await mkdir(proj, { recursive: true });
        await writeFile(join(proj, 'index.html'), '<html><head><style>#title { color: #fff; font-size: 72px; }</style></head><body><div data-duration="10"><h1 id="title">Title</h1></div><script>duration: function () { return 10; }</script></body></html>');
      }
      if (args[0] === 'render') await writeFile(out, 'x');
      return { stdout: '', stderr: '' };
    };
    await titleCard('A <B> & "C"', out, {
      runImpl,
      probeImpl: async () => ({ width: 1080, height: 1920, duration: 3 }),
    });
    const init = calls.find(c => c.args[0] === 'init');
    assert.ok(init.args.includes('portrait'), 'portrait resolution');
    const html = await readFile(join(jobDir, 'titlecard', 'index.html'), 'utf8');
    assert.ok(html.includes('A &lt;B&gt; &amp; &quot;C&quot;'), 'hook is HTML-escaped');
    assert.ok(html.includes('data-duration="3"'), '3s duration');
    assert.ok(!html.includes('>Title<'), 'template title replaced');
    assert.ok(html.includes('text-align: center'), 'title is centred (scaffold left-aligns it)');
    assert.ok(html.includes('max-width: 864px'), 'title stays inside the 80% title-safe box');
  });
});

// --- word-pop captions ------------------------------------------------------
test('wordpop is a caption style: sentence stays, spoken word pops highlighted', () => {
  assert.ok(CAPTION_STYLES.includes('wordpop'));
  const clip = { start: 10, end: 30, hook: 'THIS CHANGES EVERYTHING', rank: 1 };
  const words = [
    { w: 'This ', start: 10.2, end: 10.6 }, { w: 'changes ', start: 10.6, end: 11.1 },
    { w: 'everything. ', start: 11.1, end: 11.8 },
  ];
  const ass = buildAss(clip, words, { style: 'wordpop', fontScale: 1 });
  assert.match(ass, /PlayResX: 1080/);
  // One event per word, each showing the whole sentence with the active
  // word in the highlight style.
  assert.match(ass, /\\rCapHi\\fs84\}CHANGES\{\\r\}/);
  assert.match(ass, /THIS.*CHANGES.*EVERYTHING/);
  assert.deepEqual(checkAssSafeArea(ass), []);
});

// --- integration (real tools, gated) ----------------------------------------
const skipIntegration = !realDeskAvailable;
// Integration scratch lives under the desk's own .tmp (big disk), never
// /tmp — hyperframes refuses to render into the 512 MB tmpfs.
async function intDir() {
  const root = join(REAL_DESK, '.tmp', 'int-tests');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'desk-int-'));
}
test('integration: denoise a real wav with DeepFilterNet', { skip: skipIntegration }, async (t) => {
  const dir = await intDir();
  const wav = join(dir, 'test.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=6', '-filter_complex', 'amix=inputs=2:duration=first', '-ar', '16000', '-ac', '1', wav]);
  const { denoiseWav: dw } = await import('../agents/editing-desk.mjs');
  const r = await dw(wav, join(dir, 'df-out'));
  assert.ok(Math.abs(r.duration - 6) < 0.5, `denoised duration ~6s, got ${r.duration}`);
});

test('integration: rembg u2net removes a background for real', { skip: skipIntegration }, async (t) => {
  const dir = await intDir();
  const png = join(dir, 'test.png');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=256x256:d=1', '-frames:v', '1', png]);
  const { removeBg: rb } = await import('../agents/editing-desk.mjs');
  const out = join(dir, 'nobg.png');
  await rb(png, out);
  const probe = await ffprobe(out);
  assert.equal(probe.width, 256);
});

test('integration: auto-editor silence-cuts the tone fixture', { skip: skipIntegration }, async (t) => {
  const dir = await intDir();
  const out = join(dir, 'cut.mp4');
  const { silenceCut: sc } = await import('../agents/editing-desk.mjs');
  const r = await sc('tests/fixtures/tone-video.mp4', out);
  assert.ok(r.outDuration > 0 && r.outDuration <= r.inDuration);
  assert.ok(r.outDuration >= r.inDuration * 0.6, 'kept at least 60%');
});

test('integration: demucs separates a 6s wav into stems', { skip: skipIntegration }, async (t) => {
  const dir = await intDir();
  const wav = join(dir, 'test.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-filter_complex', 'amix=inputs=2:duration=first', '-ar', '44100', '-ac', '2', wav]);
  const { isolateVocals: iv } = await import('../agents/editing-desk.mjs');
  const r = await iv(wav, join(dir, 'demucs-out'));
  assert.ok(Math.abs(r.duration - 6) < 0.5, `vocals stem ~6s, got ${r.duration}`);
});

test('integration: hyperframes renders a 3s portrait title card', { skip: skipIntegration }, async (t) => {
  const dir = await intDir();
  const out = join(dir, 'title-card.mp4');
  const { titleCard: tc } = await import('../agents/editing-desk.mjs');
  const r = await tc('TEST HOOK', out);
  assert.equal(r.width, 1080);
  assert.equal(r.height, 1920);
  assert.ok(Math.abs(r.duration - 3) < 0.5, `title card ~3s, got ${r.duration}`);
});

test('integration: Real-ESRGAN upscales a small image 2x (tiled)', { skip: skipIntegration }, async (t) => {
  const dir = await intDir();
  const png = join(dir, 'small.png');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=256x256:d=1', '-frames:v', '1', png]);
  const { upscaleImage: ui } = await import('../agents/editing-desk.mjs');
  const r = await ui(png, dir, { outscale: 2 });
  assert.equal(r.outWidth, 512);
  assert.equal(r.outHeight, 512);
});
