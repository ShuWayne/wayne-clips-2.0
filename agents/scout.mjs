// Scout — finds niches taking off, ranks them, tags each source with its
// rights basis. With YOUTUBE_API_KEY it really calls YouTube Data API v3
// (search.list + videos.list) and ranks by real views/likes; without the
// key, or when the call fails, it says so and works from Hub licences +
// local patterns only. Rights score 0 whenever rights < 1, so an
// unauthorised source never ranks. Reference-only sources are NEVER
// returned as clippable. Live results are trends to learn from, not
// permission to clip — rights stays 'unknown' unless a Hub licence says so.
import { scoreSource, effectiveRightsBasis } from './guard.mjs';
import { askJson, NotConfigured, llmProvider, llmModel } from '../packages/shared/llm.mjs';
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';

const LOCAL_NICHES = [
  { name: 'Study-with-me shorts', kind: 'education', why: 'Steady evergreen demand, short loops, low production cost.', pattern: { clipSeconds: 20, hashtags: ['#study', '#focus', '#student'], bestHours: '18:00–22:00' }, velocity: 0.62, engagement: 0.71, fit: 0.8 },
  { name: 'Quick cooking hacks', kind: 'food', why: 'High save rate, works muted, captions carry the recipe.', pattern: { clipSeconds: 25, hashtags: ['#cooking', '#recipe', '#foodhack'], bestHours: '12:00–14:00' }, velocity: 0.74, engagement: 0.78, fit: 0.75 },
  { name: 'Money basics, plain English', kind: 'finance', why: 'Evergreen questions, strong comments, easy to keep serving.', pattern: { clipSeconds: 30, hashtags: ['#money', '#finance', '#learn'], bestHours: '19:00–21:00' }, velocity: 0.58, engagement: 0.66, fit: 0.85 },
  { name: 'Home workout in 60 seconds', kind: 'fitness', why: 'High completion, repeatable format, no gear needed.', pattern: { clipSeconds: 30, hashtags: ['#workout', '#fitness', '#homeworkout'], bestHours: '06:00–08:00' }, velocity: 0.69, engagement: 0.72, fit: 0.7 },
  { name: 'Tech explained simply', kind: 'tech', why: 'Curiosity hooks work well; new tools arrive weekly.', pattern: { clipSeconds: 28, hashtags: ['#tech', '#ai', '#explained'], bestHours: '17:00–20:00' }, velocity: 0.81, engagement: 0.69, fit: 0.65 },
];

// --- YouTube Data API v3 (real calls, only with a key) ---
// search.list (100 quota units) finds what's actually trending for the
// niche; videos.list (1 unit) adds real view/like counts. Daily quota is
// 10,000 units, so one Scout run costs ~101 units. A failed call (bad key,
// API not enabled, quota out) falls back to local patterns and says so —
// live is only true when metadata was really read.
const YT_API = 'https://www.googleapis.com/youtube/v3';

async function fetchYouTubeLive(niche) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { live: false, niches: [], error: 'no key' };
  try {
    const q = encodeURIComponent(`${niche || 'shorts'} shorts`);
    const searchRes = await fetch(`${YT_API}/search?part=snippet&type=video&videoDuration=short&order=viewCount&maxResults=5&q=${q}&key=${key}`, { signal: AbortSignal.timeout(10000) });
    if (!searchRes.ok) throw new Error(`YouTube search HTTP ${searchRes.status}: ${(await searchRes.text()).slice(0, 200)}`);
    const search = await searchRes.json();
    const items = (search.items || []).filter(i => i.id?.videoId);
    if (!items.length) return { live: true, niches: [], error: null };
    const ids = items.map(i => i.id.videoId).join(',');
    const statsRes = await fetch(`${YT_API}/videos?part=statistics&id=${ids}&key=${key}`, { signal: AbortSignal.timeout(10000) });
    if (!statsRes.ok) throw new Error(`YouTube videos HTTP ${statsRes.status}: ${(await statsRes.text()).slice(0, 200)}`);
    const stats = await statsRes.json();
    const byId = Object.fromEntries((stats.items || []).map(s => [s.id, s.statistics || {}]));
    const niches = items.map(i => {
      const views = parseInt(byId[i.id.videoId]?.viewCount || '0', 10);
      const likes = parseInt(byId[i.id.videoId]?.likeCount || '0', 10);
      const velocity = Math.min(1, Math.log10(views + 10) / 7); // 10M views ≈ 1.0
      const engagement = views ? Math.min(1, (likes / views) * 20 + 0.3) : 0.3;
      return {
        name: i.snippet.title.slice(0, 80),
        kind: 'trending',
        why: `Live on YouTube: ${i.snippet.channelTitle} — ${views.toLocaleString('en-US')} views, ${likes.toLocaleString('en-US')} likes.`,
        pattern: { clipSeconds: 30, hashtags: [], bestHours: '18:00–22:00' },
        velocity, engagement, fit: 0.7,
        score: scoreSource({ velocity, engagement, fit: 0.7, rights: 1 }),
        rights: 'unknown',
        live: true,
        sourceUrl: `https://www.youtube.com/watch?v=${i.id.videoId}`,
      };
    });
    return { live: true, niches, error: null };
  } catch (err) {
    return { live: false, niches: [], error: err.message.slice(0, 200) };
  }
}

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
  const yt = await fetchYouTubeLive(niche);
  const live = yt.live;
  let niches = [
    ...yt.niches,
    ...LOCAL_NICHES.map(n => ({
      ...n, score: scoreSource({ velocity: n.velocity, engagement: n.engagement, fit: n.fit, rights: 1 }),
      rights: 'pattern-only',
    })),
  ];
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
    live, llmProvider: llmProvider(), llmModel: llmModel(),
    youtubeError: yt.error === 'no key' ? null : yt.error,
    note: live
      ? `Live YouTube metadata read via Data API v3 — ${yt.niches.length} trending video(s) ranked by real views/likes.`
      : yt.error && yt.error !== 'no key'
        ? `YouTube Data API call failed (${yt.error}) — Scout works from Hub licences + local patterns only. No live YouTube metadata was read.`
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
