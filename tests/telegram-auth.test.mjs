import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateInitData, createSessionToken, verifySessionToken } from '../agents/telegram-auth.mjs';

const BOT_TOKEN = 'TESTBOT:fake-token-for-tests-only';

// Build initData exactly the way Telegram does, with inline crypto —
// so the test checks the module against the spec, not against itself.
function buildInitData({ user = { id: 123456789, username: 'shu', first_name: 'Shu' }, authDate = Math.floor(Date.now() / 1000), tamper = null } = {}) {
  const fields = {
    auth_date: String(authDate),
    user: JSON.stringify(user),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  };
  const dataCheckString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  let out = params.toString();
  if (tamper) out = out.replace(encodeURIComponent(JSON.stringify(user)).slice(0, 20), tamper);
  return out;
}

test('validateInitData accepts genuine Telegram initData and returns the user', () => {
  const user = validateInitData(buildInitData(), BOT_TOKEN);
  assert.equal(user.id, 123456789);
  assert.equal(user.username, 'shu');
});

test('validateInitData rejects tampered initData (hash mismatch)', () => {
  const good = buildInitData();
  // Change one character of the signed user payload after signing.
  const tampered = good.replace('shu', 'shx');
  assert.throws(() => validateInitData(tampered, BOT_TOKEN), /hash mismatch/);
});

test('validateInitData rejects initData without a hash and without a bot token', () => {
  assert.throws(() => validateInitData('auth_date=123&user=%7B%7D', BOT_TOKEN), /no hash/);
  assert.throws(() => validateInitData(buildInitData(), ''), (err) => {
    assert.equal(err.code, 'NOT_CONFIGURED');
    return true;
  });
});

test('validateInitData rejects stale initData (auth_date over 24h old)', () => {
  const stale = buildInitData({ authDate: Math.floor(Date.now() / 1000) - 25 * 60 * 60 });
  assert.throws(() => validateInitData(stale, BOT_TOKEN), /stale/);
});

test('session token round-trips: create then verify returns the user id', () => {
  const token = createSessionToken('123456789', BOT_TOKEN);
  assert.equal(verifySessionToken(token, BOT_TOKEN), '123456789');
});

test('session token rejects tampering, expiry and the wrong bot token', () => {
  const token = createSessionToken('123456789', BOT_TOKEN);
  const tampered = token.slice(0, -2) + '00';
  assert.equal(verifySessionToken(tampered, BOT_TOKEN), null);
  const expired = createSessionToken('123456789', BOT_TOKEN, { ttlSeconds: -10 });
  assert.equal(verifySessionToken(expired, BOT_TOKEN), null);
  assert.equal(verifySessionToken(token, 'OTHERBOT:token'), null);
  assert.equal(verifySessionToken('not-a-token', BOT_TOKEN), null);
  assert.equal(verifySessionToken(token, ''), null);
});
