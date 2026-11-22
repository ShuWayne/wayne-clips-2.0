import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
}

test('API: health, toolkit, rights rejection, pages CRUD, approve ledger', async (t) => {
  const proc = spawn('node', ['apps/api/server.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), MAX_CLIPS_PER_JOB: '1' }, stdio: 'pipe',
  });
  let serverLog = '';
  proc.stdout.on('data', d => { serverLog += d; });
  proc.stderr.on('data', d => { serverLog += d; });
  t.after(() => { proc.kill('SIGTERM'); });
  await waitForHealth();

  // Health
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.status, 'ok');

  // Toolkit probes real tools
  const tk = await (await fetch(`${BASE}/api/toolkit`)).json();
  const byId = Object.fromEntries(tk.tools.map(x => [x.id, x]));
  assert.equal(byId.ffmpeg.status, 'connected');
  assert.match(byId.ffmpeg.version, /^\d+\./);
  assert.equal(byId.whisper.status, 'connected');
  assert.equal(byId.ytdlp.status, 'connected');
  assert.equal(byId.claude.status, 'not_connected'); // no key in this env

  // Rights: URL job without rightsConfirmed is rejected with 400
  const bad = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://example.com/v.mp4', rightsConfirmed: false, rightsBasis: 'owned', formats: ['9:16'], resolutions: ['1080p'], captionStyle: 'pop', uploadMode: 'review' }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /rights confirmation/);

  // Pages CRUD
  const created = await (await fetch(`${BASE}/api/pages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ angle: '60-second study tips', niche: 'study', handle: '@study60' }) })).json();
  assert.equal(created.ok, true);
  const pages = await (await fetch(`${BASE}/api/pages`)).json();
  assert.ok(pages.pages.some(p => p.id === created.page.id));
  await fetch(`${BASE}/api/pages/${created.page.id}`, { method: 'DELETE' });
  const pages2 = await (await fetch(`${BASE}/api/pages`)).json();
  assert.ok(!pages2.pages.some(p => p.id === created.page.id));

  // Approve ledger: seed a done job dir, approve twice via the API.
  // Fresh UUID each run — the ledger persists on disk, so a fixed id
  // would make the first approve 409 on the second suite run.
  const jobId = randomUUID();
  const dir = join(ROOT, 'jobs', jobId);
  await mkdir(dir, { recursive: true });
  const draft = { rank: 1, platform: 'YouTube', title: 'Test clip', caption: 'hello world — cut by Wayne.clips.', hashtags: ['#shorts'], status: 'draft' };
  const job = {
    id: jobId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'done',
    input: { sourceUrl: null, sourceFile: 'source.mp4', rightsConfirmed: true, rightsBasis: 'owned', formats: ['9:16'], resolutions: ['1080p'], niche: 'test', uploadMode: 'review', pageId: null, licenceId: null, captionStyle: 'pop' },
    agents: {}, events: [], clips: [{ rank: 1, start: 0, end: 15, hook: 'HELLO', score: 0.9, captionText: 'HELLO', captionStyle: 'pop', fontScale: 1 }],
    drafts: [draft], dir: `jobs/${jobId}`,
  };
  await writeFile(join(dir, 'job.json'), JSON.stringify(job, null, 2));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await fetch(`${BASE}/api/jobs/${jobId}/publish/1:YouTube/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checklist: [true, true, true, true, true, true] }) });
  assert.equal(first.status, 200, `first approve: ${await first.text()}`);
  const second = await fetch(`${BASE}/api/jobs/${jobId}/publish/1:YouTube/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checklist: [true, true, true, true, true, true] }) });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /Ledger|already approved/);

  // Landing page serves 200
  const landing = await fetch(`${BASE}/`);
  assert.equal(landing.status, 200);
  const html = await landing.text();
  assert.match(html, /Wayne\.clips/);
  assert.match(html, /app\.js/);
}, { timeout: 120000 });
