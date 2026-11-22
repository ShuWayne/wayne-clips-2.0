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
