// Wayne.clips API — Node 22 ESM, zero npm dependencies.
// REST + SSE (with polling fallback on the client), static frontend,
// multipart file upload, Range file serving with a path-traversal guard.
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { newJob, loadJob, saveJob, logEvent, AGENT_IDS, AGENT_NAMES, AGENT_ROLES } from '../../packages/shared/job.mjs';
import { validateJobInput } from '../../agents/guard.mjs';
import { run as runOrchestrator, regenerateClip } from '../../packages/orchestrator/run.mjs';
import { runScout } from '../../agents/scout.mjs';
import { approvePublish } from '../../agents/publish.mjs';
import { listTelegramUpdates, downloadTelegramFile, restoreJobsFromTelegram } from '../../agents/telegram.mjs';
import { validateInitData, createSessionToken, verifySessionToken } from '../../agents/telegram-auth.mjs';
import { r2Config, mirrorPut, restoreJobs } from '../../packages/shared/store.mjs';
import { run as mediaRun } from '../../packages/shared/media.mjs';
import { probeDeskTools } from '../../agents/editing-desk.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_ROOT = join(ROOT, 'apps/web');
const JOBS_ROOT = join(ROOT, 'jobs');
const DATA_ROOT = join(ROOT, 'data');
const CONFIG_ROOT = join(ROOT, 'config');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = 500 * 1024 * 1024;

// --- tiny data stores (JSON files, survive restarts) ---
async function readStore(name, fallback) {
  try { return JSON.parse(await readFile(join(DATA_ROOT, name), 'utf8')); }
  catch { return fallback; }
}
async function writeStore(name, data) {
  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(join(DATA_ROOT, name), JSON.stringify(data, null, 2));
  // Best-effort mirror to external storage — never fails the request.
  try {
    const cfg = r2Config(process.env);
    if (cfg) await mirrorPut({ config: cfg, key: `data/${name}`, body: JSON.stringify(data, null, 2), contentType: 'application/json', timeoutMs: 5000 });
  } catch (e) { console.error(`[store] data/${name} mirror failed:`, e.message); }
}
async function getLicences() { return readStore('licences.json', []); }
async function getPages() { return readStore('pages.json', []); }
async function getCampaigns() { return readStore('campaigns.json', []); }

// --- SSE subscribers: jobId -> Set<res> ---
const subscribers = new Map();
function emitTo(jobId, payload) {
  const set = subscribers.get(jobId);
  if (!set) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...set]) { try { res.write(line); } catch { set.delete(res); } }
}
function emitFor(job) {
  return payload => emitTo(job.id, payload);
}

// --- helpers ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.ass': 'text/plain', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function sendErr(res, code, message) { sendJson(res, code, { ok: false, error: message }); }
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}
function requireAuth(req, res) {
  const token = process.env.API_TOKEN;
  const url = new URL(req.url, 'http://x');
  const got = req.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
  // A valid Telegram Mini App session is an identity too — the Mini App
  // user is the site user. Checked first so a session works even when
  // API_TOKEN is set; when neither is configured the API stays open.
  if (got && process.env.TELEGRAM_BOT_TOKEN && verifySessionToken(got, process.env.TELEGRAM_BOT_TOKEN)) return true;
  if (!token) return true;
  if (got !== token) { sendErr(res, 401, 'missing or invalid API token'); return false; }
  return true;
}

