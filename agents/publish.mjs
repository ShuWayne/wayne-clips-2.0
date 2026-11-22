// Publish — title, caption and hashtags per platform (Claude when a key
// is set, else heuristic). NOTHING uploads before approval. One upload per
// clip per platform enforced by the on-disk ledger. YouTube uploads only
// when YOUTUBE_ACCESS_TOKEN is set (private by default, retry 3x with
// backoff 5s x attempt); otherwise drafts + manual export, stated in the UI.
// TikTok / Instagram: manual export only (no approved developer app).
import { writeCaption, approvalChecklistValid, APPROVAL_CHECKLIST } from './guard.mjs';
import { backupClipsToTelegram, postJobSnapshot } from './telegram.mjs';
import { askJson, NotConfigured, llmProvider } from '../packages/shared/llm.mjs';
import { logEvent, setAgent, saveJob, readLedger, writeLedger, ledgerKey, countApprovalsToday } from '../packages/shared/job.mjs';

const PLATFORMS = ['YouTube', 'Instagram', 'TikTok'];

export function draftFor(clip, platform, niche) {
  const hook = (clip.captionText || clip.hook || 'Watch this').toLowerCase();
  const title = hook.charAt(0).toUpperCase() + hook.slice(1) + (niche ? ` — ${niche}` : '');
  const tags = ['#shorts', '#viral', ...(niche ? [`#${niche.replace(/[^a-z0-9]/gi, '').toLowerCase()}`] : [])].slice(0, 3);
  // The caption guard throws over 120 chars, and a long transcript
  // sentence can make the hook alone nearly that long — truncate the hook
  // first so Publish can never fail the whole job over caption length.
  const suffix = ' — cut by Wayne.clips.';
  const maxHook = 120 - suffix.length;
  const shortHook = hook.length > maxHook ? hook.slice(0, maxHook - 1).trimEnd() + '…' : hook;
  const { caption } = writeCaption({ text: `${shortHook}${suffix}`, hashtags: tags, platform });
  return { rank: clip.rank, platform, title: title.slice(0, 100), caption, hashtags: tags, status: 'draft' };
}

export async function runPublish(job, ctx) {
  const { emit } = ctx;
  const clips = job.clips || [];
  if (!clips.length) throw new Error('Publish ran with no clips');
  const drafts = [];
  for (const clip of clips) {
    for (const platform of PLATFORMS) drafts.push(draftFor(clip, platform, job.input.niche));
  }
  // Try the LLM (Claude, else GPT-6) for titles/captions; heuristic drafts above are the fallback.
  try {
    const out = await askJson({
      system: 'You write short-form titles, captions and hashtags. Captions ≤120 chars, plain words, no spoilers, no leak claims, never imply a company endorses the page. Sponsored captions must start with "Ad:".',
      user: `Clips: ${clips.map(c => `#${c.rank} ${c.hook}`).join(' | ')}\nNiche: ${job.input.niche || 'general'}\nReturn titles/captions/hashtags per clip per platform.`,
      name: 'publish',
      schema: { type: 'object', required: ['drafts'], properties: { drafts: { type: 'array', items: { type: 'object', required: ['rank', 'platform', 'title', 'caption', 'hashtags'], properties: { rank: { type: 'integer' }, platform: { type: 'string', enum: PLATFORMS }, title: { type: 'string' }, caption: { type: 'string', maxLength: 120 }, hashtags: { type: 'array', items: { type: 'string' }, maxItems: 8 } } } } } },
      runsDir: job.dirAbs,
    });
    for (const d of out.drafts) {
      const slot = drafts.find(x => x.rank === d.rank && x.platform === d.platform);
      if (!slot) continue;
      try {
        const checked = writeCaption({ text: d.caption, hashtags: d.hashtags, platform: d.platform, sponsored: false });
        slot.title = d.title.slice(0, 100); slot.caption = checked.caption; slot.hashtags = checked.hashtags;
      } catch { /* keep the heuristic draft; the guard refused the Claude one */ }
    }
    logEvent(job, 'publish', 'done', `Publish: ${drafts.length} drafts written (${llmProvider() === 'openai' ? 'GPT-6' : 'Claude'} titles/captions, guard-checked). Nothing uploads before your approval; TikTok and Instagram are post-by-hand export only.`, emit);
  } catch (err) {
    const why = err.code === 'NOT_CONFIGURED' ? 'no LLM key (Claude/OpenAI) — heuristic drafts' : `LLM failed (${err.message.slice(0, 100)}) — heuristic drafts`;
    logEvent(job, 'publish', 'done', `Publish: ${drafts.length} drafts written (${why}). Nothing uploads before your approval; TikTok and Instagram are post-by-hand export only.`, emit);
  }
  job.drafts = drafts;
  job.agents.publish.output = { drafts: drafts.length };
  setAgent(job, 'publish', 'done', { drafts: drafts.length }, null, emit);
  await saveJob(job);
  // Telegram backup (never fails the job): finished clips go to Telegram
  // cloud right after render + QA, so they survive a wiped job disk.
  try { await backupClipsToTelegram(job, ctx); } catch { /* backup never fails publish */ }
  // Telegram storage: final snapshot now includes the backup record.
  await postJobSnapshot(job, ctx, { stage: 'publish' });
  return { drafts };
}

