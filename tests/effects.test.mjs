import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseEffects, selectableEffects, EFFECTS } from '../agents/effects.mjs';

test('only ffmpeg-drawable presets are selectable; planned ones never are', () => {
  const sel = selectableEffects();
  assert.ok(sel.length >= 4);
  assert.ok(sel.every(e => e.draw && !e.planned));
  assert.ok(EFFECTS.filter(e => e.planned).every(e => !sel.includes(e)));
  assert.ok(EFFECTS.some(e => e.id === 'glitch' && e.planned));
  assert.ok(EFFECTS.some(e => e.id === 'face-track' && e.planned));
});

test('effect budget is at most 0.5 per second', () => {
  const clip = { start: 0, end: 20 }; // 20s -> budget 10, but pool is smaller
  const picked = chooseEffects(clip);
  assert.ok(picked.length <= 10);
  assert.ok(picked.length >= 1);
  const short = chooseEffects({ start: 0, end: 2 }); // 2s -> budget 1
  assert.equal(short.length, 1);
});

test('emotion-matched presets come first', () => {
  const picked = chooseEffects({ start: 0, end: 30 }, { emotion: 'warm' });
  assert.equal(picked[0].id, 'grade-warm');
});