// --- streaming multipart parser (one file part + text fields) ---
async function parseMultipart(req, destDir) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!m) throw Object.assign(new Error('multipart boundary missing'), { status: 400 });
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {};
  let file = null;
  let buf = Buffer.alloc(0);
  let state = 'boundary'; // boundary | headers | data
  let partHeaders = '', partName = '', partFilename = '', partFile = null, partPath = null, partFileDone = null;
  const finishPart = async () => {
    if (partFilename && partFile) {
      const f = partFile, done = partFileDone;
      partFile = null; partFileDone = null;
      f.end();
      await done; // wait until every byte is flushed to disk
      file = { field: partName, filename: partFilename, path: partPath, size: f.bytesWritten };
    }
  };
  for await (const chunk of req) {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_UPLOAD + 1024 * 1024) throw Object.assign(new Error('upload exceeds 500 MB cap'), { status: 413 });
    for (;;) {
      if (state === 'boundary') {
        const idx = buf.indexOf(boundary);
        if (idx === -1) { buf = buf.subarray(Math.max(0, buf.length - boundary.length)); break; }
        buf = buf.subarray(idx + boundary.length);
        if (buf.subarray(0, 2).toString() === '--') return { fields, file }; // end
        if (buf.subarray(0, 2).toString() === '\r\n') buf = buf.subarray(2);
        state = 'headers'; partHeaders = '';
      }
      if (state === 'headers') {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) break;
        partHeaders = buf.subarray(0, idx).toString();
        buf = buf.subarray(idx + 4);
        const disp = partHeaders.match(/Content-Disposition:[^\r\n]*?;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i);
        partName = disp?.[1] || ''; partFilename = disp?.[2] || '';
        partFile = null; partPath = null;
        if (partFilename) {
          const safe = basename(partFilename).replace(/[^a-zA-Z0-9._-]/g, '_');
          partPath = join(destDir, `upload-${randomUUID().slice(0, 8)}-${safe}`);
          const { createWriteStream } = await import('node:fs');
          partFile = createWriteStream(partPath);
          partFileDone = new Promise((res, rej) => { partFile.once('finish', res); partFile.once('error', rej); });
        }
        state = 'data';
      }
      if (state === 'data') {
        const idx = buf.indexOf(boundary);
        if (idx === -1) {
          // Keep a tail so a split boundary is not lost.
          const keep = boundary.length + 2;
          const writeUpTo = Math.max(0, buf.length - keep);
          if (writeUpTo > 0) {
            if (partFile) partFile.write(buf.subarray(0, writeUpTo));
            else fields[partName] = (fields[partName] || '') + buf.subarray(0, writeUpTo).toString();
            buf = buf.subarray(writeUpTo);
          }
          break;
        }
        let dataEnd = idx;
        if (buf.subarray(idx - 2, idx).toString() === '\r\n') dataEnd = idx - 2;
        const data = buf.subarray(0, dataEnd);
        if (partFile) partFile.write(data);
        else fields[partName] = (fields[partName] || '') + data.toString();
        await finishPart();
        buf = buf.subarray(idx);
        state = 'boundary';
      }
    }
  }
  await finishPart();
  return { fields, file };
}

