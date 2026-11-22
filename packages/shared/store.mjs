// External object store — minimal S3-compatible client (Cloudflare R2) with
// hand-rolled SigV4 signing, so the project keeps its zero-npm-dependency
// stance. Used to mirror job.json + media off the ephemeral Render disk.
// Unconfigured (no R2 env) => every call is a silent no-op and the app
// behaves exactly as today (local disk only). A store failure must never
// fail a job — callers catch and log.
import { createHash, createHmac } from 'node:crypto';

const SERVICE = 's3';

export function r2Config(env = process.env) {
  const accountId = (env.R2_ACCOUNT_ID || '').trim();
  const accessKey = (env.R2_ACCESS_KEY_ID || '').trim();
  const secretKey = (env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = (env.R2_BUCKET || '').trim();
  if (!accountId || !accessKey || !secretKey || !bucket) return null;
  return { accountId, accessKey, secretKey, bucket, region: (env.R2_REGION || 'auto').trim() || 'auto' };
}

export function r2Endpoint(config) {
  return `https://${config.accountId}.r2.cloudflarestorage.com`;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

// AWS Signature Version 4 for one request. Returns the Authorization header
// value + the x-amz-date / x-amz-content-sha256 headers. `now` is injectable
// so tests can pin the date.
export function signRequest({ method, url, body = Buffer.alloc(0), accessKey, secretKey, region, now = new Date() }) {
  const u = new URL(url);
  const payloadHash = sha256Hex(body);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  // Canonical query string: params sorted by name, each name/value encoded.
  const canonicalQuery = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const headers = {
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const canonicalRequest = [method.toUpperCase(), encodeURI(u.pathname), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate, payloadHash, signature, scope,
  };
}

async function request({ config, method, key, body = null, contentType = 'application/octet-stream', fetchImpl = fetch, timeoutMs = 30000 }) {
  const url = `${r2Endpoint(config)}/${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const buf = body === null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const sig = signRequest({ method, url, body: buf, accessKey: config.accessKey, secretKey: config.secretKey, region: config.region });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method, body: method === 'GET' || method === 'HEAD' ? undefined : buf,
      headers: {
        authorization: sig.authorization,
        'x-amz-content-sha256': sig.payloadHash,
        'x-amz-date': sig.amzDate,
        ...(method === 'PUT' ? { 'content-type': contentType, 'content-length': String(buf.length) } : {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function r2Put({ config, key, body, contentType, fetchImpl, timeoutMs }) {
  if (!config) return { configured: false };
  const res = await request({ config, method: 'PUT', key, body, contentType, fetchImpl, timeoutMs });
  if (!res.ok) throw new Error(`R2 PUT ${key} failed (${res.status})`);
  return { configured: true, key };
}

export async function r2Get({ config, key, fetchImpl, timeoutMs }) {
  if (!config) return { configured: false, data: null };
  const res = await request({ config, method: 'GET', key, fetchImpl, timeoutMs });
  if (res.status === 404) return { configured: true, data: null };
  if (!res.ok) throw new Error(`R2 GET ${key} failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { configured: true, data: buf };
}

export async function r2Head({ config, key, fetchImpl, timeoutMs }) {
  if (!config) return { configured: false, exists: false };
  const res = await request({ config, method: 'HEAD', key, fetchImpl, timeoutMs });
  if (res.status === 404) return { configured: true, exists: false };
  return { configured: true, exists: res.ok };
}

// List keys under a prefix. Returns { keys: [{ key, lastModified, size }] }.
// Follows continuation tokens until the listing is complete (bounded).
export async function r2List({ config, prefix, fetchImpl, timeoutMs }) {
  if (!config) return { configured: false, keys: [] };
  const keys = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const url = `${r2Endpoint(config)}/${config.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const sig = signRequest({ method: 'GET', url, body: Buffer.alloc(0), accessKey: config.accessKey, secretKey: config.secretKey, region: config.region });
    const res = await fetchImpl(url, { method: 'GET', headers: { authorization: sig.authorization, 'x-amz-content-sha256': sig.payloadHash, 'x-amz-date': sig.amzDate } });
    if (!res.ok) throw new Error(`R2 LIST ${prefix} failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push({ key: m[1] });
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!truncated || !next) break;
    token = next[1];
  }
  return { configured: true, keys };
}

export async function r2Delete({ config, key, fetchImpl, timeoutMs }) {
  if (!config) return { configured: false };
  const res = await request({ config, method: 'DELETE', key, fetchImpl, timeoutMs });
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} failed (${res.status})`);
  return { configured: true, key };
}
