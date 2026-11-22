import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAss, checkAssSafeArea, CAPTION_STYLES } from '../agents/subtitle.mjs';

const clip = { start: 10, end: 30, hook: 'THIS CHANGES EVERYTHING', rank: 1 };
const words = [
  { w: 'This ', start: 10.2, end: 10.6 }, { w: 'changes ', start: 10.6, end: 11.1 },
  { w: 'everything. ', start: 11.1, end: 11.8 }, { w: 'Watch ', start: 12.0, end: 12.4 },
  { w: 'this. ', start: 12.4, end: 12.8 },
];

test('ASS is generated for every caption style with word timing', () => {
  for (const style of CAPTION_STYLES) {
    const ass = buildAss(clip, words, { style, fontScale: 1 });
    assert.match(ass, /PlayResX: 1080/);
    assert.match(ass, /PlayResY: 1920/);
    assert.match(ass, /Dialogue:/);
    assert.ok(ass.includes('THIS') || ass.includes('This'), `style ${style} carries words`);
  }
});

test('ASS events are clip-relative (start at 0, not source time)', () => {
  const ass = buildAss(clip, words, { style: 'pop', fontScale: 1 });
  assert.match(ass, /0:00:00\.20,0:00:00\.60/);
  assert.doesNotMatch(ass, /0:00:10\.20/);
});

test('safe-area check passes for normal captions and fails on huge fonts', () => {
  const ass = buildAss(clip, words, { style: 'pop', fontScale: 1 });
  assert.deepEqual(checkAssSafeArea(ass), []);
  const big = buildAss(clip, words, { style: 'pop', fontScale: 2 });
  assert.ok(checkAssSafeArea(big).some(p => p.includes('exceeds safe maximum')));
});

test('empty word list falls back to the hook line, never crashes', () => {
  const ass = buildAss(clip, [], { style: 'pop', fontScale: 1 });
  assert.match(ass, /THIS CHANGES EVERYTHING/);
});