// --- toolkit probes (real, every call) ---
async function probeToolkit() {
  const probes = [];
  const runProbe = async (id, name, fn) => {
    try { const v = await fn(); probes.push({ id, name, version: v, status: 'connected', note: '' }); }
    catch (e) { probes.push({ id, name, version: null, status: 'not_connected', note: e.message.slice(0, 140) }); }
  };
  await runProbe('ffmpeg', 'FFmpeg', async () => (await mediaRun('ffmpeg', ['-version'], { timeoutMs: 10000 })).stdout.split('\n')[0].replace('ffmpeg version ', '').split(' ')[0]);
  await runProbe('ffprobe', 'ffprobe', async () => (await mediaRun('ffprobe', ['-version'], { timeoutMs: 10000 })).stdout.split('\n')[0].replace('ffprobe version ', '').split(' ')[0]);
  await runProbe('ytdlp', 'yt-dlp', async () => (await mediaRun('python3', ['-m', 'yt_dlp', '--version'], { timeoutMs: 15000 })).stdout.trim());
  await runProbe('whisper', 'faster-whisper', async () => {
    const { stdout } = await mediaRun('python3', ['-c', "import faster_whisper; print(faster_whisper.__version__)"], { timeoutMs: 15000 });
    return stdout.trim();
  });
  probes.push({ id: 'claude', name: 'Claude Messages API', version: process.env.ANTHROPIC_API_KEY ? (process.env.CLAUDE_MODEL || 'claude-sonnet-5-5') : null, status: process.env.ANTHROPIC_API_KEY ? 'connected' : 'not_connected', note: process.env.ANTHROPIC_API_KEY ? '' : 'No ANTHROPIC_API_KEY — GPT-6 is used when OPENAI_API_KEY is set, else the heuristic fallback.' });
  probes.push({ id: 'openai', name: 'OpenAI API (GPT-6)', version: process.env.OPENAI_API_KEY ? (process.env.OPENAI_MODEL || 'gpt-6.2-sol') : null, status: process.env.OPENAI_API_KEY ? 'connected' : 'not_connected', note: process.env.OPENAI_API_KEY ? '' : 'No OPENAI_API_KEY — Claude is tried first; without either key the heuristic fallback is used and the log says so.' });
  probes.push({ id: 'youtube', name: 'YouTube Data API', version: null, status: process.env.YOUTUBE_API_KEY ? 'connected' : 'not_connected', note: process.env.YOUTUBE_API_KEY ? '' : 'No YOUTUBE_API_KEY — Scout cannot read live YouTube metadata.' });
  probes.push({ id: 'youtube-upload', name: 'YouTube upload', version: null, status: process.env.YOUTUBE_ACCESS_TOKEN ? 'connected' : 'not_connected', note: process.env.YOUTUBE_ACCESS_TOKEN ? 'Uploads go live as private videos after approval.' : 'No YOUTUBE_ACCESS_TOKEN — approvals are manual-export only.' });
  probes.push({ id: 'telegram', name: 'Telegram backup', version: null, status: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? 'connected' : 'not_connected', note: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? 'Finished clips are pushed to Telegram cloud after render + QA.' : 'No TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — finished clips are not backed up off the job disk.' });
  probes.push({ id: 'storage', name: 'External job storage (R2)', version: null, status: r2Config(process.env) ? 'connected' : 'not_connected', note: r2Config(process.env) ? 'Job records + media are mirrored to R2 and restored on boot — jobs survive restarts.' : 'No R2 env vars — jobs live only on the ephemeral disk and vanish on restart.' });
  probes.push({ id: 'redis', name: 'Redis / BullMQ queue', version: null, status: 'not_connected', note: 'Not configured — the in-process queue is used instead.' });
  probes.push({ id: 'libass', name: 'libass caption burn-in', version: null, status: probes.find(p => p.id === 'ffmpeg')?.status === 'connected' ? 'connected' : 'not_connected', note: 'Ships with FFmpeg; unavailable while FFmpeg is unavailable.' });
  probes.push({ id: 'reframe', name: 'Reframe engine', version: null, status: probes.find(p => p.id === 'ffmpeg')?.status === 'connected' ? 'connected' : 'not_connected', note: 'Runs on FFmpeg crops; unavailable while FFmpeg is unavailable.' });
  // Editing desk (agents/editing-desk.mjs) — real probes, only when the
  // desk is installed on this host; on Render free tier every stage skips.
  probes.push(...await probeDeskTools());
  return probes;
}

