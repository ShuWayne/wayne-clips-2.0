// Telegram Mini App identity — validate the WebApp initData Telegram sends
// when the site opens inside Telegram, and mint short-lived session tokens
// so the Mini App user can call the API without a separate login.
//
// Trust rules (Telegram's own spec, no shortcuts):
// - initData is a query string; `hash` is HMAC-SHA256 of the data-check
//   string (all other fields, sorted, `key=value` joined by \n), keyed by
//   SHA256(bot token). A tampered field changes the hash.
// - `auth_date` must be within the last 24h, or the data is stale.
// - Session tokens are `userId.expiry.signature`, HMAC-SHA256 keyed by the
//   bot token. The bot token never leaves the server.
import { createHmac, timingSafeEqual } from 'node:crypto';

const AUTH_MAX_AGE_S = 24 * 60 * 60;
export const SESSION_TTL_S = 24 * 60 * 60;

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

// Validate initData from Telegram.WebApp.initData. Returns the Telegram
// user object ({ id, username, first_name, ... }). Throws on any failure.
export function validateInitData(initData, botToken) {
  if (!botToken) throw Object.assign(new Error('Telegram bot is not configured'), { code: 'NOT_CONFIGURED' });
  if (!initData || typeof initData !== 'string') throw new Error('initData is required');
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('initData has no hash');
  const pairs = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = hmacSha256('WebAppData', botToken);
  const expected = hmacSha256(secretKey, dataCheckString).toString('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(receivedHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('initData hash mismatch — data was tampered with or is not from this bot');
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > AUTH_MAX_AGE_S) throw new Error('initData is stale — reopen the Mini App');
  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    throw new Error('initData user is not valid JSON');
  }
  if (!user || typeof user.id !== 'number') throw new Error('initData has no Telegram user');
  return user;
}

// Mint a session token for a validated Telegram user id. Format:
// `${userId}.${expiryUnix}.${hexHmac}` — HMAC over `userId.expiry`.
export function createSessionToken(userId, botToken, { ttlSeconds = SESSION_TTL_S, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const expiry = nowSeconds + ttlSeconds;
  const sig = hmacSha256(botToken, `${userId}.${expiry}`).toString('hex');
  return `${userId}.${expiry}.${sig}`;
}

// Verify a session token. Returns the user id (string) or null.
export function verifySessionToken(token, botToken) {
  if (!token || !botToken) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [userId, expiryStr, sig] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (!/^\d+$/.test(userId) || !Number.isFinite(expiry) || expiry < Date.now() / 1000) return null;
  const expected = hmacSha256(botToken, `${userId}.${expiry}`).toString('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return userId;
}
