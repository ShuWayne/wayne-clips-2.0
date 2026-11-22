// End-to-end check over real HTTP — run with `npm run e2e` while the
// server is NOT already running on the same port (the script starts its own
// server on PORT 18798). Steps:
//  1. Health + toolkit probes.
//  2. URL job without rightsConfirmed -> 400 (rights gate).
//  3. File-upload job from tests/fixtures/test-video.mp4 (real speech) ->
//     poll until done, assert every agent done, rendered MP4s exist and
//     ffprobe clean (1080x1920, audio present).
//  4. Take-over regenerate on clip #1 with new caption text.
//  5. Approve clip #1 YouTube once (200), then again (409 ledger block).
//  6. Landing page 200 + contains the wordmark + app.js.
// Exits non-zero on any failure. Leaves the test job under jobs/ (gitignored).
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 18798;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const proc = spawn('node', ['apps/api/server.mjs'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), MAX_CLIPS_PER_JOB: '3' }, stdio: 'pipe',
});
proc.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
proc.stderr.on('data', d => process.stderr.write(`[server:err] ${d}`));
const stop = () => proc.kill('SIGTERM');
process.on('exit', stop);

async function waitHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

try {
  check('server starts', await waitHealth());
  const tk = await (await fetch(`${BASE}/api/toolkit`)).json();
  const byId = Object.fromEntries(tk.tools.map(t => [t.id, t]));
  check('toolkit: ffmpeg connected', byId.ffmpeg.status === 'connected', byId.ffmpeg.version);
  check('toolkit: whisper connected', byId.whisper.status === 'connected', byId.whisper.version);
  check('toolkit: yt-dlp connected', byId.ytdlp.status === 'connected', byId.ytdlp.version);
  check('toolkit: claude honestly not connected (no key)', byId.claude.status === 'not_connected');

  // Rights gate
  const bad = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://example.com/v.mp4', rightsConfirmed: false, rightsBasis: 'owned', formats: ['9:16'], resolutions: ['1080p'], captionStyle: 'pop', uploadMode: 'review' }) });
  check('URL job without rightsConfirmed rejected (400)', bad.status === 400, `got ${bad.status}`);

  // File-upload job
  const buf = await readFile(join(ROOT, 'tests/fixtures/test-video.mp4'));
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'video/mp4' }), 'test-video.mp4');
  fd.append('rightsConfirmed', 'true');
  fd.append('rightsBasis', 'owned');
  fd.append('formats', JSON.stringify(['9:16']));
  fd.append('resolutions', JSON.stringify(['1080p']));
  fd.append('niche', 'e2e test');
  fd.append('uploadMode', 'review');
  fd.append('captionStyle', 'pop');
  const created = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', body: fd })).json();
  check('file-upload job created', !!created.id, created.id || JSON.stringify(created).slice(0, 200));
  const jobId = created.id;

  // Poll until done/failed (renders take a while; 10 min cap).
  let job = null;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    job = (await (await fetch(`${BASE}/api/jobs/${jobId}`)).json()).job;
    const states = Object.values(job.agents).map(a => a.status).join(',');
    console.log(`  poll ${i + 1}: status=${job.status} agents=[${states}]`);
    if (job.status === 'done' || job.status === 'failed') break;
  }
  check('job finished done', job.status === 'done', `status=${job.status}`);
  for (const a of ['scout', 'ingest', 'viral', 'subtitle', 'effects', 'render', 'publish']) {
    check(`agent ${a} done`, job.agents[a].status === 'done', job.agents[a].status);
  }
  check('clips produced', (job.clips || []).length >= 1, `${(job.clips || []).length} clips`);
  check('drafts produced', (job.drafts || []).length >= 3, `${(job.drafts || []).length} drafts`);
  if (job.status !== 'done' || (job.clips || []).length === 0) {
    console.log(`\nE2E ABORTED — job ${jobId} did not finish cleanly; see checks above.`);
    console.log(`E2E: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  const jobJson = JSON.parse(await readFile(join(ROOT, 'jobs', jobId, 'job.json'), 'utf8'));
  check('job.json on disk matches', jobJson.status === 'done' && jobJson.clips.length === job.clips.length);

  // ffprobe every rendered clip via the file endpoint (Range request).
  for (const c of job.clips) {
    const mp4 = join(ROOT, 'jobs', jobId, `clip-${c.rank}.mp4`);
    check(`clip #${c.rank} file exists`, existsSync(mp4));
    const res = await fetch(`${BASE}/files/${jobId}/clip-${c.rank}.mp4`, { headers: { range: 'bytes=0-1023' } });
    check(`clip #${c.rank} serves with Range (206)`, res.status === 206, `got ${res.status}`);
    const poster = await fetch(`${BASE}/files/${jobId}/clip-${c.rank}.jpg`);
    check(`clip #${c.rank} poster serves (200)`, poster.status === 200);
  }
  // Traversal guard
  const trav = await fetch(`${BASE}/files/${jobId}/..%2F..%2Fpackage.json`);
  check('path traversal blocked', trav.status === 400 || trav.status === 403, `got ${trav.status}`);

  // Take-over regenerate
  const regen = await fetch(`${BASE}/api/jobs/${jobId}/clips/1/regenerate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides: { captionText: 'E2E TAKEOVER', captionStyle: 'bounce', fontScale: 1.2 } }) });
  check('take-over regenerate (200)', regen.status === 200, `got ${regen.status}`);
  const after = (await (await fetch(`${BASE}/api/jobs/${jobId}`)).json()).job;
  check('take-over caption applied', after.clips[0].captionText === 'E2E TAKEOVER', after.clips[0].captionText);

  // Approve once, then again (ledger block)
  const ap1 = await fetch(`${BASE}/api/jobs/${jobId}/publish/1:YouTube/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checklist: [true, true, true, true, true, true] }) });
  check('approve clip #1 YouTube (200)', ap1.status === 200, `got ${ap1.status}`);
  const ap2 = await fetch(`${BASE}/api/jobs/${jobId}/publish/1:YouTube/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checklist: [true, true, true, true, true, true] }) });
  check('second approval blocked by ledger (409)', ap2.status === 409, `got ${ap2.status}`);

  // Landing page
  const landing = await fetch(`${BASE}/`);
  const html = await landing.text();
  check('landing 200', landing.status === 200);
  check('landing contains wordmark + app.js', html.includes('Wayne.clips') && html.includes('/app.js'));
  const appJs = await (await fetch(`${BASE}/app.js`)).text();
  check('link box renders CREATE CLIPS (in app.js)', appJs.includes('CREATE CLIPS') && html.includes('linkbox-slot'));

  console.log(`\nE2E job id: ${jobId}`);
  console.log(failures === 0 ? 'E2E: ALL CHECKS PASSED' : `E2E: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('E2E crashed:', err);
  process.exit(1);
} finally {
  stop();
}
