import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { r2Config, r2Endpoint, signRequest, r2Put, r2Get, r2List, r2Delete } from '../packages/shared/store.mjs';

const CONFIG = { accountId: 'testaccount', accessKey: 'TESTACCESS', secretKey: 'TESTSECRET', bucket: 'wayne-clips-jobs', region: 'auto' };
const FIXED_NOW = new Date('2026-11-22T12:00:00.000Z');

test('r2Config needs all four vars; region defaults to auto', () => {
  assert.equal(r2Config({}), null);
  assert.equal(r2Config({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' }), null);
  const cfg = r2Config({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd' });
  assert.equal(cfg.region, 'auto');
  assert.equal(r2Endpoint(cfg), 'https://a.r2.cloudflarestorage.com');
});

test('signRequest builds a well-formed SigV4 Authorization header', () => {
  const out = signRequest({ method: 'GET', url: 'https://testaccount.r2.cloudflarestorage.com/wayne-clips-jobs/jobs/abc/job.json', body: Buffer.alloc(0), accessKey: 'TESTACCESS', secretKey: 'TESTSECRET', region: 'auto', now: FIXED_NOW });
  assert.equal(out.amzDate, '20261122T120000Z');
  assert.equal(out.scope, '20261122/auto/s3/aws4_request');
  assert.equal(out.payloadHash, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.match(out.authorization, /^AWS4-HMAC-SHA256 Credential=TESTACCESS\/20261122\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test('signRequest signature matches an independent recomputation (spec construction)', () => {
  const url = 'https://testaccount.r2.cloudflarestorage.com/wayne-clips-jobs/jobs/abc/job.json';
  const out = signRequest({ method: 'PUT', url, body: Buffer.from('{"a":1}'), accessKey: 'TESTACCESS', secretKey: 'TESTSECRET', region: 'auto', now: FIXED_NOW });
  // Recompute from the spec, inline — not via the module under test.
  const payloadHash = createHash('sha256').update(Buffer.from('{"a":1}')).digest('hex');
  const canonicalHeaders = `host:testaccount.r2.cloudflarestorage.com\nx-amz-content-sha256:${payloadHash}\nx-amz-date:20261122T120000Z\n`;
  const canonicalRequest = ['PUT', '/wayne-clips-jobs/jobs/abc/job.json', '', canonicalHeaders, 'host;x-amz-content-sha256;x-amz-date', payloadHash].join('\n');
  const scope = '20261122/auto/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', '20261122T120000Z', scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = createHmac('sha256', 'AWS4TESTSECRET').update('20261122').digest();
  const kRegion = createHmac('sha256', kDate).update('auto').digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  assert.equal(out.signature, expected);
});

function okFetch(calls, { status = 200, body = '', arrayBuffer = null } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    // Slice the pool-backed buffer: Buffer.from(body).buffer is the whole
    // 8 KB slab, not the string — slice to the exact bytes.
    const exact = () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    return {
      ok: status >= 200 && status < 300, status,
      text: async () => body,
      arrayBuffer: async () => (arrayBuffer !== null ? arrayBuffer : exact()),
    };
  };
}

test('r2Put signs and uploads to the right URL; unconfigured skips without fetch', async () => {
  const calls = [];
  const out = await r2Put({ config: CONFIG, key: 'jobs/abc/job.json', body: '{"a":1}', contentType: 'application/json', fetchImpl: okFetch(calls) });
  assert.equal(out.configured, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://testaccount.r2.cloudflarestorage.com/wayne-clips-jobs/jobs/abc/job.json');
  assert.equal(calls[0].init.method, 'PUT');
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256/);
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  const skipped = await r2Put({ config: null, key: 'jobs/abc/job.json', body: '{}', fetchImpl: okFetch(calls) });
  assert.equal(skipped.configured, false);
  assert.equal(calls.length, 1);
});

test('r2Get returns bytes on 200 and null on 404; errors throw', async () => {
  const calls = [];
  const hit = await r2Get({ config: CONFIG, key: 'jobs/abc/job.json', fetchImpl: okFetch(calls, { body: '{"a":1}' }) });
  assert.equal(hit.configured, true);
  assert.equal(hit.data.toString(), '{"a":1}');
  const miss = await r2Get({ config: CONFIG, key: 'jobs/nope/job.json', fetchImpl: okFetch(calls, { status: 404 }) });
  assert.equal(miss.data, null);
  await assert.rejects(r2Get({ config: CONFIG, key: 'jobs/abc/job.json', fetchImpl: okFetch(calls, { status: 403 }) }), /403/);
});

test('r2List parses keys from the S3 XML listing', async () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>jobs/abc/job.json</Key></Contents><Contents><Key>jobs/abc/clip-1.mp4</Key></Contents></ListBucketResult>`;
  const calls = [];
  const out = await r2List({ config: CONFIG, prefix: 'jobs/', fetchImpl: okFetch(calls, { body: xml }) });
  assert.equal(out.configured, true);
  assert.deepEqual(out.keys.map(k => k.key), ['jobs/abc/job.json', 'jobs/abc/clip-1.mp4']);
  assert.match(calls[0].url, /list-type=2&prefix=jobs%2F/);
});

test('r2Delete tolerates 404 and reports the key', async () => {
  const calls = [];
  const out = await r2Delete({ config: CONFIG, key: 'jobs/abc/job.json', fetchImpl: okFetch(calls, { status: 404 }) });
  assert.equal(out.configured, true);
  assert.equal(out.key, 'jobs/abc/job.json');
});

// --- Mirror + restore (wiring) ---

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { newJob, saveJob, writeLedger } from '../packages/shared/job.mjs';
import { mirrorJobFile, restoreJobs } from '../packages/shared/store.mjs';

// A fake R2 backed by an in-memory object: PUT records, GET serves bytes,
// LIST returns XML keys for the requested prefix.
function fakeR2Store(initial = {}) {
  const store = { ...initial };
  const puts = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const keys = Object.keys(store).filter(k => k.startsWith(prefix));
      const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
      return { ok: true, status: 200, text: async () => xml };
    }
    const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
    if (init.method === 'PUT') {
      puts.push({ key, body: init.body });
      store[key] = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body);
      return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (key in store) {
      const buf = Buffer.isBuffer(store[key]) ? store[key] : Buffer.from(store[key]);
      const exact = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { ok: true, status: 200, text: async () => buf.toString(), arrayBuffer: async () => exact };
    }
    return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { store, puts, fetchImpl };
}

test('saveJob mirrors job.json when configured, skips when not, never fails on store error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-save-'));
  t.after(() => import('node:fs/promises').then(m => m.rm(dir, { recursive: true, force: true })));
  const job = newJob({ sourceFile: 'source.mp4', rightsConfirmed: true, rightsBasis: 'owned' }, dir);
  const { puts, fetchImpl } = fakeR2Store();
  await saveJob(job, { r2config: CONFIG, fetchImpl });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, `jobs/${job.id}/job.json`);
  assert.equal(JSON.parse(puts[0].body.toString()).id, job.id);
  // Local file still written.
  assert.equal(JSON.parse(await readFile(join(dir, job.id, 'job.json'), 'utf8')).id, job.id);
  // Unconfigured: no fetch, no throw.
  const job2 = newJob({ sourceFile: 'source.mp4' }, dir);
  await saveJob(job2, { r2config: null });
  assert.equal(puts.length, 1);
  // Failing store: saveJob still resolves and the local file exists.
  const failing = async () => { throw new Error('network down'); };
  const job3 = newJob({ sourceFile: 'source.mp4' }, dir);
  await saveJob(job3, { r2config: CONFIG, fetchImpl: failing });
  assert.equal(JSON.parse(await readFile(join(dir, job3.id, 'job.json'), 'utf8')).id, job3.id);
});

test('mirrorJobFile PUTs the bytes; missing file returns ok:false without throwing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-mf-'));
  t.after(() => import('node:fs/promises').then(m => m.rm(dir, { recursive: true, force: true })));
  await writeFile(join(dir, 'clip-1.mp4'), Buffer.from('FAKECLIP'));
  const { puts, fetchImpl } = fakeR2Store();
  const out = await mirrorJobFile({ config: CONFIG, jobId: 'abc', dirAbs: dir, filename: 'clip-1.mp4', contentType: 'video/mp4', fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(puts[0].key, 'jobs/abc/clip-1.mp4');
  assert.equal(puts[0].body.toString(), 'FAKECLIP');
  const miss = await mirrorJobFile({ config: CONFIG, jobId: 'abc', dirAbs: dir, filename: 'nope.mp4', fetchImpl });
  assert.equal(miss.ok, false);
  const unconf = await mirrorJobFile({ config: null, jobId: 'abc', dirAbs: dir, filename: 'clip-1.mp4', fetchImpl });
  assert.equal(unconf.ok, false);
  assert.equal(unconf.reason, 'unconfigured');
});

test('writeLedger mirrors the ledger; restoreJobs round-trips a wiped jobs dir', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wc-restore-'));
  t.after(() => import('node:fs/promises').then(m => m.rm(dir, { recursive: true, force: true })));
  const { puts, fetchImpl } = fakeR2Store();
  await writeLedger(dir, { approvals: [{ key: 'x', date: '2026-11-22' }] }, { r2config: CONFIG, fetchImpl });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, 'data/publish-ledger.json');

  // Remote: aaa = full job (job.json + source + clip), bbb = job.json only
  // (source lost), ccc = remote older than the local copy (skip).
  const remoteJob = (id, updatedAt) => JSON.stringify({ id, updatedAt, status: 'running', input: { sourceFile: 'source.mp4' }, agents: {}, events: [] });
  const { fetchImpl: r2 } = fakeR2Store({
    'jobs/aaa/job.json': remoteJob('aaa', '2026-11-22T10:00:00.000Z'),
    'jobs/aaa/source.mp4': Buffer.from('FAKESOURCE'),
    'jobs/aaa/clip-1.mp4': Buffer.from('FAKECLIP'),
    'jobs/bbb/job.json': remoteJob('bbb', '2026-11-22T09:00:00.000Z'),
    'jobs/ccc/job.json': remoteJob('ccc', '2026-11-22T10:00:00.000Z'),
  });
  await mkdir(join(dir, 'ccc'), { recursive: true });
  await writeFile(join(dir, 'ccc', 'job.json'), JSON.stringify({ id: 'ccc', updatedAt: '2026-11-22T11:00:00.000Z', status: 'done', input: {}, agents: {}, events: [] }));
  const report = await restoreJobs({ config: CONFIG, jobsRoot: dir, fetchImpl: r2 });
  assert.deepEqual(report.restored, ['aaa']);
  assert.deepEqual(report.skipped, ['ccc']);
  assert.deepEqual(report.sourceMissing, ['bbb']);
  // aaa fully restored on disk.
  assert.equal(JSON.parse(await readFile(join(dir, 'aaa', 'job.json'), 'utf8')).id, 'aaa');
  assert.equal((await readFile(join(dir, 'aaa', 'source.mp4'))).toString(), 'FAKESOURCE');
  assert.equal((await readFile(join(dir, 'aaa', 'clip-1.mp4'))).toString(), 'FAKECLIP');
  // bbb stays listed, marked failed with a plain-language error.
  const bbb = JSON.parse(await readFile(join(dir, 'bbb', 'job.json'), 'utf8'));
  assert.equal(bbb.status, 'failed');
  assert.match(bbb.agents.ingest.error, /re-upload/);
  // ccc local copy untouched (remote older).
  assert.equal(JSON.parse(await readFile(join(dir, 'ccc', 'job.json'), 'utf8')).status, 'done');
});
