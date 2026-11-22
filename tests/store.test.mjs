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
