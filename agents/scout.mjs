// Scout — finds niches taking off, ranks them, tags each source with its
// rights basis. Without YOUTUBE_API_KEY there is no live YouTube metadata:
// Scout says so and works from Hub licences + local patterns only. Rights
// score 0 whenever rights < 1, so an unauthorised source never ranks.
// Reference-only sources are NEVER returned as clippable.
import { scoreSource, effectiveRightsBasis } from './guard.mjs';
import { askJson, NotConfigured } from '../packages/shared/claude.mjs';
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';

const LOCAL_NICHES = [
  { name: 'Study-with-me shorts', kind: 'education', why: 'Steady evergreen demand, short loops, low production cost.', pattern: { clipSeconds: 20, hashtags: ['#study', '#focus', '#student'], bestHours: '18:00–22:00' }, velocity: 0.62, engagement: 0.71, fit: 0.8 },
  { name: 'Quick cooking hacks', kind: 'food', why: 'High save rate, works muted, captions carry the recipe.', pattern: { clipSeconds: 25, hashtags: ['#cooking', '#recipe', '#foodhack'], bestHours: '12:00–14:00' }, velocity: 0.74, engagement: 0.78, fit: 0.75 },
  { name: 'Money basics, plain English', kind: 'finance', why: 'Evergreen questions, strong comments, easy to keep serving.', pattern: { clipSeconds: 30, hashtags: ['#money', '#finance', '#learn'], bestHours: '19:00–21:00' }, velocity: 0.58, engagement: 0.66, fit: 0.85 },
  { name: 'Home workout in 60 seconds', kind: 'fitness', why: 'High completion, repeatable format, no gear needed.', pattern: { clipSeconds: 30, hashtags: ['#workout', '#fitness', '#homeworkout'], bestHours: '06:00–08:00' }, velocity: 0.69, engagement: 0.72, fit: 0.7 },
  { name: 'Tech explained simply', kind: 'tech', why: 'Curiosity hooks work well; new tools arrive weekly.', pattern: { clipSeconds: 28, hashtags: ['#tech', '#ai', '#explained'], bestHours: '17:00–20:00' }, velocity: 0.81, engagement: 0.69, fit: 0.65 },
];

export async function runScout({ licences = [], niche = '', ctx }) {
  const cleared = [];
  const referenceOnly = [];
  for (const lic of licences) {
    const basis = effectiveRightsBasis(lic);
    const entry = {
      channel: lic.channel, scope: lic.scope, attribution: lic.attribution,
      expires: lic.expires || null, rightsBasis: basis,
      sourceUrl: lic.sourceUrl || null,
    };
    if (basis === 'reference') referenceOnly.push({ ...entry, note: 'never downloaded — reference only' });
    else cleared.push(entry);
  }
  const live = !!process.env.YOUTUBE_API_KEY;
  let niches = LOCAL_NICHES.map(n => ({
    ...n, score: scoreSource({ velocity: n.velocity, engagement: n.engagement, fit: n.fit, rights: 1 }),
    rights: 'pattern-only',
  }));
  niches.sort((a, b) => b.score - a.score);
  // Optional Claude shortlist — rights default to unknown, never authorised.
  let claudeNotes = null;
  try {
    const out = await askJson({
      system: 'You research short-form niches. Rights is "authorized" ONLY when the source explicitly says clipping is allowed; otherwise "unknown".',
      user: `List 3 niches taking off this week for ${niche || 'general short-form'}. One source URL each.`,
      name: 'scout',
      schema: { type: 'object', required: ['shortlist'], properties: { shortlist: { type: 'array', maxItems: 5, items: { type: 'object', required: ['name', 'kind', 'why', 'rights', 'source_url'], properties: { name: { type: 'string' }, kind: { type: 'string' }, why: { type: 'string' }, rights: { type: 'string', enum: ['authorized', 'unknown'] }, source_url: { type: 'string' } } } } } },
      runsDir: ctx?.runsDir,
    });
    claudeNotes = out.shortlist.map(s => ({ ...s, score: s.rights === 'authorized' ? 0.5 : 0 }));
  } catch (err) {
    claudeNotes = null; // heuristic list above is the fallback; caller reports why.
  }
  return {
    live, claudeAvailable: !!process.env.ANTHROPIC_API_KEY,
    note: live
      ? 'Live YouTube metadata available.'
      : 'No YOUTUBE_API_KEY — Scout works from Hub licences + local patterns only. No live YouTube metadata was read.',
    niches, cleared, referenceOnly, claudeNotes,
    generatedAt: new Date().toISOString(),
  };
}

export async function runScoutAgent(job, ctx) {
  const { emit } = ctx;
  const licences = ctx.licences || [];
  const result = await runScout({ licences, niche: job.input.niche, ctx: { ...ctx, runsDir: job.dirAbs } });
  const output = { niches: result.niches.map(n => n.name), cleared: result.cleared.length, referenceOnly: result.referenceOnly.length, live: result.live };
  logEvent(job, 'scout', 'done', `Scout: opportunity scan recorded — ${result.niches.length} niches ranked, ${result.cleared.length} cleared source(s), ${result.referenceOnly.length} reference-only. ${result.note}`, emit);
  job.agents.scout.output = output;
  setAgent(job, 'scout', 'done', output, null, emit);
  await saveJob(job);
  return output;
}