export async function approvePublish(job, itemId, checklist, ctx) {
  // itemId: "<rank>:<Platform>"
  const [rankStr, platform] = String(itemId).split(':');
  const rank = parseInt(rankStr, 10);
  if (!rank || !PLATFORMS.includes(platform)) throw Object.assign(new Error('unknown publish item'), { status: 404 });
  if (!approvalChecklistValid(checklist)) {
    throw Object.assign(new Error('all six approval checklist items must be ticked before Approve'), { status: 400 });
  }
  const draft = (job.drafts || []).find(d => d.rank === rank && d.platform === platform);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  if (draft.status !== 'draft') throw Object.assign(new Error('draft already approved'), { status: 409 });
  const ledger = await readLedger(ctx.dataRoot);
  const key = ledgerKey(job.id, rank, platform);
  if (ledger.approvals.some(a => a.key === key)) {
    throw Object.assign(new Error('Ledger: this clip is already approved for that platform — one upload per clip per platform.'), { status: 409 });
  }
  const cap = parseInt(process.env.DAILY_UPLOAD_CAP || '10', 10);
  if (countApprovalsToday(ledger) >= cap) {
    throw Object.assign(new Error(`Daily upload cap reached (${cap}/day)`), { status: 429 });
  }
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  let status = 'approved — ready for manual export (no upload API connected)';
  if (platform === 'YouTube' && token) {
    status = await uploadToYouTube(job, rank, draft, ctx);
  }
  draft.status = status;
  ledger.approvals.push({ key, jobId: job.id, rank, platform, date: new Date().toISOString().slice(0, 10), at: new Date().toISOString(), status });
  await writeLedger(ctx.dataRoot, ledger);
  logEvent(job, 'publish', 'done', `Approved: clip #${rank} for ${platform}. ${status}`, ctx.emit);
  await saveJob(job);
  return { itemId, status };
}

async function uploadToYouTube(job, rank, draft, ctx) {
  const file = `${job.dirAbs}/clip-${rank}.mp4`;
  const { stat } = await import('node:fs/promises');
  const size = (await stat(file)).size;
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify({ snippet: { title: draft.title, description: `${draft.caption}\n\n${draft.hashtags.join(' ')}`, tags: draft.hashtags.map(h => h.replace('#', '')) }, status: { privacyStatus: 'private' } }),
      });
      if (!init.ok) throw new Error(`YouTube init HTTP ${init.status}`);
      const session = init.headers.get('location');
      const { readFile } = await import('node:fs/promises');
      const up = await fetch(session, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: await readFile(file) });
      if (!up.ok) throw new Error(`YouTube upload HTTP ${up.status}`);
      const data = await up.json();
      return `uploaded to YouTube (private) — video ${data.id}`;
    } catch (err) {
      lastErr = err;
      logEvent(job, 'publish', 'running', `Publish: YouTube upload attempt ${attempt} failed (${err.message.slice(0, 120)}) — retrying in ${5 * attempt}s.`, ctx.emit);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
  throw Object.assign(new Error(`YouTube upload failed after 3 attempts: ${lastErr?.message}`), { status: 502 });
}

export { APPROVAL_CHECKLIST };
