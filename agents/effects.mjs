// Effects — parameterised presets. ONLY presets ffmpeg can actually draw
// are selectable; anything the renderer cannot draw is marked `planned`
// and is NEVER selected. At most 0.5 effects per second of clip.
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';

export const EFFECTS = [
  { id: 'grade-warm', name: 'Warm grade', draw: 'eq=brightness=0.03:saturation=1.15', emotion: 'warm', planned: false },
  { id: 'grade-cool', name: 'Cool grade', draw: 'eq=brightness=0.02:saturation=1.1:contrast=1.05', emotion: 'cool', planned: false },
  { id: 'grade-punch', name: 'Punch grade', draw: 'eq=contrast=1.12:saturation=1.25', emotion: 'energy', planned: false },
  { id: 'fade-in-out', name: 'Fade in/out', draw: 'fade=t=in:st=0:d=0.4,fade=t=out:st=DUR-0.4:d=0.4', emotion: 'any', planned: false },
  { id: 'slow-push', name: 'Slow push (keyframed crop)', draw: 'KEYFRAMED_PUSH', emotion: 'cinematic', planned: false },
  { id: 'vignette', name: 'Vignette', draw: 'vignette=PI*0.35', emotion: 'cinematic', planned: false },
  // Planned only — the renderer cannot draw these yet; never selected.
  { id: 'glitch', name: 'Glitch burst', draw: null, emotion: 'chaos', planned: true, why: 'glitch shader not implemented in the ffmpeg renderer yet' },
  { id: 'speed-ramp', name: 'Speed ramp', draw: null, emotion: 'energy', planned: true, why: 'setpts ramping not wired to the render graph yet' },
  { id: 'face-track', name: 'Face tracking reframe', draw: null, emotion: 'cinematic', planned: true, why: 'face/subject tracking counts as done only when run on real footage and inspected' },
  { id: 'sfx-whoosh', name: 'Whoosh SFX', draw: null, emotion: 'any', planned: true, why: 'no licensed SFX library wired in yet' },
  { id: 'transition-whip', name: 'Whip transition', draw: null, emotion: 'energy', planned: true, why: 'xfade whip not implemented in the render graph yet' },
];

export function selectableEffects() { return EFFECTS.filter(e => !e.planned && e.draw); }

// Pure function — unit-tested. ≤0.5 effects/sec, emotion-matched first.
export function chooseEffects(clip, { emotion = 'energy' } = {}) {
  const dur = Math.max(1, clip.end - clip.start);
  const budget = Math.max(1, Math.floor(dur * 0.5));
  const pool = selectableEffects();
  const matched = pool.filter(e => e.emotion === emotion || e.emotion === 'any');
  const rest = pool.filter(e => e.emotion !== emotion && e.emotion !== 'any');
  const picked = [...matched, ...rest].slice(0, budget);
  return picked.map(e => ({ id: e.id, name: e.name, draw: e.draw }));
}

export async function runEffects(job, ctx) {
  const { emit } = ctx;
  const viral = job.agents.viral.output;
  if (!viral) throw new Error('Effects ran before Viral Moments finished');
  const perClip = (job.clips || viral.moments).map((m, i) => ({
    rank: i + 1,
    effects: chooseEffects(m, { emotion: i % 2 === 0 ? 'energy' : 'cinematic' }),
  }));
  const output = { perClip, plannedExcluded: EFFECTS.filter(e => e.planned).map(e => e.id) };
  logEvent(job, 'effects', 'done', `Effects: presets chosen per clip (≤0.5/sec, ffmpeg-drawable only); ${output.plannedExcluded.length} planned-only presets excluded from selection.`, emit);
  job.agents.effects.output = output;
  setAgent(job, 'effects', 'done', output, null, emit);
  await saveJob(job);
  return output;
}
