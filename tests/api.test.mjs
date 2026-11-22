import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
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
    // DAILY_UPLOAD_CAP raised: the approve test verifies approve-once-then-
    // 409, not the cap — and the shared ledger already holds today's
    // approvals from earlier suite/E2E runs (cap 10 would 429 the test).
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), MAX_CLIPS_PER_JOB: '1', DAILY_UPLOAD_CAP: '100' }, stdio: 'pipe',
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

test('API: Telegram updates + import validation (no real Telegram calls)', async (t) => {
  // No token in this server's env: updates reports unconfigured, import 503s.
  const proc = spawn('node', ['apps/api/server.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: '18798', MAX_CLIPS_PER_JOB: '1', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }, stdio: 'pipe',
  });
  t.after(() => { proc.kill('SIGTERM'); });
  const BASE2 = 'http://127.0.0.1:18798';
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE2}/api/health`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  const health = await (await fetch(`${BASE2}/api/health`)).json();
  assert.equal(health.services.telegram, false);
  const tk = await (await fetch(`${BASE2}/api/toolkit`)).json();
  assert.equal(tk.tools.find(x => x.id === 'telegram').status, 'not_connected');
  const upd = await (await fetch(`${BASE2}/api/telegram/updates`)).json();
  assert.equal(upd.configured, false);
  assert.deepEqual(upd.videos, []);
  assert.deepEqual(upd.channels, []);
  const noToken = await fetch(`${BASE2}/api/telegram/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: 'VID1' }) });
  assert.equal(noToken.status, 503);
  const noTokenSess = await fetch(`${BASE2}/api/telegram/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: 'auth_date=1&user=%7B%7D&hash=00' }) });
  assert.equal(noTokenSess.status, 503);
  proc.kill('SIGTERM');

  // With a (fake) token, import without fileId is a 400 before any Telegram call.
  const proc2 = spawn('node', ['apps/api/server.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: '18797', MAX_CLIPS_PER_JOB: '1', TELEGRAM_BOT_TOKEN: 'FAKE', TELEGRAM_CHAT_ID: '' }, stdio: 'pipe',
  });
  t.after(() => { proc2.kill('SIGTERM'); });
  const BASE3 = 'http://127.0.0.1:18797';
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE3}/api/health`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  const health3 = await (await fetch(`${BASE3}/api/health`)).json();
  assert.equal(health3.services.telegram, false); // no TELEGRAM_CHAT_ID, so not connected
  const noFile = await fetch(`${BASE3}/api/telegram/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(noFile.status, 400);
  assert.match((await noFile.json()).error, /fileId is required/);

  // Mini App session: valid initData (signed with the same fake token) mints
  // a session; tampered initData is rejected; no token at all is a 503.
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 777, username: 'shu', first_name: 'Shu' }), query_id: 'TESTQUERY' };
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('FAKE').digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  const initData = new URLSearchParams({ ...fields, hash }).toString();
  const sess = await fetch(`${BASE3}/api/telegram/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) });
  assert.equal(sess.status, 200, `session: ${await sess.clone().text()}`);
  const sessJson = await sess.json();
  assert.equal(sessJson.telegramUserId, '777');
  assert.equal(sessJson.username, 'shu');
  assert.match(sessJson.sessionToken, /^777\.\d+\.[0-9a-f]{64}$/);
  const bad = await fetch(`${BASE3}/api/telegram/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: initData.replace('shu', 'shx') }) });
  assert.equal(bad.status, 401);
  proc2.kill('SIGTERM');

  // A minted session token is accepted as API auth — but only a server with
  // API_TOKEN set can prove it (without one, requireAuth lets everyone in).
  // Import with the session Bearer reaches fileId validation (400); without
  // auth or with a garbage token it is 401. Note: /api/telegram/updates is
  // NOT used here — with a fake bot token it would really call Telegram.
  const proc3 = spawn('node', ['apps/api/server.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: '18796', MAX_CLIPS_PER_JOB: '1', API_TOKEN: 'TESTAPI', TELEGRAM_BOT_TOKEN: 'FAKE', TELEGRAM_CHAT_ID: '' }, stdio: 'pipe',
  });
  t.after(() => { proc3.kill('SIGTERM'); });
  const BASE4 = 'http://127.0.0.1:18796';
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE4}/api/health`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  const sess3Res = await fetch(`${BASE4}/api/telegram/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) });
  assert.equal(sess3Res.status, 200, `session on API_TOKEN server: ${await sess3Res.clone().text()}`);
  const sess3 = await sess3Res.json();
  assert.match(sess3.sessionToken, /^777\.\d+\.[0-9a-f]{64}$/);
  const authed = await fetch(`${BASE4}/api/telegram/import`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sess3.sessionToken}` }, body: JSON.stringify({}) });
  assert.equal(authed.status, 400, 'session Bearer must pass requireAuth and reach fileId validation');
  const noAuth = await fetch(`${BASE4}/api/telegram/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(noAuth.status, 401);
  const garbage = await fetch(`${BASE4}/api/telegram/import`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer garbage.token.here' }, body: JSON.stringify({}) });
  assert.equal(garbage.status, 401);
}, { timeout: 120000 });
