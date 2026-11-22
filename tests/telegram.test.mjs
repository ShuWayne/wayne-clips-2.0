import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupClipsToTelegram, listTelegramUpdates, downloadTelegramFile, telegramChatIdFor, postJobSnapshot, sendSourceToTelegram, restoreJobsFromTelegram, TELEGRAM_BOT_MAX_BYTES, TELEGRAM_BOT_MAX_DOWNLOAD_BYTES } from '../agents/telegram.mjs';
import { validateJobInput } from '../agents/guard.mjs';
import { runPublish } from '../agents/publish.mjs';

function fakeJob(dirAbs, clips) {
  return {
    id: '22222222-3333-4444-5555-666666666666', dirAbs, events: [],
    input: { niche: 'gta6' },
    clips: clips.map((c, i) => ({ rank: i + 1, hook: c.hook || 'HELLO WORLD', file: c.file })),
    drafts: [{ rank: 1, platform: 'YouTube', title: 'Hello world — gta6', caption: 'hello — cut by Wayne.clips.', hashtags: ['#shorts', '#viral', '#gta6'], status: 'draft' }],
    agents: { publish: { output: null } },
  };
}

function okFetch(calls, result = { message_id: 42, video: { file_id: 'FILEID1' } }) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
}

test('skips cleanly when Telegram is not configured (no fetch, no job write)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const job = fakeJob(dir, [{ hook: 'HELLO' }]);
  const out = await backupClipsToTelegram(job, { emit: () => {} }, { env: {}, fetchImpl: okFetch(calls), retryDelayMs: 0 });
  assert.equal(out.configured, false);
  assert.equal(calls.length, 0);
  assert.equal(job.telegram, undefined);
});

test('sends each clip via sendVideo and records file_id + message_id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'clip-1.mp4'), Buffer.alloc(100));
  const calls = [];
  const job = fakeJob(dir, [{ hook: 'HELLO WORLD' }]);
  const out = await backupClipsToTelegram(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_CHAT_ID: '-100123' },
    fetchImpl: okFetch(calls), retryDelayMs: 0,
  });
  assert.equal(out.configured, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telegram\.org\/botTESTTOKEN\/sendVideo/);
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('chat_id'), '-100123');
  assert.match(calls[0].init.body.get('caption'), /Hello world/);
  assert.ok(calls[0].init.body.get('video') instanceof File);
  assert.equal(out.backups[0].status, 'backed_up');
  assert.equal(out.backups[0].fileId, 'FILEID1');
  assert.equal(out.backups[0].messageId, 42);
  assert.equal(job.telegram.chatId, '-100123');
});

test('skips files over the bot send limit without calling Telegram', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'clip-1.mp4'), Buffer.alloc(20));
  const calls = [];
  const job = fakeJob(dir, [{ hook: 'HELLO' }]);
  const out = await backupClipsToTelegram(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' },
    fetchImpl: okFetch(calls), retryDelayMs: 0, maxBytes: 10,
  });
  assert.equal(calls.length, 0);
  assert.equal(out.backups[0].status, 'skipped_too_large');
  assert.match(out.backups[0].error, /50 MB|exceeds/);
});

test('a Telegram failure never throws — the clip is marked failed and the job continues', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'clip-1.mp4'), Buffer.alloc(50));
  const job = fakeJob(dir, [{ hook: 'HELLO' }]);
  const failing = async () => { throw new Error('network down'); };
  const out = await backupClipsToTelegram(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' },
    fetchImpl: failing, retryDelayMs: 0,
  });
  assert.equal(out.backups[0].status, 'failed');
  assert.match(out.backups[0].error, /network down/);
});

test('runPublish backs clips up when Telegram is configured, and still completes drafts when it is not', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'clip-1.mp4'), Buffer.alloc(80));
  const job = fakeJob(dir, [{ hook: 'HELLO WORLD' }]);
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  const prevFetch = globalThis.fetch;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevOpenai = process.env.OPENAI_API_KEY;
  const calls = [];
  process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
  process.env.TELEGRAM_CHAT_ID = '-100123';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = okFetch(calls);
  t.after(() => {
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevChat;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenai;
    globalThis.fetch = prevFetch;
  });
  const { drafts } = await runPublish(job, { emit: () => {} });
  assert.equal(drafts.length, 3);
  // Clip backup (sendVideo) + final job snapshot (sendDocument).
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /sendVideo/);
  assert.match(calls[1].url, /sendDocument/);
  assert.equal(job.telegram.backups[0].status, 'backed_up');
  assert.equal(job.telegram.snapshots[0].stage, 'publish');
});

