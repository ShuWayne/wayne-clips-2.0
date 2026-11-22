import test from 'node:test';
import assert from 'node:assert/strict';
import { runScout } from '../agents/scout.mjs';

test('scout without a YouTube key says so and uses licences + patterns only', async () => {
  delete process.env.YOUTUBE_API_KEY;
  const r = await runScout({ licences: [], niche: '', ctx: {} });
  assert.equal(r.live, false);
  assert.match(r.note, /No YOUTUBE_API_KEY/);
  assert.ok(r.niches.length >= 3);
  assert.ok(r.niches.every(n => n.score > 0));
});

test('scout with a YouTube key really calls Data API v3 and ranks by real views', async () => {
  process.env.YOUTUBE_API_KEY = 'test-key';
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes('/search?')) {
      return { ok: true, status: 200, json: async () => ({ items: [
        { id: { videoId: 'abc123' }, snippet: { title: 'Viral Gym Short', channelTitle: 'GymDaily' } },
        { id: { videoId: 'def456' }, snippet: { title: 'Tiny Cooking Hack', channelTitle: 'KitchenLab' } },
      ] }), text: async () => '' };
    }
    if (String(url).includes('/videos?')) {
      return { ok: true, status: 200, json: async () => ({ items: [
        { id: 'abc123', statistics: { viewCount: '2500000', likeCount: '120000' } },
        { id: 'def456', statistics: { viewCount: '80000', likeCount: '3000' } },
      ] }), text: async () => '' };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const r = await runScout({ licences: [], niche: 'gym', ctx: {} });
    assert.equal(r.live, true);
    assert.match(r.note, /Live YouTube metadata read via Data API v3/);
    assert.ok(calls.some(u => u.includes('youtube/v3/search')));
    assert.ok(calls.some(u => u.includes('youtube/v3/videos')));
    const first = r.niches[0];
    assert.equal(first.name, 'Viral Gym Short');
    assert.equal(first.rights, 'unknown');
    assert.equal(first.sourceUrl, 'https://www.youtube.com/watch?v=abc123');
    assert.match(first.why, /2,500,000 views/);
    assert.ok(first.score > 0);
  } finally {
    globalThis.fetch = orig;
    delete process.env.YOUTUBE_API_KEY;
  }
});

test('scout with a bad YouTube key says the call failed and falls back to patterns', async () => {
  process.env.YOUTUBE_API_KEY = 'bad-key';
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'API key not valid' });
  try {
    const r = await runScout({ licences: [], niche: '', ctx: {} });
    assert.equal(r.live, false);
    assert.match(r.note, /YouTube Data API call failed/);
    assert.ok(r.niches.length >= 3);
    assert.ok(r.niches.every(n => n.rights === 'pattern-only'));
  } finally {
    globalThis.fetch = orig;
    delete process.env.YOUTUBE_API_KEY;
  }
});

test('scout: cleared licences rank, expired licences are reference-only and never clippable', async () => {
  const r = await runScout({
    licences: [
      { channel: '@creator-a', scope: '2026 videos', basis: 'permitted', attribution: 'Footage: @creator-a', expires: '2999-01-01', sourceUrl: 'https://example.com/a.mp4' },
      { channel: '@creator-b', scope: '2024 videos', basis: 'permitted', attribution: 'Footage: @creator-b', expires: '2020-01-01', sourceUrl: 'https://example.com/b.mp4' },
    ],
    niche: '', ctx: {},
  });
  assert.equal(r.cleared.length, 1);
  assert.equal(r.cleared[0].channel, '@creator-a');
  assert.equal(r.referenceOnly.length, 1);
  assert.equal(r.referenceOnly[0].channel, '@creator-b');
  assert.match(r.referenceOnly[0].note, /never downloaded/);
});
