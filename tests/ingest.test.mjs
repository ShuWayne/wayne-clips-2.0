import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIngest } from '../agents/ingest.mjs';

const TONE = new URL('./fixtures/tone-video.mp4', import.meta.url).pathname;
const SPEECH = new URL('./fixtures/test-video.mp4', import.meta.url).pathname;

function jobFor(dir, file) {
  return {
    id: 'test-ingest', dirAbs: dir, events: [],
    input: { sourceFile: file, rightsConfirmed: true, rightsBasis: 'owned' },
    agents: { ingest: { status: 'pending', attempts: 0, output: null, error: null, lastLine: '' } },
  };
}

test('ingest probes a local file and transcribes real speech with faster-whisper', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-ingest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(SPEECH, join(dir, 'source.mp4'));
  const job = jobFor(dir, 'source.mp4');
  const out = await runIngest(job, { emit: () => {} });
  assert.equal(out.probe.width, 1280);
  assert.equal(out.probe.height, 720);
  assert.ok(out.probe.duration > 100);
  assert.equal(out.transcriptEmpty, false);
  assert.ok((out.transcript.words || []).length > 100, `words: ${(out.transcript.words || []).length}`);
  assert.equal(out.transcript.engine, 'faster-whisper');
});

test('ingest on a tone-only video reports an empty transcript — voiceover needed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-ingest-tone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(TONE, join(dir, 'source.mp4'));
  const job = jobFor(dir, 'source.mp4');
  const out = await runIngest(job, { emit: () => {} });
  assert.equal(out.transcriptEmpty, true);
  assert.deepEqual(out.transcript.words, []);
});
