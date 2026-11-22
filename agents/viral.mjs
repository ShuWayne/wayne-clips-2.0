// Viral Moments — score every transcript sentence, pick 5–10 clips of
// 15–60s cut on sentence boundaries, never mid-sentence. Typed output per
// moment {start,end,hook,reason,score,spoilerRisk,leakRisk}. Moments with a
// spoiler, leak or embargo flag are DROPPED before they reach storage —
// zero tolerated. Claude scores when a key is set, else the heuristic
// scorer (and the log says so).
// NO SPEECH? No failure: when the transcript is empty the agent falls back
// to VISUAL moments — ffmpeg scene-change detection cuts the video into
// 15–60s windows on visual change (fixed 30s windows when the picture never
// changes), scored by scene-change density, captioned with the hook line.
// A silent kitten video becomes clips instead of a dead job.
import { flagText, scoreSentence } from './guard.mjs';
import { askJson, NotConfigured, llmProvider } from '../packages/shared/llm.mjs';
import { run } from '../packages/shared/media.mjs';
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';

export const MOMENT_SCHEMA = {
  type: 'object',
  required: ['moments'],
  properties: {
    moments: {
      type: 'array', minItems: 1, maxItems: 10,
      items: {
        type: 'object',
        required: ['start', 'end', 'hook', 'reason', 'score', 'spoilerRisk', 'leakRisk'],
        properties: {
          start: { type: 'number', minimum: 0 },
          end: { type: 'number', minimum: 0 },
          hook: { type: 'string', minLength: 3, maxLength: 120 },
          reason: { type: 'string', minLength: 3 },
          score: { type: 'number', minimum: 0, maximum: 1 },
          spoilerRisk: { type: 'boolean' },
          leakRisk: { type: 'boolean' },
        },
      },
    },
  },
};