// Normalize the editing-desk options from a job request (multipart fields
// arrive as strings, JSON bodies as typed values). Unknown keys are
// dropped; trim seconds are coerced to numbers or null.
function parseDesk(raw) {
  let d = {};
  try { d = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { d = {}; }
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return {
    losslessTrim: !!d.losslessTrim,
    trimStart: num(d.trimStart), trimEnd: num(d.trimEnd),
    silenceCut: !!d.silenceCut, denoise: !!d.denoise,
    demucsVocals: !!d.demucsVocals, rembgPoster: !!d.rembgPoster,
    upscalePoster: !!d.upscalePoster, titleCard: !!d.titleCard,
  };
}

// --- routes ---
async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, status: 'ok', version: '2.0.0', time: new Date().toISOString(), services: { ffmpeg: true, whisper: true, claude: !!process.env.ANTHROPIC_API_KEY, openai: !!process.env.OPENAI_API_KEY, youtube: !!process.env.YOUTUBE_API_KEY, telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), storage: !!r2Config(process.env), editingDesk: !!process.env.EDITING_DESK } });
  }
  if (path === '/api/toolkit' && method === 'GET') {
    return sendJson(res, 200, { ok: true, tools: await probeToolkit() });
  }
  if (path === '/api/agents' && method === 'GET') {
    const ids = await readdir(JOBS_ROOT).catch(() => []);
    let latest = null;
    for (const id of ids.sort().reverse()) {
      const j = await loadJob(JOBS_ROOT, id);
      if (j) { latest = j; break; }
    }
    const agents = AGENT_IDS.map(id => ({
      id, name: AGENT_NAMES[id], role: AGENT_ROLES[id],
      state: latest ? latest.agents[id].status : 'standby',
      lastLine: latest ? latest.agents[id].lastLine : 'No job yet — paste a link to start one.',
      attempts: latest ? latest.agents[id].attempts : 0,
    }));
    return sendJson(res, 200, { ok: true, agents, hasJob: !!latest, latestJobId: latest?.id || null });
  }
  if (path === '/api/platform-limits' && method === 'GET') {
    const limits = JSON.parse(await readFile(join(CONFIG_ROOT, 'platform-limits.json'), 'utf8'));
    return sendJson(res, 200, { ok: true, ...limits });
  }
  if (path === '/api/platform-limits' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    if (!Array.isArray(body.limits)) return sendErr(res, 400, 'limits must be an array');
    const limits = { checkedAt: new Date().toISOString().slice(0, 10), limits: body.limits, note: 'Edited in Settings; each entry carries its source and last-checked date.' };
    await writeFile(join(CONFIG_ROOT, 'platform-limits.json'), JSON.stringify(limits, null, 2));
    return sendJson(res, 200, { ok: true, ...limits });
  }
  if (path === '/api/studio-demo' && method === 'GET') {
    const demo = JSON.parse(await readFile(join(CONFIG_ROOT, 'studio-demo.json'), 'utf8'));
    return sendJson(res, 200, { ok: true, ...demo });
  }
  if (path === '/api/events' && method === 'GET') {
    const jobId = url.searchParams.get('jobId');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    if (jobId) {
      if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
      subscribers.get(jobId).add(res);
      const job = await loadJob(JOBS_ROOT, jobId);
      if (job) res.write(`data: ${JSON.stringify({ type: 'snapshot', job: stripJob(job) })}\n\n`);
      req.on('close', () => subscribers.get(jobId)?.delete(res));
    }
    return;
  }

  // ---- jobs ----
  if (path === '/api/jobs' && method === 'GET') {
    const ids = await readdir(JOBS_ROOT).catch(() => []);
    const jobs = [];
    for (const id of ids.sort().reverse().slice(0, 30)) {
      const j = await loadJob(JOBS_ROOT, id);
      if (j) jobs.push(stripJob(j));
    }
    return sendJson(res, 200, { ok: true, jobs });
  }
  if (path === '/api/jobs' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const ct = req.headers['content-type'] || '';
    let input = {};
    let uploadedFile = null;
    if (ct.includes('multipart/form-data')) {
      await mkdir(JOBS_ROOT, { recursive: true });
      const tmpDir = join(JOBS_ROOT, '.upload-' + randomUUID().slice(0, 8));
      await mkdir(tmpDir, { recursive: true });
      const parsed = await parseMultipart(req, tmpDir);
      input = {
        sourceUrl: parsed.fields.sourceUrl || '',
        rightsConfirmed: parsed.fields.rightsConfirmed === 'true' || parsed.fields.rightsConfirmed === 'on',
        rightsBasis: parsed.fields.rightsBasis || 'user_asserted',
        formats: parsed.fields.formats ? JSON.parse(parsed.fields.formats) : ['9:16'],
        resolutions: parsed.fields.resolutions ? JSON.parse(parsed.fields.resolutions) : ['1080p'],
        niche: parsed.fields.niche || '',
        uploadMode: parsed.fields.uploadMode || 'review',
        captionStyle: parsed.fields.captionStyle || 'pop',
        pageId: parsed.fields.pageId || null,
        licenceId: parsed.fields.licenceId || null,
        telegramChatId: (parsed.fields.telegramChatId || '').trim(),
        desk: parseDesk(parsed.fields.desk),
      };
      uploadedFile = parsed.file;
      if (uploadedFile) input._uploadTmp = { dir: tmpDir, path: uploadedFile.path, filename: uploadedFile.filename };
    } else {
      input = await readJsonBody(req);
      input.desk = parseDesk(input.desk);
    }
    const errors = validateJobInput({ ...input, sourceFile: uploadedFile ? 'upload' : input.sourceFile });
    if (errors.length) return sendErr(res, 400, errors.join(' | '));
    const job = newJob(input, JOBS_ROOT);
    await mkdir(job.dirAbs, { recursive: true });
    if (uploadedFile) {
      const dest = join(job.dirAbs, `source${extname(uploadedFile.filename) || '.mp4'}`);
      await copyFile(uploadedFile.path, dest);
      job.input.sourceFile = basename(dest);
      job.input.sourceUrl = null;
      const { rm } = await import('node:fs/promises');
      await rm(input._uploadTmp.dir, { recursive: true, force: true });
    }
    await saveJob(job);
    logEvent(job, 'scout', 'running', 'Job received — Scout is scanning the opportunity around this source.', emitFor(job));
    // Run async; the client watches via SSE or polling.
    runOrchestrator(job, { emit: emitFor(job), ctx: { dataRoot: DATA_ROOT, jobsRoot: JOBS_ROOT, licences: await getLicences() } })
      .catch(err => console.error('orchestrator error', job.id, err));
    return sendJson(res, 201, { ok: true, id: job.id, job: stripJob(job) });
  }

  // ---- telegram: backup destination + import from the bot ----
  // POST /api/telegram/session — exchange Mini App initData for a session.
  // Validates Telegram's HMAC (tampered or stale initData → 401), then
  // returns the Telegram user id + a 24h session token. The bot token
  // never leaves the server.
  if (path === '/api/telegram/session' && method === 'POST') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return sendErr(res, 503, 'Telegram is not configured — set TELEGRAM_BOT_TOKEN in Render env first.');
    const body = await readJsonBody(req).catch(() => ({}));
    try {
      const user = validateInitData(body.initData || '', token);
      return sendJson(res, 200, { ok: true, telegramUserId: String(user.id), username: user.username || null, firstName: user.first_name || null, sessionToken: createSessionToken(String(user.id), token) });
    } catch (e) {
      return sendErr(res, 401, `Telegram session failed: ${e.message}`);
    }
  }
  // GET /api/telegram/updates — videos the user sent to the bot, plus who
  // tapped /start (connect flow). Works without a token (configured:false).
  if (path === '/api/telegram/updates' && method === 'GET') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return sendJson(res, 200, { ok: true, configured: false, botUsername: process.env.TELEGRAM_BOT_USERNAME || null, defaultChatId: process.env.TELEGRAM_CHAT_ID || null, videos: [], starters: [], channels: [] });
    try {
      const { videos, starters, channels } = await listTelegramUpdates({ token });
      return sendJson(res, 200, { ok: true, configured: true, botUsername: process.env.TELEGRAM_BOT_USERNAME || null, defaultChatId: process.env.TELEGRAM_CHAT_ID || null, videos, starters, channels });
    } catch (e) { return sendErr(res, 502, `Telegram updates failed: ${e.message}`); }
  }
  // POST /api/telegram/import — download a video the user sent to the bot
  // (from Telegram's servers, not YouTube) and run it as a job. Bot API
  // downloads cap at 20 MB; bigger files must use the New Job form upload.
  if (path === '/api/telegram/import' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return sendErr(res, 503, 'Telegram is not configured — set TELEGRAM_BOT_TOKEN in Render env first.');
    const body = await readJsonBody(req).catch(() => ({}));
    if (!body.fileId) return sendErr(res, 400, 'fileId is required — pick a video from GET /api/telegram/updates');
    const input = {
      sourceUrl: '', sourceFile: 'telegram',
      rightsConfirmed: body.rightsConfirmed === true, rightsBasis: body.rightsBasis || 'user_asserted',
      formats: body.formats || ['9:16'], resolutions: body.resolutions || ['1080p'],
      niche: body.niche || '', uploadMode: body.uploadMode || 'review', captionStyle: body.captionStyle || 'pop',
      pageId: body.pageId || null, licenceId: body.licenceId || null,
      telegramChatId: String(body.telegramChatId || '').trim(),
      desk: parseDesk(body.desk),
    };
    const errors = validateJobInput(input);
    if (errors.length) return sendErr(res, 400, errors.join(' | '));
    await mkdir(JOBS_ROOT, { recursive: true });
    const tmpDir = join(JOBS_ROOT, '.tg-' + randomUUID().slice(0, 8));
    await mkdir(tmpDir, { recursive: true });
    const dest = join(tmpDir, 'source.mp4');
    try {
      await downloadTelegramFile({ token, fileId: body.fileId, destPath: dest });
    } catch (e) {
      const { rm } = await import('node:fs/promises');
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return sendErr(res, 400, e.message);
    }
    const job = newJob(input, JOBS_ROOT);
    await mkdir(job.dirAbs, { recursive: true });
    await copyFile(dest, join(job.dirAbs, 'source.mp4'));
    job.input.sourceFile = 'source.mp4';
    job.input.sourceUrl = null;
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
    await saveJob(job);
    logEvent(job, 'scout', 'running', 'Job received from Telegram — Scout is scanning the opportunity around this source.', emitFor(job));
    runOrchestrator(job, { emit: emitFor(job), ctx: { dataRoot: DATA_ROOT, jobsRoot: JOBS_ROOT, licences: await getLicences() } })
      .catch(err => console.error('orchestrator error', job.id, err));
    return sendJson(res, 201, { ok: true, id: job.id, job: stripJob(job) });
  }

  const jobMatch = path.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(.*))?$/);
  if (jobMatch) {
    const [, id, rest] = jobMatch;
    const job = await loadJob(JOBS_ROOT, id);
    if (!job) return sendErr(res, 404, 'job not found');
    if (!rest && method === 'GET') return sendJson(res, 200, { ok: true, job: stripJob(job) });
    const regenMatch = rest?.match(/^clips\/(\d+)\/regenerate$/);
    if (regenMatch && method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readJsonBody(req);
      const overrides = body.overrides || body;
      try {
        const clip = await regenerateClip(job, parseInt(regenMatch[1], 10), overrides, { emit: emitFor(job), dataRoot: DATA_ROOT, jobsRoot: JOBS_ROOT });
        return sendJson(res, 200, { ok: true, clip: { rank: clip.rank, captionText: clip.captionText, captionStyle: clip.captionStyle, fontScale: clip.fontScale } });
      } catch (e) { return sendErr(res, e.status || 500, e.message); }
    }
    const approveMatch = rest?.match(/^publish\/([^/]+)\/approve$/);
    if (approveMatch && method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readJsonBody(req);
      try {
        const out = await approvePublish(job, decodeURIComponent(approveMatch[1]), body.checklist, { emit: emitFor(job), dataRoot: DATA_ROOT });
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) { return sendErr(res, e.status || 500, e.message); }
    }
    return sendErr(res, 404, 'unknown job route');
  }

  // ---- scout / autopilot ----
  if (path === '/api/scout' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await runScout({ licences: await getLicences(), niche: body.niche || '', ctx: { jobsRoot: JOBS_ROOT } });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (path === '/api/autopilot' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req).catch(() => ({}));
    const licences = await getLicences();
    const scout = await runScout({ licences, niche: body.niche || '', ctx: { jobsRoot: JOBS_ROOT } });
    let queued = 0;
    for (const src of scout.cleared) {
      if (!src.sourceUrl) continue;
      const job = newJob({ sourceUrl: src.sourceUrl, rightsConfirmed: true, rightsBasis: src.rightsBasis, formats: ['9:16'], resolutions: ['1080p'], niche: body.niche || '', uploadMode: 'review', captionStyle: 'pop' }, JOBS_ROOT);
      await mkdir(job.dirAbs, { recursive: true });
      await saveJob(job);
      runOrchestrator(job, { emit: emitFor(job), ctx: { dataRoot: DATA_ROOT, jobsRoot: JOBS_ROOT, licences } }).catch(() => {});
      queued++;
    }
    return sendJson(res, 200, { ok: true, queued, note: queued ? `${queued} job(s) queued from cleared sources in review mode.` : 'No cleared source has a video URL to queue — add a sourceUrl to a licence first.' });
  }

  // ---- pages / licences / campaigns ----
  if (path === '/api/pages' && method === 'GET') return sendJson(res, 200, { ok: true, pages: await getPages() });
  if (path === '/api/pages' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    if (!body.angle || !body.niche) return sendErr(res, 400, 'angle (one sentence) and niche are required');
    const pages = await getPages();
    const page = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'active', dailyCap: body.dailyCap ?? 3, sponsored: !!body.sponsored, platforms: body.platforms || ['YouTube'], handle: body.handle || '', sources: body.sources || [], ...body };
    pages.push(page);
    await writeStore('pages.json', pages);
    return sendJson(res, 201, { ok: true, page });
  }
  const pageDel = path.match(/^\/api\/pages\/([^/]+)$/);
  if (pageDel && method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    const pages = await getPages();
    await writeStore('pages.json', pages.filter(p => p.id !== pageDel[1]));
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/api/pages/ideas' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const niche = body.niche || 'general';
    const angle = body.angle || 'short, useful clips';
    return sendJson(res, 200, { ok: true, generatedBy: 'local templates (Claude not connected)', names: Array.from({ length: 10 }, (_, i) => `${niche} clips ${['daily', 'in 60s', 'explained', 'hacks', 'lab', 'show', 'fix', '101', 'hub', 'tv'][i]}`), bios: [`${angle} — new clip daily.`, `${niche}, made simple. One clip a day.`, `Short ${niche} clips. No fluff.`].map(b => b.slice(0, 80)), plan: Array.from({ length: 30 }, (_, i) => `Day ${i + 1}: ${niche} — ${['hook first', 'myth vs fact', 'quick how-to', 'common mistake', 'before/after', '3 tips', 'viewer question', 'best of', 'mistake to avoid', 'mini tutorial'][i % 10]}`) });
  }
  if (path === '/api/licences' && method === 'GET') return sendJson(res, 200, { ok: true, licences: await getLicences() });
  if (path === '/api/licences' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    if (!body.channel || !body.scope) return sendErr(res, 400, 'channel and scope are required');
    const licences = await getLicences();
    const lic = { id: randomUUID(), createdAt: new Date().toISOString(), basis: body.basis || 'permitted', attribution: body.attribution || '', expires: body.expires || null, rate: body.rate ?? null, sourceUrl: body.sourceUrl || null, ...body };
    licences.push(lic);
    await writeStore('licences.json', licences);
    return sendJson(res, 201, { ok: true, licence: lic });
  }
  const licDel = path.match(/^\/api\/licences\/([^/]+)$/);
  if (licDel && method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    await writeStore('licences.json', (await getLicences()).filter(l => l.id !== licDel[1]));
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/api/campaigns' && method === 'GET') return sendJson(res, 200, { ok: true, campaigns: await getCampaigns() });
  if (path === '/api/campaigns' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    if (!body.brand || !body.rules) return sendErr(res, 400, 'brand and rules are required');
    const campaigns = await getCampaigns();
    const c = { id: randomUUID(), createdAt: new Date().toISOString(), allowedPlatforms: body.allowedPlatforms || ['YouTube'], ratePer1k: body.ratePer1k ?? null, cap: body.cap ?? null, ...body };
    campaigns.push(c);
    await writeStore('campaigns.json', campaigns);
    return sendJson(res, 201, { ok: true, campaign: c });
  }
  const campDel = path.match(/^\/api\/campaigns\/([^/]+)$/);
  if (campDel && method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    await writeStore('campaigns.json', (await getCampaigns()).filter(c => c.id !== campDel[1]));
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/api/settings' && method === 'GET') {
    const settings = await readStore('settings.json', { ownedChannelIds: [], permissionsText: '' });
    return sendJson(res, 200, { ok: true, settings });
  }
  if (path === '/api/settings' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await readJsonBody(req);
    await writeStore('settings.json', body.settings || body);
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/api/earnings' && method === 'POST') {
    const b = await readJsonBody(req).catch(() => ({}));
    const rate = Number(b.ratePer1k || 0), fee = Number(b.feePct || 0) / 100;
    const views = Number(b.verifiedViews || 0), target = Number(b.target || 0), cap = Number(b.perClipCap || 0);
    let payout = (views / 1000) * rate * (1 - fee);
    if (cap > 0) payout = Math.min(payout, cap * Math.max(1, Math.ceil(views / 1000)));
    const viewsNeeded = rate > 0 && fee < 1 ? Math.ceil(target / (rate * (1 - fee)) * 1000) : null;
    return sendJson(res, 200, { ok: true, payout: +payout.toFixed(2), viewsNeeded, formula: 'payout = verifiedViews / 1000 × rate × (1 − fee), capped per clip when a campaign cap applies. viewsNeeded = target / (rate × (1 − fee)) × 1000.' });
  }
  return sendErr(res, 404, 'unknown api route');
}

