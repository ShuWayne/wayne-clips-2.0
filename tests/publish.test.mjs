import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftFor, approvePublish } from '../agents/publish.mjs';
import { readLedger } from '../packages/shared/job.mjs';

const clip = { rank: 1, captionText: 'THIS CHANGES EVERYTHING', hook: 'THIS CHANGES EVERYTHING' };

test('drafts carry title, caption and hashtags per platform', () => {
  const d = draftFor(clip, 'YouTube', 'study');
  assert.equal(d.platform, 'YouTube');
  assert.ok(d.title.length > 0 && d.title.length <= 100);
  assert.ok(d.caption.length <= 120);
  assert.ok(d.hashtags.length >= 1 && d.hashtags.length <= 5);
  assert.equal(d.status, 'draft');
});

test('approve ledger blocks a second approval for the same clip + platform', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'wc-ledger-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const job = {
    id: '11111111-2222-3333-4444-555555555555', dirAbs: dataRoot, events: [],
    drafts: [draftFor(clip, 'YouTube', 'study'), draftFor(clip, 'Instagram', 'study')],
    agents: { publish: { output: null } },
  };
  const ctx = { emit: () => {}, dataRoot };
  const ok = await approvePublish(job, '1:YouTube', [true, true, true, true, true, true], ctx);
  assert.match(ok.status, /manual export|uploaded/);
  const ledger = await readLedger(dataRoot);
  assert.equal(ledger.approvals.length, 1);
  await assert.rejects(
    approvePublish(job, '1:YouTube', [true, true, true, true, true, true], ctx),
    /already approved|Ledger/,
  );
  // A different platform is still allowed.
  const ok2 = await approvePublish(job, '1:Instagram', [true, true, true, true, true, true], ctx);
  assert.ok(ok2.status);
});

test('approve requires all six checklist items', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'wc-ledger2-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const job = {
    id: '11111111-2222-3333-4444-555555555555', dirAbs: dataRoot, events: [],
    drafts: [draftFor(clip, 'YouTube', 'study')],
    agents: { publish: { output: null } },
  };
  await assert.rejects(
    approvePublish(job, '1:YouTube', [true, true, true, true, true, false], { emit: () => {}, dataRoot }),
    /all six/,
  );
});
