import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJobInput, isExpired, effectiveRightsBasis, scoreSource, flagText, writeCaption, approvalChecklistValid } from '../agents/guard.mjs';

test('URL job without rightsConfirmed is rejected', () => {
  const errs = validateJobInput({ sourceUrl: 'https://example.com/v.mp4', rightsConfirmed: false, rightsBasis: 'owned' });
  assert.ok(errs.some(e => e.includes('rights confirmation')));
});

test('reference basis is never clippable', () => {
  const errs = validateJobInput({ sourceUrl: 'https://example.com/v.mp4', rightsConfirmed: true, rightsBasis: 'reference' });
  assert.ok(errs.some(e => e.includes('never downloaded')));
});

test('valid owned URL job passes', () => {
  assert.deepEqual(validateJobInput({ sourceUrl: 'https://example.com/v.mp4', rightsConfirmed: true, rightsBasis: 'owned' }), []);
});

test('invalid URL rejected', () => {
  assert.ok(validateJobInput({ sourceUrl: 'not a url', rightsConfirmed: true, rightsBasis: 'owned' }).length > 0);
});

test('expired permission is treated as reference', () => {
  assert.equal(effectiveRightsBasis({ basis: 'permitted', expires: '2020-01-01' }), 'reference');
  assert.equal(isExpired({ expires: '2020-01-01' }), true);
  assert.equal(effectiveRightsBasis({ basis: 'permitted', expires: '2999-01-01' }), 'permitted');
});

test('source score is 0 whenever rights < 1', () => {
  assert.equal(scoreSource({ velocity: 1, engagement: 1, fit: 1, rights: 0 }), 0);
  assert.equal(scoreSource({ velocity: 1, engagement: 1, fit: 1, rights: 0.5 }), 0);
  assert.ok(scoreSource({ velocity: 1, engagement: 1, fit: 1, rights: 1 }) > 0.9);
});

test('spoiler and leak flags detected', () => {
  assert.equal(flagText('and then the ending reveals the killer').spoilerRisk, true);
  assert.equal(flagText('leaked unreleased footage here').leakRisk, true);
  assert.equal(flagText('a normal cooking tip').spoilerRisk, false);
});

test('caption rules: 120 chars, hashtag caps, Ad: required when sponsored', () => {
  assert.throws(() => writeCaption({ text: 'x'.repeat(121), hashtags: [] }), /120 characters/);
  const c = writeCaption({ text: 'hello world', hashtags: ['#a', '#b', '#c', '#d', '#e', '#f'], platform: 'YouTube' });
  assert.equal(c.hashtags.length, 5);
  assert.throws(() => writeCaption({ text: 'buy this now', hashtags: [], sponsored: true }), /must start with "Ad:"/);
  const ad = writeCaption({ text: 'Ad: buy this now', hashtags: [], sponsored: true });
  assert.equal(ad.caption, 'Ad: buy this now');
  assert.throws(() => writeCaption({ text: 'the leaked ending is wild', hashtags: [] }), /spoiler or leak/);
});

test('approval checklist needs all six ticked', () => {
  assert.equal(approvalChecklistValid([true, true, true, true, true, true]), true);
  assert.equal(approvalChecklistValid([true, true, true, true, true, false]), false);
  assert.equal(approvalChecklistValid([true, true]), false);
});