function stripJob(job) {
  const { dirAbs, ...rest } = job;
  return rest;
}

// --- static + files ---
async function serveFile(req, res, filePath) {
  const st = await stat(filePath);
  const range = req.headers.range;
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // CORS: same-origin by default; allow the configured web origin.
    const origin = process.env.WEB_ORIGIN;
    if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type,authorization'); }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname.startsWith('/api/')) { await handleApi(req, res, url); return; }
    if (url.pathname.startsWith('/files/')) {
      // GET /files/:jobId/* — Range, path-traversal guard.
      const parts = url.pathname.split('/').slice(2);
      const jobId = parts[0];
      const rest = parts.slice(1).join('/');
      if (!/^[0-9a-f-]{36}$/.test(jobId) || !rest || rest.includes('..')) return sendErr(res, 400, 'bad file path');
      const filePath = resolve(JOBS_ROOT, jobId, rest);
      if (!filePath.startsWith(resolve(JOBS_ROOT, jobId) + '/')) return sendErr(res, 403, 'path traversal blocked');
      if (!existsSync(filePath)) return sendErr(res, 404, 'file not found');
      await serveFile(req, res, filePath);
      return;
    }
    // Static frontend (SPA fallback to index.html).
    let filePath = join(WEB_ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(WEB_ROOT)) return sendErr(res, 403, 'forbidden');
    if (!existsSync(filePath) || (await stat(filePath)).isDirectory()) filePath = join(WEB_ROOT, 'index.html');
    await serveFile(req, res, filePath);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendErr(res, err.status || 500, err.message || 'server error');
  }
});

