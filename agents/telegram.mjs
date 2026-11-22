// Telegram backup + storage — finished clips, the source video and a job
// snapshot (job.json) are pushed to Telegram cloud, so the files AND the
// job record survive even if the Render job disk is wiped by a restart or
// redeploy. On boot the server restores jobs from the channel's recent
// updates (see restoreJobsFromTelegram). Honest limit: the Bot API cannot
// read channel history — getUpdates only returns unconfirmed updates from
// the last ~24 h (max 100), so a job untouched for longer than that cannot
// be restored from Telegram; R2 mirrors job.json beyond that window.
// Needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (Render env). The bot is
// Shu's own: create it with @BotFather, add it to a channel (admin) or
// DM it once, and put the token + chat id in Render env — never in chat.
// Bot API limit: bots can SEND files up to 50 MB (the 2 GB figure is for
// the Telegram app / user clients, not bots). A 1080p Short ≤60s is
// ~10–30 MB, so Shorts fit; bigger files are skipped, never fatal.
// A backup/snapshot failure NEVER fails the job — it is logged and the
// clip stays on disk for a manual retry.
import { join } from 'node:path';
import { stat, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { logEvent, saveJob } from '../packages/shared/job.mjs';

export const TELEGRAM_BOT_MAX_BYTES = 50 * 1024 * 1024; // Bot API send cap
export const TELEGRAM_BOT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Bot API download cap
const CAPTION_MAX = 1024; // Telegram caption limit

export function telegramConfigured(env = process.env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

// Which chat gets this job's clips: the job's own Telegram chat id
// (from the New Job form / Settings, saved in the browser) wins over the
// server default in TELEGRAM_CHAT_ID.
export function telegramChatIdFor(job, env = process.env) {
  const fromJob = String(job?.input?.telegramChatId || '').trim();
  if (fromJob) return { chatId: fromJob, source: 'job' };
  const fromEnv = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (fromEnv) return { chatId: fromEnv, source: 'env' };
  return { chatId: null, source: null };
}

// Recent videos sent to the bot + who tapped /start (connect flow).
// getUpdates is called WITHOUT an offset on purpose: unacknowledged
// updates stay available (~24 h), so the import list survives a reload.
// No webhook is used anywhere, so getUpdates never conflicts with one.
export async function listTelegramUpdates({ token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?limit=100&timeout=5`, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram HTTP ${res.status}`);
  const videos = [], starters = [], snapshots = [];
  const channelSeen = new Map();
  for (const u of data.result || []) {
    // Channel membership reveals the clips destination: the bot added as
    // admin/member (my_chat_member) or any post in a channel (channel_post)
    // carries the channel's id + title. No video or /start needed.
    const member = u.my_chat_member;
    if (member?.chat?.type === 'channel' && ['member', 'administrator'].includes(member.new_chat_member?.status)) {
      channelSeen.set(String(member.chat.id), { chatId: String(member.chat.id), title: member.chat.title || null, type: 'channel', date: member.date });
    }
    const msg = u.channel_post || u.message;
    if (!msg) continue;
    if (msg.chat?.type === 'channel') {
      channelSeen.set(String(msg.chat.id), { chatId: String(msg.chat.id), title: msg.chat.title || null, type: 'channel', date: msg.date });
    }
    const v = msg.video || (msg.document && String(msg.document.mime_type || '').startsWith('video/') ? msg.document : null);
    if (v) videos.push({ fileId: v.file_id, fileUniqueId: v.file_unique_id, fileName: msg.document?.file_name || `video-${msg.date}.mp4`, mimeType: v.mime_type, fileSize: v.file_size ?? msg.document?.file_size ?? null, date: msg.date, chatId: String(msg.chat.id), caption: msg.caption || null });
    // Job snapshot documents: a .json document whose caption starts with
    // "Wayne.clips job " carries a full job record for boot restore.
    if (msg.document && String(msg.document.file_name || '').endsWith('.json') && String(msg.caption || '').startsWith('Wayne.clips job ')) {
      const parts = String(msg.caption).split(' ');
      snapshots.push({ jobId: parts[2] || null, stage: parts[5] || null, fileId: msg.document.file_id, fileName: msg.document.file_name, date: msg.date, chatId: String(msg.chat.id), messageId: msg.message_id });
    }
    if (msg.text && String(msg.text).startsWith('/start')) {
      const from = msg.from || {};
      starters.push({ chatId: String(msg.chat.id), username: from.username || null, firstName: from.first_name || null, date: msg.date });
    }
  }
  videos.sort((a, b) => b.date - a.date);
  starters.sort((a, b) => b.date - a.date);
  snapshots.sort((a, b) => b.date - a.date);
  const channels = [...channelSeen.values()].sort((a, b) => b.date - a.date);
  return { videos, starters, channels, snapshots };
}

// Download a video the user sent to the bot, from Telegram's servers
// (not YouTube — this bypasses the Render YouTube block). Bot API
// downloads cap at 20 MB: bigger files must use the New Job form upload.
export async function downloadTelegramFile({ token, fileId, destPath, fetchImpl = fetch } = {}) {
  const g = await fetchImpl(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(30000) });
  const gd = await g.json().catch(() => ({}));
  if (!g.ok || gd.ok === false) throw new Error(gd.description || `Telegram HTTP ${g.status}`);
  const filePath = gd.result?.file_path;
  const fileSize = gd.result?.file_size ?? null;
  if (!filePath) throw new Error('Telegram did not return a file path for that video');
  if (fileSize !== null && fileSize > TELEGRAM_BOT_MAX_DOWNLOAD_BYTES) throw new Error(`That video is ${(fileSize / 1048576).toFixed(1)} MB — bots can only download 20 MB via the Bot API. Send a shorter clip, or upload the file in the New Job form instead.`);
  const dl = await fetchImpl(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(300000) });
  if (!dl.ok) throw new Error(`Telegram file download HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length > TELEGRAM_BOT_MAX_DOWNLOAD_BYTES) throw new Error('That video is over the 20 MB bot download limit — send a shorter clip, or upload the file in the New Job form instead.');
  await writeFile(destPath, buf);
  return { filePath, fileSize: buf.length, fileName: filePath.split('/').pop() };
}

function captionFor(job, clip) {
  const draft = (job.drafts || []).find(d => d.rank === clip.rank && d.platform === 'YouTube');
  const title = draft?.title || clip.hook || `Wayne.clips clip #${clip.rank}`;
  const tags = (draft?.hashtags || []).join(' ');
  // Job id + rank in the caption: the channel message stays attributable
  // to its job without the job record (boot restore parses these).
  return `${title}${tags ? `\n${tags}` : ''}\n— cut by Wayne.clips · job ${job.id} · clip #${clip.rank}`.slice(0, CAPTION_MAX);
}

async function sendClip({ token, chatId, file, caption, fetchImpl, retryDelayMs }) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', new File([await readFile(file)], file.split('/').pop(), { type: 'video/mp4' }));
  form.append('caption', caption);
  form.append('supports_streaming', 'true');
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(60000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram HTTP ${res.status}`);
      return { fileId: data.result?.video?.file_id || null, messageId: data.result?.message_id ?? null };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  throw lastErr;
}

export async function backupClipsToTelegram(job, ctx = {}, opts = {}) {
  const env = opts.env || process.env;
  const token = env.TELEGRAM_BOT_TOKEN;
  const { chatId, source } = telegramChatIdFor(job, env);
  const fetchImpl = opts.fetchImpl || fetch;
  const maxBytes = opts.maxBytes ?? TELEGRAM_BOT_MAX_BYTES;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const emit = ctx.emit || (() => {});
  if (!token || !chatId) return { configured: false, backups: [] };
  const backups = [];
  for (const clip of job.clips || []) {
    const name = clip.file || `clip-${clip.rank}.mp4`;
    const file = join(job.dirAbs, name);
    let size = -1;
    try { size = (await stat(file)).size; } catch { /* missing file */ }
    if (size < 0) {
      backups.push({ rank: clip.rank, status: 'skipped_missing', error: `${name} not found on disk` });
      logEvent(job, 'publish', 'running', `Telegram backup: clip #${clip.rank} skipped — file missing on disk.`, emit);
      continue;
    }
    if (size > maxBytes) {
      backups.push({ rank: clip.rank, status: 'skipped_too_large', error: `${(size / 1048576).toFixed(1)} MB exceeds the 50 MB bot send limit` });
      logEvent(job, 'publish', 'running', `Telegram backup: clip #${clip.rank} skipped — ${(size / 1048576).toFixed(1)} MB exceeds the 50 MB bot send limit.`, emit);
      continue;
    }
    try {
      const sent = await sendClip({ token, chatId, file, caption: captionFor(job, clip), fetchImpl, retryDelayMs });
      backups.push({ rank: clip.rank, status: 'backed_up', fileId: sent.fileId, messageId: sent.messageId, bytes: size, at: new Date().toISOString() });
      logEvent(job, 'publish', 'done', `Telegram backup: clip #${clip.rank} saved to Telegram (message ${sent.messageId}) — it survives a wiped job disk.`, emit);
    } catch (err) {
      backups.push({ rank: clip.rank, status: 'failed', error: String(err?.message || err).slice(0, 200) });
      logEvent(job, 'publish', 'running', `Telegram backup: clip #${clip.rank} failed (${String(err?.message || err).slice(0, 120)}) — the clip is still on disk; the job is not affected.`, emit);
    }
  }
  job.telegram = { chatId: String(chatId), source, backups };
  await saveJob(job);
  return { configured: true, backups };
}