test('the 50 MB bot cap is the enforced limit', () => {
  assert.equal(TELEGRAM_BOT_MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(TELEGRAM_BOT_MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024);
});

test('per-job telegram chat id beats the server default', () => {
  const env = { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-100999' };
  assert.deepEqual(telegramChatIdFor({ input: { telegramChatId: '-100111' } }, env), { chatId: '-100111', source: 'job' });
  assert.deepEqual(telegramChatIdFor({ input: {} }, env), { chatId: '-100999', source: 'env' });
  assert.deepEqual(telegramChatIdFor({ input: {} }, {}), { chatId: null, source: null });
});

test('backup sends to the per-job chat id when set', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'clip-1.mp4'), Buffer.alloc(60));
  const calls = [];
  const job = fakeJob(dir, [{ hook: 'HELLO' }]);
  job.input.telegramChatId = '-100111';
  await backupClipsToTelegram(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-100999' },
    fetchImpl: okFetch(calls), retryDelayMs: 0,
  });
  assert.equal(calls[0].init.body.get('chat_id'), '-100111');
  assert.equal(job.telegram.source, 'job');
});

test('telegramChatId must look like a chat id or @username', () => {
  const base = { sourceUrl: 'https://example.com/v.mp4', rightsConfirmed: true, rightsBasis: 'owned', formats: ['9:16'], resolutions: ['1080p'] };
  assert.deepEqual(validateJobInput({ ...base, telegramChatId: '-1001234567890' }), []);
  assert.deepEqual(validateJobInput({ ...base, telegramChatId: '@wayneclips' }), []);
  assert.match(validateJobInput({ ...base, telegramChatId: 'not a chat' }).join(' '), /telegramChatId/);
});

test('listTelegramUpdates parses bot videos and /start senders', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /getUpdates/);
    return { ok: true, json: async () => ({ ok: true, result: [
      { update_id: 1, message: { message_id: 10, date: 1700000000, chat: { id: -100123 }, from: { id: 7, username: 'shu', first_name: 'Shu' }, video: { file_id: 'VID1', file_unique_id: 'U1', mime_type: 'video/mp4', file_size: 123456 } } },
      { update_id: 2, message: { message_id: 11, date: 1700000001, chat: { id: 7 }, from: { id: 7, username: 'shu', first_name: 'Shu' }, text: '/start' } },
      { update_id: 3, message: { message_id: 12, date: 1700000002, chat: { id: 7 }, text: 'hello' } },
      { update_id: 4, my_chat_member: { date: 1700000003, chat: { id: -100999888777, title: 'Wayne.clips Cloud', type: 'channel' }, new_chat_member: { status: 'administrator' } } },
      { update_id: 5, channel_post: { message_id: 1, date: 1700000004, chat: { id: -100999888777, title: 'Wayne.clips Cloud', type: 'channel' }, text: 'hello channel' } },
    ] }) };
  };
  const { videos, starters, channels } = await listTelegramUpdates({ token: 'T', fetchImpl });
  assert.equal(videos.length, 1);
  assert.equal(videos[0].fileId, 'VID1');
  assert.equal(videos[0].fileSize, 123456);
  assert.equal(starters.length, 1);
  assert.equal(starters[0].chatId, '7');
  assert.equal(starters[0].username, 'shu');
  // The channel appears once (my_chat_member + channel_post deduped), newest first.
  assert.equal(channels.length, 1);
  assert.equal(channels[0].chatId, '-100999888777');
  assert.equal(channels[0].title, 'Wayne.clips Cloud');
});

test('downloadTelegramFile fetches via getFile and writes the bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_id: 'VID1', file_path: 'videos/file_1.mp4', file_size: 4 } }) };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('fake').buffer };
  };
  const out = await downloadTelegramFile({ token: 'T', fileId: 'VID1', destPath: join(dir, 'source.mp4'), fetchImpl });
  assert.equal(out.fileName, 'file_1.mp4');
  assert.equal(out.fileSize, 4);
  assert.match(seen[1], /\/file\/botT\/videos\/file_1\.mp4/);
});

test('downloadTelegramFile refuses files over the 20 MB bot download cap', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, result: { file_id: 'BIG', file_path: 'videos/big.mp4', file_size: 25 * 1024 * 1024 } }) });
  await assert.rejects(
    downloadTelegramFile({ token: 'T', fileId: 'BIG', destPath: '/tmp/never.mp4', fetchImpl }),
    /20 MB/,
  );
});

// --- Telegram storage v1: snapshots, source send, restore ---

test('postJobSnapshot sends job.json as a document with the job id in the caption', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const job = fakeJob(dir, [{ hook: 'HELLO' }]);
  job.updatedAt = '2026-11-22T08:00:00.000Z';
  const out = await postJobSnapshot(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_CHAT_ID: '-100123' },
    fetchImpl: okFetch(calls, { message_id: 7, document: { file_id: 'DOC1' } }),
    retryDelayMs: 0, stage: 'ingest',
  });
  assert.equal(out.configured, true);
  assert.equal(out.fileId, 'DOC1');
  assert.equal(out.messageId, 7);
  assert.match(calls[0].url, /api\.telegram\.org\/botTESTTOKEN\/sendDocument/);
  const doc = calls[0].init.body.get('document');
  assert.ok(doc instanceof File);
  assert.equal(doc.name, `${job.id}.json`);
  assert.match(calls[0].init.body.get('caption'), new RegExp(`Wayne\\.clips job ${job.id} — snapshot ingest`));
  assert.equal(job.telegram.snapshots[0].fileId, 'DOC1');
});

