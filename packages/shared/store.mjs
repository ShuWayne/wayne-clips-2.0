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

// --- Mirror helpers: best-effort, NEVER throw. A store failure must never
// fail a job — callers await these and check `ok`, or ignore the result. ---

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// PUT one object; returns { ok: true } or { ok: false, reason }.
export async function mirrorPut({ config, key, body, contentType = 'application/octet-stream', fetchImpl, timeoutMs = 30000 }) {
  if (!config) return { ok: false, reason: 'unconfigured' };
  try {
    await r2Put({ config, key, body, contentType, fetchImpl, timeoutMs });
    return { ok: true };
  } catch (e) {
    console.error(`[store] mirror PUT ${key} failed:`, e.message);
    return { ok: false, reason: e.message };
  }
}

// Mirror a job's job.json (dirAbs stripped, same as the local write).
export async function mirrorJobJson({ config, job, fetchImpl, timeoutMs = 5000 }) {
  if (!config) return { ok: false, reason: 'unconfigured' };
  const { dirAbs, ...persisted } = job;
  return mirrorPut({ config, key: `jobs/${job.id}/job.json`, body: JSON.stringify(persisted, null, 2), contentType: 'application/json', fetchImpl, timeoutMs });
}

// Mirror one file out of a job dir (source, clip, poster, sheet).
export async function mirrorJobFile({ config, jobId, dirAbs, filename, contentType, fetchImpl, timeoutMs = 60000 }) {
  if (!config) return { ok: false, reason: 'unconfigured' };
  let buf;
  try {
    buf = await readFile(join(dirAbs, filename));
  } catch {
    return { ok: false, reason: `missing local file ${filename}` };
  }
  return mirrorPut({ config, key: `jobs/${jobId}/${filename}`, body: buf, contentType: contentType || 'application/octet-stream', fetchImpl, timeoutMs });
}

// Boot restore: list jobs in R2; for each id missing locally (or with a
// newer updatedAt remotely), download job.json + source + media into the
// local jobs dir. A job whose source cannot be restored stays listed but
// marked failed with a plain-language error — never silently vanished.
// Returns { restored: [ids], skipped: [ids], sourceMissing: [ids] }.
export async function restoreJobs({ config, jobsRoot, fetchImpl, timeoutMs = 30000 }) {
  const report = { restored: [], skipped: [], sourceMissing: [] };
  if (!config) return report;
  let ids;
  try {
    const listed = await r2List({ config, prefix: 'jobs/', fetchImpl, timeoutMs });
    ids = [...new Set(listed.keys.map(k => k.key.split('/')[1]).filter(Boolean))];
  } catch (e) {
    console.error('[store] boot restore: LIST failed:', e.message);
    return report;
  }
  for (const id of ids) {
    try {
      const remote = await r2Get({ config, key: `jobs/${id}/job.json`, fetchImpl, timeoutMs });
      if (!remote.data) continue;
      const remoteJob = JSON.parse(remote.data.toString());
      let local = null;
      try { local = JSON.parse(await readFile(join(jobsRoot, id, 'job.json'), 'utf8')); } catch {}
      if (local && new Date(local.updatedAt || 0) >= new Date(remoteJob.updatedAt || 0)) { report.skipped.push(id); continue; }
      const dir = join(jobsRoot, id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'job.json'), remote.data);
      // All other files under this job's prefix (source, clips, posters).
      const files = await r2List({ config, prefix: `jobs/${id}/`, fetchImpl, timeoutMs });
      let hasSource = false;
      for (const { key } of files.keys) {
        const name = key.split('/').slice(2).join('/');
        if (!name || name === 'job.json') continue;
        const got = await r2Get({ config, key, fetchImpl, timeoutMs });
        if (!got.data) continue;
        await writeFile(join(dir, name), got.data);
        if (name === (remoteJob.input?.sourceFile || 'source.mp4')) hasSource = true;
      }
      if (!hasSource && remoteJob.input?.sourceUrl && !remoteJob.input?.sourceFile) {
        // URL job that never finished its download: ingest can fetch it
        // again from the link on resume — not a lost source.
        report.restored.push(id);
      } else if (!hasSource) {
        remoteJob.status = 'failed';
        remoteJob.agents = remoteJob.agents || {};
        remoteJob.agents.ingest = { ...(remoteJob.agents.ingest || {}), status: 'failed', error: 'Source file missing after restore — re-upload the video to run this job again.' };
        remoteJob.events = [...(remoteJob.events || []), { id: (remoteJob.events || []).length + 1, agent: 'ingest', status: 'failed', message: 'Restore: source file could not be recovered from backup — re-upload the video to run this job again.', createdAt: new Date().toISOString() }];
        await writeFile(join(dir, 'job.json'), JSON.stringify(remoteJob, null, 2));
        report.sourceMissing.push(id);
      } else {
        report.restored.push(id);
      }
    } catch (e) {
      console.error(`[store] boot restore: job ${id} failed:`, e.message);
    }
  }
  return report;
}
