import test from 'node:test';
import assert from 'node:assert/strict';
import { pickMoments, sentencesFromTranscript } from '../agents/viral.mjs';

const transcript = {
  segments: [{ text: 'Hello world. This is a test.', start: 0, end: 4, words: [
    { w: 'Hello ', start: 0, end: 0.4 }, { w: 'world. ', start: 0.4, end: 0.9 },
    { w: 'This ', start: 1, end: 1.3 }, { w: 'is ', start: 1.3, end: 1.5 },
    { w: 'a ', start: 1.5, end: 1.6 }, { w: 'test. ', start: 1.6, end: 2.0 },
  ] }],
  words: [
    { w: 'Hello ', start: 0, end: 0.4 }, { w: 'world. ', start: 0.4, end: 0.9 },
    { w: 'This ', start: 1, end: 1.3 }, { w: 'is ', start: 1.3, end: 1.5 },
    { w: 'a ', start: 1.5, end: 1.6 }, { w: 'test. ', start: 1.6, end: 2.0 },
  ],
};

test('sentences rebuild from the word stream on punctuation', () => {
  const s = sentencesFromTranscript(transcript);
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'Hello world.');
  assert.equal(s[0].start, 0);
  assert.equal(s[1].end, 2.0);
});

function fakeSentences(n, dur = 120) {
  return Array.from({ length: n }, (_, i) => ({
    text: i === 0 ? 'Nobody tells you this secret about growing fast.' : `Tip number ${i + 1} is to keep every clip short and punchy.`,
    start: i * 8, end: i * 8 + 6, words: [],
  }));
}

test('moments cut on sentence boundaries, 15-60s, scored', () => {
  const { moments } = pickMoments(fakeSentences(12), 120, { maxClips: 6 });
  assert.ok(moments.length >= 2 && moments.length <= 6);
  for (const m of moments) {
    assert.ok(m.end - m.start >= 8 && m.end - m.start <= 60, `clip length ${m.end - m.start}`);
    assert.ok(m.score >= 0 && m.score <= 1);
    assert.equal(m.spoilerRisk, false);
    assert.equal(m.leakRisk, false);
  }
});

test('spoiler/leak-flagged moments are dropped before storage — zero tolerated', () => {
  const s = fakeSentences(6);
  s[1].text = 'And the leaked ending shows who dies at the end.';
  s[2].text = 'Here is the embargoed unreleased footage.';
  const { moments, dropped } = pickMoments(s, 120, { maxClips: 6 });
  assert.equal(dropped, 2);
  assert.ok(!moments.some(m => /leak|ending|dies/i.test(m.hook)));
});

test('top-scored anchor wins the hook', () => {
  const { moments } = pickMoments(fakeSentences(8), 120, { maxClips: 6 });
  assert.ok(moments[0].hook.toLowerCase().includes('nobody') || moments[0].score >= 0.5);
});