async function sendDocument({ token, chatId, filename, body, caption, fetchImpl, retryDelayMs }) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new File([body], filename, { type: 'application/json' }));
  form.append('caption', caption);
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(60000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram HTTP ${res.status}`);
      return { fileId: data.result?.document?.file_id || null, messageId: data.result?.message_id ?? null };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  throw lastErr;
}

// Post the job record itself as a document to the channel — the snapshot
// is what boot restore downloads. Milestones only (ingest / render /
// publish): a message per agent step would flood the channel.
// Never throws; a snapshot failure is logged and the job is unaffected.
export async function postJobSnapshot(job, ctx = {}, opts = {}) {
  const env = opts.env || process.env;
  const token = env.TELEGRAM_BOT_TOKEN;
  const { chatId } = telegramChatIdFor(job, env);
  const fetchImpl = opts.fetchImpl || fetch;
  const emit = ctx.emit || (() => {});
  const stage = opts.stage || 'snapshot';
  if (!token || !chatId) return { configured: false };
  const { dirAbs, ...persisted } = job;
  try {
    const sent = await sendDocument({ token, chatId, filename: `${job.id}.json`, body: JSON.stringify(persisted, null, 2), caption: `Wayne.clips job ${job.id} — snapshot ${stage}`, fetchImpl, retryDelayMs: opts.retryDelayMs ?? 2000 });
    job.telegram = job.telegram || {};
    job.telegram.snapshots = [...(job.telegram.snapshots || []), { stage, fileId: sent.fileId, messageId: sent.messageId, at: new Date().toISOString() }];
    await saveJob(job).catch(() => {});
    return { configured: true, fileId: sent.fileId, messageId: sent.messageId };
  } catch (err) {
    logEvent(job, 'publish', 'running', `Telegram snapshot (${stage}) failed (${String(err?.message || err).slice(0, 120)}) — the job is not affected.`, emit);
    return { configured: true, error: String(err?.message || err).slice(0, 200) };
  }
}

// Send the source video to the channel at the end of ingest, so the input
// survives a wipe too. Skipped when missing or over the 50 MB bot cap.
// Never throws.
export async function sendSourceToTelegram(job, ctx = {}, opts = {}) {
  const env = opts.env || process.env;
  const token = env.TELEGRAM_BOT_TOKEN;
  const { chatId } = telegramChatIdFor(job, env);
  const fetchImpl = opts.fetchImpl || fetch;
  const maxBytes = opts.maxBytes ?? TELEGRAM_BOT_MAX_BYTES;
  const emit = ctx.emit || (() => {});
  if (!token || !chatId) return { configured: false };
  const name = job.input?.sourceFile || 'source.mp4';
  const file = join(job.dirAbs, name);
  let size = -1;
  try { size = (await stat(file)).size; } catch { /* missing file */ }
  if (size < 0) return { configured: true, status: 'skipped_missing' };
  if (size > maxBytes) {
    logEvent(job, 'ingest', 'running', `Telegram storage: source skipped — ${(size / 1048576).toFixed(1)} MB exceeds the 50 MB bot send limit.`, emit);
    return { configured: true, status: 'skipped_too_large', bytes: size };
  }
  try {
    const sent = await sendClip({ token, chatId, file, caption: `Wayne.clips job ${job.id} — source`, fetchImpl, retryDelayMs: opts.retryDelayMs ?? 2000 });
    job.telegram = job.telegram || {};
    job.telegram.source = { fileId: sent.fileId, messageId: sent.messageId, bytes: size, at: new Date().toISOString() };
    await saveJob(job).catch(() => {});
    logEvent(job, 'ingest', 'done', `Telegram storage: source saved to Telegram (message ${sent.messageId}) — it survives a wiped job disk.`, emit);
    return { configured: true, status: 'backed_up', fileId: sent.fileId, messageId: sent.messageId };
  } catch (err) {
    logEvent(job, 'ingest', 'running', `Telegram storage: source failed (${String(err?.message || err).slice(0, 120)}) — the source is still on disk; the job is not affected.`, emit);
    return { configured: true, status: 'failed', error: String(err?.message || err).slice(0, 200) };
  }
}

// Boot restore from the channel's recent updates: newest snapshot document
// per job, plus the source/clip videos whose captions name that job.
// Only what getUpdates still holds (~24 h, max 100) can come back —
// anything older needs the R2 mirror or a re-upload. Never throws.
// Returns { restored: [ids], skipped: [ids], sourceMissing: [ids] }.
export async function restoreJobsFromTelegram({ jobsRoot, token, fetchImpl = fetch } = {}) {
  const report = { restored: [], skipped: [], sourceMissing: [] };
  if (!token) return report;
  let updates;
  try {
    updates = await listTelegramUpdates({ token, fetchImpl });
  } catch (e) {
    console.error('[store] telegram restore: updates failed:', e.message);
    return report;
  }
  const newest = new Map();
  for (const s of updates.snapshots || []) {
    if (!s.jobId) continue;
    const prev = newest.get(s.jobId);
    if (!prev || s.date > prev.date) newest.set(s.jobId, s);
  }
  for (const [id, snap] of newest) {
    try {
      const tmp = join(jobsRoot, `.restore-${id}.json`);
      await downloadTelegramFile({ token, fileId: snap.fileId, destPath: tmp, fetchImpl });
      const remoteJob = JSON.parse(await readFile(tmp, 'utf8'));
      await unlink(tmp).catch(() => {});
      let local = null;
      try { local = JSON.parse(await readFile(join(jobsRoot, id, 'job.json'), 'utf8')); } catch {}
      if (local && new Date(local.updatedAt || 0) >= new Date(remoteJob.updatedAt || 0)) { report.skipped.push(id); continue; }
      const dir = join(jobsRoot, id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'job.json'), JSON.stringify(remoteJob, null, 2));
      let hasSource = false;
      for (const v of updates.videos || []) {
        const cap = String(v.caption || '');
        if (!cap.includes(`job ${id}`)) continue;
        const isSource = cap.includes('— source');
        const rank = (cap.match(/clip #(\d+)/) || [])[1];
        const dest = join(dir, isSource ? (remoteJob.input?.sourceFile || 'source.mp4') : `clip-${rank || 'x'}.mp4`);
        try {
          await downloadTelegramFile({ token, fileId: v.fileId, destPath: dest, fetchImpl });
          if (isSource) hasSource = true;
        } catch { /* one missing file must not sink the restore */ }
      }
      if (!hasSource && !(remoteJob.input?.sourceUrl && !remoteJob.input?.sourceFile)) {
        remoteJob.status = 'failed';
        remoteJob.agents = remoteJob.agents || {};
        remoteJob.agents.ingest = { ...(remoteJob.agents.ingest || {}), status: 'failed', error: 'Source file missing after restore — re-upload the video to run this job again.' };
        remoteJob.events = [...(remoteJob.events || []), { id: (remoteJob.events || []).length + 1, agent: 'ingest', status: 'failed', message: 'Restore: source file could not be recovered from Telegram — re-upload the video to run this job again.', createdAt: new Date().toISOString() }];
        await writeFile(join(dir, 'job.json'), JSON.stringify(remoteJob, null, 2));
        report.sourceMissing.push(id);
      } else {
        report.restored.push(id);
      }
    } catch (e) {
      console.error(`[store] telegram restore: job ${id} failed:`, e.message);
    }
  }
  return report;
}