await mkdir(JOBS_ROOT, { recursive: true });
await mkdir(DATA_ROOT, { recursive: true });
for (const [name, fallback] of [['pages.json', []], ['licences.json', []], ['campaigns.json', []], ['settings.json', { ownedChannelIds: [], permissionsText: '' }]]) {
  const p = join(DATA_ROOT, name);
  if (!existsSync(p)) await writeFile(p, JSON.stringify(fallback, null, 2));
}
// Boot restore from external storage (best-effort): jobs wiped from the
// ephemeral disk come back from R2 instead of vanishing. A slow or failed
// restore never blocks startup — the server starts either way.
try {
  const storeCfg = r2Config(process.env);
  if (storeCfg) {
    const report = await restoreJobs({ config: storeCfg, jobsRoot: JOBS_ROOT });
    if (report.restored.length || report.sourceMissing.length) console.log(`[store] boot restore: ${report.restored.join(', ') || 'none'} restored; source missing: ${report.sourceMissing.join(', ') || 'none'}`);
    else console.log('[store] boot restore: nothing to restore');
  }
} catch (e) { console.error('[store] boot restore failed:', e.message); }
// Boot restore from Telegram (best-effort, same window as R2 restore):
// jobs whose snapshot is still in the channel's recent updates come back.
try {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const tgReport = await restoreJobsFromTelegram({ jobsRoot: JOBS_ROOT, token: process.env.TELEGRAM_BOT_TOKEN });
    if (tgReport.restored.length || tgReport.sourceMissing.length) console.log(`[store] telegram restore: ${tgReport.restored.join(', ') || 'none'} restored; source missing: ${tgReport.sourceMissing.join(', ') || 'none'}`);
  }
} catch (e) { console.error('[store] telegram restore failed:', e.message); }
server.listen(PORT, HOST, () => console.log(`Wayne.clips listening on http://${HOST}:${PORT}`));
export { server };