test('postJobSnapshot skips cleanly when unconfigured and never throws on send failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const job = fakeJob(dir, [{ hook: 'HELLO' }]);
  const unconf = await postJobSnapshot(job, { emit: () => {} }, { env: {}, fetchImpl: okFetch([]), retryDelayMs: 0 });
  assert.equal(unconf.configured, false);
  const failing = async () => { throw new Error('network down'); };
  const out = await postJobSnapshot(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-100123' }, fetchImpl: failing, retryDelayMs: 0,
  });
  assert.equal(out.configured, true);
  assert.match(out.error, /network down/);
});

test('sendSourceToTelegram sends the source video; oversize and missing files skip, never throw', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'source.mp4'), Buffer.alloc(100));
  const calls = [];
  const job = fakeJob(dir, [{ hook: 'HELLO' }]);
  job.input.sourceFile = 'source.mp4';
  const out = await sendSourceToTelegram(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_CHAT_ID: '-100123' },
    fetchImpl: okFetch(calls), retryDelayMs: 0,
  });
  assert.equal(out.status, 'backed_up');
  assert.match(calls[0].url, /sendVideo/);
  assert.match(calls[0].init.body.get('caption'), new RegExp(`Wayne\\.clips job ${job.id} — source`));
  assert.equal(job.telegram.source.fileId, 'FILEID1');
  // Oversize (simulated with a tiny cap) and missing file both skip.
  const big = await sendSourceToTelegram(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-100123' }, fetchImpl: okFetch([]), retryDelayMs: 0, maxBytes: 10,
  });
  assert.equal(big.status, 'skipped_too_large');
  const gone = fakeJob(dir, [{ hook: 'HELLO' }]);
  gone.input.sourceFile = 'nope.mp4';
  const miss = await sendSourceToTelegram(gone, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-100123' }, fetchImpl: okFetch([]), retryDelayMs: 0,
  });
  assert.equal(miss.status, 'skipped_missing');
});

test('clip captions carry the job id and rank (restore can attribute channel messages)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'clip-1.mp4'), Buffer.alloc(100));
  const calls = [];
  const job = fakeJob(dir, [{ hook: 'HELLO WORLD' }]);
  await backupClipsToTelegram(job, { emit: () => {} }, {
    env: { TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_CHAT_ID: '-100123' },
    fetchImpl: okFetch(calls), retryDelayMs: 0,
  });
  const caption = calls[0].init.body.get('caption');
  assert.match(caption, new RegExp(`job ${job.id}`));
  assert.match(caption, /clip #1/);
});

test('listTelegramUpdates parses snapshot documents; restore round-trips a wiped job', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-tg-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jobId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const remoteJob = { id: jobId, updatedAt: '2026-11-22T08:00:00.000Z', status: 'running', input: { sourceFile: 'source.mp4' }, agents: {}, events: [] };
  const fetchImpl = async (url) => {
    if (url.includes('/getUpdates')) {
      return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 1, channel_post: { message_id: 10, date: 1795336000, chat: { id: -1003830374119, type: 'channel', title: 'Wayne.clips Cloud' }, document: { file_id: 'SNAP1', file_name: `${jobId}.json`, mime_type: 'application/json' }, caption: `Wayne.clips job ${jobId} — snapshot publish` } },
        { update_id: 2, channel_post: { message_id: 11, date: 1795336001, chat: { id: -1003830374119, type: 'channel', title: 'Wayne.clips Cloud' }, video: { file_id: 'SRC1', file_unique_id: 'u1', mime_type: 'video/mp4', file_size: 4 }, caption: `Wayne.clips job ${jobId} — source` } },
      ] }) };
    }
    if (url.includes('/getFile')) {
      const fileId = new URL(url).searchParams.get('file_id');
      const path = fileId === 'SNAP1' ? 'documents/snap.json' : 'videos/src.mp4';
      return { ok: true, json: async () => ({ ok: true, result: { file_id: fileId, file_path: path, file_size: 4 } }) };
    }
    if (url.includes('/file/botT/documents/')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(remoteJob)).buffer };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('FAKESOURCE').buffer };
  };
  const updates = await listTelegramUpdates({ token: 'T', fetchImpl });
  assert.equal(updates.snapshots.length, 1);
  assert.equal(updates.snapshots[0].jobId, jobId);
  assert.equal(updates.snapshots[0].stage, 'publish');
  const report = await restoreJobsFromTelegram({ jobsRoot: dir, token: 'T', fetchImpl });
  assert.deepEqual(report.restored, [jobId]);
  assert.deepEqual(report.sourceMissing, []);
  const restored = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, jobId, 'job.json'), 'utf8'));
  assert.equal(restored.id, jobId);
  assert.equal((await (await import('node:fs/promises')).readFile(join(dir, jobId, 'source.mp4'))).toString(), 'FAKESOURCE');
});
