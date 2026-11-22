import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickMoments, sentencesFromTranscript, pickVisualMoments, runViral, detectScenes } from '../agents/viral.mjs';

const transcript = {
  segments: [{ text: 'Hello world. This is a test.', start: 0, end: 4, words: [
    { w: 'Hello ', start: 0, end: 0.4 }, { w: 'world. ', start: 0.4, end: 0.9 },
    { w: 'This ', start: 1, end: 1.3 }, { w: 'is ', start: 1.3, end: 1.5 },
    { w: 'a ', start: 1.5, end: 1.6 }, { w: 'test. ', start: 1.6, end: 2.0 },
  ] }],
  words: [
    { w: 'Hello ', start: 0, end: 0.4 }, { w: 'world. ', start: 0.4, end: 0.9 },
    { w: 'This ', start: 1, end: 1.3 }, { w: 'is ', start: 1.3, end: 1.5 },
    { w: 'a ', start: 1.5, end: 1.6 }, { w: 'test. ', start: 1.6, end: 2.0 },
  ],
};

test('sentences rebuild from the word stream on punctuation', () => {
  const s = sentencesFromTranscript(transcript);
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'Hello world.');
  assert.equal(s[0].start, 0);
  assert.equal(s[1].end, 2.0);
});

function fakeSentences(n, dur = 120) {
  return Array.from({ length: n }, (_, i) => ({
    text: i === 0 ? 'Nobody tells you this secret about growing fast.' : `Tip number ${i + 1} is to keep every clip short and punchy.`,
    start: i * 8, end: i * 8 + 6, words: [],
  }));
}

test('moments cut on sentence boundaries, 15-60s, scored', () => {
  const { moments } = pickMoments(fakeSentences(12), 120, { maxClips: 6 });
  assert.ok(moments.length >= 2 && moments.length <= 6);
  for (const m of moments) {
    assert.ok(m.end - m.start >= 8 && m.end - m.start <= 60, `clip length ${m.end - m.start}`);
    assert.ok(m.score >= 0 && m.score <= 1);
    assert.equal(m.spoilerRisk, false);
    assert.equal(m.leakRisk, false);
  }
});

test('spoiler/leak-flagged moments are dropped before storage — zero tolerated', () => {
  const s = fakeSentences(6);
  s[1].text = 'And the leaked ending shows who dies at the end.';
  s[2].text = 'Here is the embargoed unreleased footage.';
  const { moments, dropped } = pickMoments(s, 120, { maxClips: 6 });
  assert.equal(dropped, 2);
  assert.ok(!moments.some(m => /leak|ending|dies/i.test(m.hook)));
});

test('top-scored anchor wins the hook', () => {
  const { moments } = pickMoments(fakeSentences(8), 120, { maxClips: 6 });
  assert.ok(moments[0].hook.toLowerCase().includes('nobody') || moments[0].score >= 0.5);
});

// --- Visual fallback: speechless videos cut on scene changes, not failed. ---

test('pickVisualMoments cuts 15-60s windows on scene changes, scored by density', () => {
  const { moments } = pickVisualMoments([18, 22, 26, 50, 90], 120, { maxClips: 6, niche: 'kitten' });
  assert.ok(moments.length >= 2 && moments.length <= 6);
  for (const m of moments) {
    assert.ok(m.end - m.start >= 8 && m.end - m.start <= 60, `clip length ${m.end - m.start}`);
    assert.ok(m.score >= 0 && m.score <= 1);
    assert.equal(m.hook, 'KITTEN');
    assert.equal(m.spoilerRisk, false);
  }
  // The burst window (18-26s, 3 cuts) scores highest.
  assert.equal(moments[0].start, 18);
});

test('pickVisualMoments falls back to fixed 30s windows when the picture never changes', () => {
  const { moments } = pickVisualMoments([], 65, { maxClips: 6, niche: 'kitten' });
  assert.equal(moments.length, 2);
  assert.deepEqual([moments[0].start, moments[0].end], [0, 30]);
  assert.equal(moments[1].end, 60);
  assert.equal(moments[0].score, 0.35);
});

test('pickVisualMoments refuses videos under 8s — too short to cut without speech', () => {
  const { moments, reason } = pickVisualMoments([], 3, { maxClips: 6, niche: 'kitten' });
  assert.equal(moments.length, 0);
  assert.equal(reason, 'too-short');
});

test('pickVisualMoments drops a spoiler-flagged niche hook — zero tolerated', () => {
  const { moments, dropped } = pickVisualMoments([], 30, { maxClips: 6, niche: 'leaked ending' });
  assert.equal(moments.length, 0);
  assert.equal(dropped, 1);
});

function visualJob(dir, duration, niche = 'kitten') {
  return {
    id: '33333333-4444-5555-6666-777777777777', dirAbs: dir, events: [],
    input: { niche },
    agents: {
      ingest: { status: 'done', attempts: 1, output: { transcriptEmpty: true, probe: { duration }, sourcePath: join(dir, 'source.mp4') }, error: null, lastLine: '' },
      viral: { status: 'pending', attempts: 0, output: null, error: null, lastLine: '' },
    },
  };
}

test('runViral on a speechless video picks visual moments instead of failing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-viral-visual-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const job = visualJob(dir, 60);
  const out = await runViral(job, { emit: () => {} }, { detectScenesImpl: async () => [18, 22, 40] });
  assert.equal(out.engine, 'visual');
  assert.ok(out.moments.length >= 1);
  assert.equal(job.agents.viral.status, 'done');
});

test('runViral on a 3s speechless video fails deterministically (fail fast, no retries)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-viral-short-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const job = visualJob(dir, 3);
  await assert.rejects(runViral(job, { emit: () => {} }, { detectScenesImpl: async () => [] }), (err) => {
    assert.equal(err.deterministic, true);
    assert.match(err.message, /too short/);
    return true;
  });
  assert.equal(job.agents.viral.status, 'failed');
});

test('detectScenes returns [] instead of throwing when ffmpeg fails', async () => {
  const scenes = await detectScenes('/tmp/does-not-exist.mp4');
  assert.deepEqual(scenes, []);
});
