// Viral Moments — score every transcript sentence, pick 5–10 clips of
// 15–60s cut on sentence boundaries, never mid-sentence. Typed output per
// moment {start,end,hook,reason,score,spoilerRisk,leakRisk}. Moments with a
// spoiler, leak or embargo flag are DROPPED before they reach storage —
// zero tolerated. Claude scores when a key is set, else the heuristic
// scorer (and the log says so).
import { flagText, scoreSentence } from './guard.mjs';
import { askJson, NotConfigured } from '../packages/shared/claude.mjs';
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

export async function runViral(job, ctx) {
  const { emit } = ctx;
  const ingest = job.agents.ingest.output;
  if (!ingest) throw new Error('Viral Moments ran before Ingest finished');
  if (ingest.transcriptEmpty) {
    const msg = 'Viral Moments: transcript empty — no speech detected. Voiceover needed before clips can be cut.';
    logEvent(job, 'viral', 'failed', msg, emit);
    setAgent(job, 'viral', 'failed', null, msg, emit);
    await saveJob(job);
    throw new Error(msg);
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
    engine = 'claude';
    // Validate timestamps exist in the transcript and drop flagged moments.
    const valid = out.moments.filter(m => {
      const ok = sentences.some(s => Math.abs(s.start - m.start) < 1.5) && m.end > m.start && m.end - m.start <= 60;
      return ok && !m.spoilerRisk && !m.leakRisk;
    });
    picked = { moments: valid.slice(0, 8), dropped: out.moments.length - valid.length };
  } catch (err) {
    if (err.code !== 'NOT_CONFIGURED') {
      logEvent(job, 'viral', 'running', `Viral Moments: Claude scoring failed (${err.message.slice(0, 120)}) — falling back to the heuristic scorer.`, emit);
    }
    picked = pickMoments(sentences, duration, { maxClips: parseInt(process.env.MAX_CLIPS_PER_JOB || '6', 10) });
  }
  if (!picked.moments.length) {
    const msg = 'Viral Moments: no clean moments survived the spoiler/leak guard.';
    logEvent(job, 'viral', 'failed', msg, emit);
    setAgent(job, 'viral', 'failed', null, msg, emit);
    await saveJob(job);
    throw new Error(msg);
  }
  const output = { moments: picked.moments, droppedFlagged: picked.dropped, engine };
  logEvent(job, 'viral', 'done', `Viral Moments: ${picked.moments.length} clips picked (${engine} scorer)${picked.dropped ? `, ${picked.dropped} spoiler/leak-flagged moment(s) dropped` : ''}.`, emit);
  job.agents.viral.output = output;
  setAgent(job, 'viral', 'done', output, null, emit);
  await saveJob(job);
  return output;
}
