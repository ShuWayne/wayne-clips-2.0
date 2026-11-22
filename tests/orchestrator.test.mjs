import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { newJob } from '../packages/shared/job.mjs';
import { run } from '../packages/orchestrator/run.mjs';
import { ffprobe } from '../packages/shared/media.mjs';

const FIXTURE = new URL('./fixtures/test-video.mp4', import.meta.url).pathname;

test('orchestrator runs all seven agents in order on a real file and persists job.json', async (t) => {
  process.env.MAX_CLIPS_PER_JOB = '2';
  const jobsRoot = await mkdtemp(join(tmpdir(), 'wc-orch-jobs-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'wc-orch-data-'));
  t.after(() => { rm(jobsRoot, { recursive: true, force: true }); rm(dataRoot, { recursive: true, force: true }); });
  const job = newJob({ sourceUrl: null, sourceFile: 'source.mp4', rightsConfirmed: true, rightsBasis: 'owned', formats: ['9:16'], resolutions: ['1080p'], niche: 'test', uploadMode: 'review', captionStyle: 'pop' }, jobsRoot);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(job.dirAbs, { recursive: true });
  await copyFile(FIXTURE, join(job.dirAbs, 'source.mp4'));
  const events = [];
  await run(job, { emit: e => events.push(e), ctx: { dataRoot, jobsRoot, licences: [] } });
  assert.equal(job.status, 'done');
  for (const a of ['scout', 'ingest', 'viral', 'subtitle', 'effects', 'render', 'publish']) {
    assert.equal(job.agents[a].status, 'done', `agent ${a} status ${job.agents[a].status}: ${job.agents[a].error || ''}`);
  }
  assert.ok(job.clips.length >= 1 && job.clips.length <= 2);
  assert.ok(job.drafts.length >= 3);
  // Events arrive in agent order.
  const firsts = [];
  for (const e of events) if (e.type === 'status' && e.status === 'running' && !firsts.includes(e.agent)) firsts.push(e.agent);
  assert.deepEqual(firsts, ['scout', 'ingest', 'viral', 'subtitle', 'effects', 'render', 'publish']);
  // job.json on disk matches the in-memory record.
  const onDisk = JSON.parse(await readFile(join(job.dirAbs, 'job.json'), 'utf8'));
  assert.equal(onDisk.status, 'done');
  assert.equal(onDisk.clips.length, job.clips.length);
  // Rendered files exist and probe clean.
  for (const c of job.clips) {
    const f = join(job.dirAbs, `clip-${c.rank}.mp4`);
    assert.ok(existsSync(f), `clip file ${f} exists`);
    const p = await ffprobe(f);
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
    assert.equal(p.hasAudio, true);
    assert.ok(existsSync(join(job.dirAbs, `clip-${c.rank}.jpg`)), 'poster exists');
    assert.ok(existsSync(join(job.dirAbs, `clip-${c.rank}-sheet.jpg`)), 'contact sheet exists');
  }
});

test('orchestrator completes a speechless video via visual moments (no voiceover needed)', async (t) => {
  const jobsRoot = await mkdtemp(join(tmpdir(), 'wc-orch-tone-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'wc-orch-tone-data-'));
  t.after(() => { rm(jobsRoot, { recursive: true, force: true }); rm(dataRoot, { recursive: true, force: true }); });
  const job = newJob({ sourceUrl: null, sourceFile: 'source.mp4', rightsConfirmed: true, rightsBasis: 'owned', formats: ['9:16'], resolutions: ['1080p'], niche: 'test', uploadMode: 'review', captionStyle: 'pop' }, jobsRoot);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(job.dirAbs, { recursive: true });
  await copyFile(new URL('./fixtures/tone-video.mp4', import.meta.url).pathname, join(job.dirAbs, 'source.mp4'));
  await run(job, { emit: () => {}, ctx: { dataRoot, jobsRoot, licences: [] } });
  assert.equal(job.status, 'done', `job failed: ${job.agents.viral.error || ''}`);
  assert.equal(job.agents.viral.status, 'done');
  assert.equal(job.agents.viral.output.engine, 'visual');
  assert.ok(job.clips.length >= 1);
  assert.ok(job.drafts.length >= 3);
  // The visual clip actually rendered — 1080x1920 with the hook burned in.
  const f = join(job.dirAbs, 'clip-1.mp4');
  assert.ok(existsSync(f), 'clip file exists');
  const p = await ffprobe(f);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
});

test('orchestrator fails fast (1 attempt, not 3) on a deterministic viral error', async (t) => {
  const jobsRoot = await mkdtemp(join(tmpdir(), 'wc-orch-short-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'wc-orch-short-data-'));
  t.after(() => { rm(jobsRoot, { recursive: true, force: true }); rm(dataRoot, { recursive: true, force: true }); });
  const job = newJob({ sourceUrl: null, sourceFile: 'source.mp4', rightsConfirmed: true, rightsBasis: 'owned', formats: ['9:16'], resolutions: ['1080p'], niche: 'test', uploadMode: 'review', captionStyle: 'pop' }, jobsRoot);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(job.dirAbs, { recursive: true });
  // 3s silent video: too short to cut without speech — a deterministic error.
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:d=3',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
    join(job.dirAbs, 'source.mp4'),
  ], (err) => err ? reject(err) : resolve()));
  await run(job, { emit: () => {}, ctx: { dataRoot, jobsRoot, licences: [] } });
  assert.equal(job.status, 'failed');
  assert.equal(job.agents.viral.status, 'failed');
  assert.equal(job.agents.viral.attempts, 1, 'deterministic errors must not be retried');
  assert.match(job.agents.viral.error || '', /too short/);
});
