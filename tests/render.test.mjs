import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClip, qaClip, reframeFilter } from '../agents/render.mjs';
import { ffprobe } from '../packages/shared/media.mjs';

const FIXTURE = new URL('./fixtures/test-video.mp4', import.meta.url).pathname;

function fakeJob(dir, clip) {
  return {
    id: 'test-job', dirAbs: dir,
    input: { resolutions: ['1080p'], formats: ['9:16'], captionStyle: 'pop' },
    agents: {
      ingest: { output: { sourceFile: 'source.mp4', probe: { width: 1280, height: 720, duration: 120 }, transcript: { words: [{ w: 'Hello ', start: 2.2, end: 2.6 }, { w: 'world. ', start: 2.6, end: 3.0 }] } } },
      effects: { output: { perClip: [{ rank: 1, effects: [{ id: 'grade-warm', draw: 'eq=brightness=0.03:saturation=1.15' }] }] } },
    },
    clips: [clip],
    events: [],
  };
}

test('reframe: 16:9 source uses blur-pad, keyframed uses animated crop', () => {
  const bp = reframeFilter(1280, 720, '1080p', 'blur-pad', { start: 0, end: 20 });
  assert.match(bp, /boxblur/);
  assert.match(bp, /overlay/);
  const kf = reframeFilter(1280, 720, '1080p', 'keyframed', { start: 0, end: 20, cropX0: 44.3, cropX1: 52.8 });
  assert.match(kf, /crop=405:720/); // 720 * 9/16 = 405
  assert.match(kf, /min\(t\//);
});

test('render produces a real 1080x1920 MP4 with audio; ffprobe confirms', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-render-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(FIXTURE, join(dir, 'source.mp4'));
  const clip = { start: 2, end: 9, hook: 'HELLO WORLD', rank: 1, captionStyle: 'pop', fontScale: 1 };
  const job = fakeJob(dir, clip);
  const { outFile, target, upscaled } = await renderClip(job, clip);
  assert.equal(target, '1080p');
  assert.equal(upscaled, 2.7); // 720p source -> 1920 tall is 2.7x upscale, flagged
  const probe = await ffprobe(outFile);
  assert.equal(probe.width, 1080);
  assert.equal(probe.height, 1920);
  assert.ok(Math.abs(probe.duration - 7) < 0.6, `duration ${probe.duration}`);
  assert.equal(probe.hasAudio, true);
  const qa = await qaClip(job, clip, outFile);
  assert.deepEqual(qa.problems, [], `QA problems: ${qa.problems.join('; ')}`);
});

test('4K from a 720p source is flagged upscaled, not real 4K detail', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-render4k-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(FIXTURE, join(dir, 'source.mp4'));
  const clip = { start: 2, end: 6, hook: 'HELLO WORLD', rank: 1, captionStyle: 'pop', fontScale: 1 };
  const job = fakeJob(dir, clip);
  job.input.resolutions = ['4K'];
  const { outFile, upscaled } = await renderClip(job, clip);
  assert.ok(upscaled > 1, `upscaled flag ${upscaled}`);
  const probe = await ffprobe(outFile);
  assert.equal(probe.width, 2160);
  assert.equal(probe.height, 3840);
});
