// Orchestrator — run(job, {from, to}). Per-agent retry (2 retries, then
// fallback, otherwise failed), a status event for every change, job
// persisted to jobs/<id>/job.json after every agent. Seven agents share
// one job.json; each writes only its own key. Order: scout (pre-job) then
// ingest -> viral -> subtitle -> effects -> render -> publish.
import { logEvent, setAgent, saveJob, AGENT_IDS } from '../shared/job.mjs';
import { runScoutAgent } from '../../agents/scout.mjs';
import { runIngest } from '../../agents/ingest.mjs';
import { runViral } from '../../agents/viral.mjs';
import { runSubtitle } from '../../agents/subtitle.mjs';
import { runEffects } from '../../agents/effects.mjs';
import { runRender } from '../../agents/render.mjs';
import { runPublish } from '../../agents/publish.mjs';

const RUNNERS = { scout: runScoutAgent, ingest: runIngest, viral: runViral, subtitle: runSubtitle, effects: runEffects, render: runRender, publish: runPublish };

export async function run(job, { from = 'scout', to = 'publish', emit, ctx = {} } = {}) {
  const order = AGENT_IDS;
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  job.status = 'running';
  await saveJob(job);
  for (let i = start; i <= end; i++) {
    const id = order[i];
    const runner = RUNNERS[id];
    if (job.agents[id].status === 'done') continue; // resume support
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      job.agents[id].attempts = attempt;
      setAgent(job, id, 'running', undefined, null, emit);
      await saveJob(job);
      try {
        await runner(job, { ...ctx, emit });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        logEvent(job, id, 'failed', `${id}: attempt ${attempt} failed — ${err.message.slice(0, 200)}`, emit);
        await saveJob(job);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    if (lastErr) {
      // Fallbacks: subtitle/effects can degrade; the rest fail the job.
      if (id === 'subtitle' || id === 'effects') {
        logEvent(job, id, 'degraded', `${id}: failed 3 times — continuing with fallback (plain captions / no effects).`, emit);
        setAgent(job, id, 'degraded', null, lastErr.message, emit);
        if (id === 'subtitle') {
          job.clips = (job.agents.viral.output?.moments || []).map((m, k) => ({ ...m, rank: k + 1, captionStyle: job.input.captionStyle, fontScale: 1, captionText: m.hook }));
        }
        await saveJob(job);
        continue;
      }
      setAgent(job, id, 'failed', null, lastErr.message, emit);
      job.status = 'failed';
      logEvent(job, id, 'failed', `Job failed at ${id}: ${lastErr.message.slice(0, 200)}`, emit);
      await saveJob(job);
      if (emit) emit({ type: 'job', status: 'failed', id: job.id });
      return job;
    }
  }
  job.status = 'done';
  logEvent(job, 'publish', 'done', `Job done — ${(job.clips || []).length} clips rendered, ${(job.drafts || []).length} publish drafts waiting for your approval.`, emit);
  await saveJob(job);
  if (emit) emit({ type: 'job', status: 'done', id: job.id });
  return job;
}

// Regenerate one clip with take-over overrides: subtitle + effects +
// render re-run for that rank, then QA. Used by the Studio take-over.
export async function regenerateClip(job, rank, overrides, ctx) {
  const { emit } = ctx;
  const clip = (job.clips || []).find(c => c.rank === rank);
  if (!clip) throw Object.assign(new Error(`clip #${rank} not found`), { status: 404 });
  if (overrides.captionText) { clip.captionText = overrides.captionText; clip.hook = overrides.captionText; }
  if (overrides.captionStyle) clip.captionStyle = overrides.captionStyle;
  if (overrides.fontScale) clip.fontScale = overrides.fontScale;
  if (overrides.cropKeyframes?.length) {
    clip.cropX0 = overrides.cropKeyframes[0]?.x ?? clip.cropX0;
    clip.cropX1 = overrides.cropKeyframes[overrides.cropKeyframes.length - 1]?.x ?? clip.cropX1;
    clip.reframeMode = 'keyframed';
  }
  logEvent(job, 'render', 'running', `Take-over: clip #${rank} regenerating with your overrides (caption, style, crop).`, emit);
  const { runRender } = await import('../../agents/render.mjs');
  await runRender(job, ctx, { onlyRank: rank, overrides });
  // Re-draft publish copy for the regenerated clip.
  const { draftFor } = await import('../../agents/publish.mjs');
  job.drafts = (job.drafts || []).filter(d => d.rank !== rank);
  for (const platform of ['YouTube', 'Instagram', 'TikTok']) job.drafts.push(draftFor(clip, platform, job.input.niche));
  logEvent(job, 'render', 'done', `Take-over: clip #${rank} regenerated with your caption, style and crop overrides.`, emit);
  await saveJob(job);
  return clip;
}