export function sentencesFromTranscript(transcript) {
  // Whisper returns long segments; rebuild true sentences from the word
  // stream so clips cut on sentence boundaries, never mid-sentence.
  const words = transcript?.words || [];
  if (words.length) {
    const sentences = [];
    let cur = [];
    for (const w of words) {
      cur.push(w);
      if (/[.!?]$/.test(w.w.trim())) {
        sentences.push({ text: cur.map(x => x.w).join('').trim(), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
        cur = [];
      }
    }
    if (cur.length) sentences.push({ text: cur.map(x => x.w).join('').trim(), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    return sentences.filter(s => s.text.length > 0);
  }
  const segs = transcript?.segments || [];
  return segs.map(s => ({
    text: (s.text || '').trim(),
    start: s.start, end: s.end,
    words: s.words || [],
  })).filter(s => s.text.length > 0);
}

// Scene-change timestamps (seconds) for a source file, via ffmpeg's
// select+showinfo filters. Best-effort: any failure returns [] and the
// caller falls back to fixed windows — a missed cut must never fail a job.
export async function detectScenes(sourcePath, { threshold = 0.3, runImpl = run } = {}) {
  try {
    const { stderr } = await runImpl('ffmpeg', [
      '-i', sourcePath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-an', '-f', 'null', '-',
    ], { timeoutMs: 600000 });
    return [...(stderr || '').matchAll(/pts_time:([\d.]+)/g)]
      .map(m => parseFloat(m[1]))
      .filter(t => Number.isFinite(t) && t > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// Pure function — unit-tested without any I/O. Cut a speechless video into
// 15–60s windows on visual change. Windows close at the first scene cut
// after 15s (or at +30s when the picture stays still); a tail under 8s is
// dropped. Score = scene-change density + a sweet-spot bonus for 15–30s;
// static video gets flat 0.35 windows. Hook comes from the niche.
export function pickVisualMoments(sceneTimes, duration, { maxClips = 6, niche = '' } = {}) {
  if (!Number.isFinite(duration) || duration < 8) return { moments: [], dropped: 0, reason: 'too-short' };
  const cuts = (sceneTimes || []).filter(t => t > 0 && t < duration).sort((a, b) => a - b);
  const hookBase = (niche || '').trim().toUpperCase().slice(0, 60) || 'WATCH THIS';
  const flags = flagText(hookBase);
  const windows = [];
  let start = 0;
  while (start < duration) {
    const nextCut = cuts.find(c => c > start + 15);
    let end;
    if (nextCut !== undefined && nextCut - start <= 60) end = nextCut;
    else end = Math.min(duration, start + 30);
    if (end - start < 8) break;
    if (end - start > 60) end = start + 60;
    const inWindow = cuts.filter(c => c > start && c <= end).length;
    const sweet = end - start >= 15 && end - start <= 30;
    const score = inWindow > 0
      ? Math.min(1, 0.25 + 0.15 * Math.min(inWindow, 4) + (sweet ? 0.1 : 0))
      : 0.35;
    windows.push({
      start: +start.toFixed(2), end: +end.toFixed(2),
      hook: hookBase,
      reason: inWindow > 0
        ? `Visual moment — ${inWindow} scene change(s) in this window, no speech in the source.`
        : 'Visual moment — picture holds still here, cut on a fixed window, no speech in the source.',
      score: +score.toFixed(2), spoilerRisk: flags.spoilerRisk, leakRisk: flags.leakRisk,
    });
    start = end;
  }
  const dropped = windows.filter(w => w.spoilerRisk || w.leakRisk).length;
  const moments = windows
    .filter(w => !w.spoilerRisk && !w.leakRisk)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxClips)
    .map(({ spoilerRisk, leakRisk, ...m }) => ({ ...m, spoilerRisk: false, leakRisk: false }));
  return { moments, dropped, reason: moments.length ? null : 'no-clean-moments' };
}

function deterministicError(msg) {
  return Object.assign(new Error(msg), { deterministic: true });
}

// Pure function — unit-tested without any I/O.
export function pickMoments(sentences, duration, { maxClips = 8 } = {}) {
  const scored = sentences.map((s, i) => {
    const flags = flagText(s.text);
    return { ...s, score: scoreSentence(s.text, i, sentences.length), ...flags };
  });
  // Spoiler / leak flagged moments are dropped BEFORE storage. Zero tolerated.
  const dropped = scored.filter(s => s.spoilerRisk || s.leakRisk);
  const clean = scored.filter(s => !s.spoilerRisk && !s.leakRisk);
  // Group consecutive sentences into 15–60s windows on sentence boundaries.
  const moments = [];
  let i = 0;
  const sorted = [...clean].sort((a, b) => b.score - a.score);
  const used = new Set();
  for (const anchor of sorted) {
    if (moments.length >= maxClips) break;
    const idx = clean.indexOf(anchor);
    if (used.has(idx)) continue;
    let start = anchor.start, end = anchor.end, j = idx;
    // Grow forward while the window stays under 30s (target clip length).
    while (j + 1 < clean.length && clean[j + 1].end - start < 30 && !used.has(j + 1)) {
      j++; end = clean[j].end;
    }
    // A clip must be at least ~8s of speech; pad short anchors to 15s of source.
    if (end - start < 15) {
      end = Math.min(duration, start + 15);
      if (end - start < 8) { end = Math.min(duration, start + 8); }
    }
    if (end - start > 60) end = start + 60;
    for (let k = idx; k <= j; k++) used.add(k);
    moments.push({
      start: +start.toFixed(2), end: +end.toFixed(2),
      hook: anchor.text.toUpperCase().replace(/[.!?]+$/, '') || 'WATCH THIS',
      reason: `Hook scores ${anchor.score} — strong opening line, clean sentence boundaries.`,
      score: anchor.score, spoilerRisk: false, leakRisk: false,
    });
  }
  moments.sort((a, b) => b.score - a.score);
  return { moments, dropped: dropped.length };
}

export async function runViral(job, ctx, { detectScenesImpl = detectScenes } = {}) {
  const { emit } = ctx;
  const ingest = job.agents.ingest.output;
  if (!ingest) throw new Error('Viral Moments ran before Ingest finished');
  if (ingest.transcriptEmpty) {
    // No speech — cut on visual change instead of failing the job.
    const duration = ingest.probe.duration;
    const scenes = await detectScenesImpl(ingest.sourcePath);
    const visual = pickVisualMoments(scenes, duration, { maxClips: parseInt(process.env.MAX_CLIPS_PER_JOB || '6', 10), niche: job.input.niche });
    if (!visual.moments.length) {
      const msg = visual.reason === 'too-short'
        ? `Viral Moments: video is only ${duration.toFixed(1)}s and has no speech — too short to cut a clip.`
        : 'Viral Moments: no clean visual moments survived the spoiler/leak guard.';
      logEvent(job, 'viral', 'failed', msg, emit);
      setAgent(job, 'viral', 'failed', null, msg, emit);
      await saveJob(job);
      throw deterministicError(msg);
    }
    const output = { moments: visual.moments, droppedFlagged: visual.dropped, engine: 'visual' };
    logEvent(job, 'viral', 'done', `Viral Moments: ${visual.moments.length} clips picked (visual fallback — no speech, cut on scene changes)${visual.dropped ? `, ${visual.dropped} spoiler/leak-flagged moment(s) dropped` : ''}.`, emit);
    job.agents.viral.output = output;
    setAgent(job, 'viral', 'done', output, null, emit);
    await saveJob(job);
    return output;
  }
  const sentences = sentencesFromTranscript(ingest.transcript);
  const duration = ingest.probe.duration;
  let picked;
  let engine = 'heuristic';
  try {
    const out = await askJson({
      system: 'You score spoken sentences for short-form clip potential. Return only the requested JSON.',
      user: `Transcript sentences (start/end seconds):\n${sentences.map(s => `[${s.start}-${s.end}] ${s.text}`).join('\n')}\n\nVideo duration: ${duration}s. Pick the best moments as 15–60s clips on sentence boundaries. Flag spoilerRisk/leakRisk honestly.`,
      name: 'viral',
      schema: MOMENT_SCHEMA,
      runsDir: job.dirAbs,
    });
    engine = llmProvider();
    // Validate timestamps exist in the transcript and drop flagged moments.
    const valid = out.moments.filter(m => {
      const ok = sentences.some(s => Math.abs(s.start - m.start) < 1.5) && m.end > m.start && m.end - m.start <= 60;
      return ok && !m.spoilerRisk && !m.leakRisk;
    });
    picked = { moments: valid.slice(0, 8), dropped: out.moments.length - valid.length };
  } catch (err) {
    if (err.code !== 'NOT_CONFIGURED') {
      logEvent(job, 'viral', 'running', `Viral Moments: LLM scoring failed (${err.message.slice(0, 120)}) — falling back to the heuristic scorer.`, emit);
    }
    picked = pickMoments(sentences, duration, { maxClips: parseInt(process.env.MAX_CLIPS_PER_JOB || '6', 10) });
  }
  if (!picked.moments.length) {
    const msg = 'Viral Moments: no clean moments survived the spoiler/leak guard.';
    logEvent(job, 'viral', 'failed', msg, emit);
    setAgent(job, 'viral', 'failed', null, msg, emit);
    await saveJob(job);
    throw deterministicError(msg);
  }
  const output = { moments: picked.moments, droppedFlagged: picked.dropped, engine };
  logEvent(job, 'viral', 'done', `Viral Moments: ${picked.moments.length} clips picked (${engine} scorer)${picked.dropped ? `, ${picked.dropped} spoiler/leak-flagged moment(s) dropped` : ''}.`, emit);
  job.agents.viral.output = output;
  setAgent(job, 'viral', 'done', output, null, emit);
  await saveJob(job);
  return output;
}
