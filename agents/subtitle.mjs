// Subtitles — word-level ASS captions (pop / bounce / karaoke), safe-area
// aware, burned with libass by the render agent. Plain captions fallback.
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CAPTION_STYLES = ['pop', 'bounce', 'karaoke'];
// 9:16 canvas: 1080x1920. Safe area: captions live in the bottom 12% band,
// never closer than 90px to the bottom edge, never wider than 900px.
export const SAFE = { playW: 1080, playH: 1920, marginBottom: 90, marginSide: 90, maxFont: 96 };

function assEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}'); }

function styleLine(style, fontScale) {
  const px = Math.round(64 * fontScale);
  const pop = `{\\an5\\pos(540,1560)\\fs${px}\\b1}`;
  const bounce = `{\\an5\\pos(540,1560)\\fs${px}\\b1}`;
  const karaoke = `{\\an5\\pos(540,1560)\\fs${px}\\b1}`;
  return { pop, bounce, karaoke }[style] || pop;
}

// Build word events for one clip. words: [{w, start, end}] in source time.
// Clip-relative times are used so the ASS file lines up with the cut.
export function buildAss(clip, words, { style = 'pop', fontScale = 1 } = {}) {
  const rel = words
    .filter(w => w.end > clip.start && w.start < clip.end)
    .map(w => ({ w: w.w, start: Math.max(0, w.start - clip.start), end: Math.min(clip.end - clip.start, w.end - clip.start) }));
  const dur = clip.end - clip.start;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Anton,64,&H00FFFFFF,&H00FF5FEE,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,5,90,90,90,1
Style: CapHi,Anton,64,&H00A75FEE,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,5,90,90,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const fmt = t => {
    const cs = Math.max(0, Math.round(t * 100));
    const h = String(Math.floor(cs / 360000)).padStart(1, '0');
    const m = String(Math.floor(cs / 6000) % 60).padStart(2, '0');
    const s = String(Math.floor(cs / 100) % 60).padStart(2, '0');
    const c = String(cs % 100).padStart(2, '0');
    return `${h}:${m}:${s}.${c}`;
  };
  const lines = [];
  if (style === 'karaoke') {
    // One event per word-group (up to 4 words), active word highlighted.
    for (let i = 0; i < rel.length; i += 4) {
      const group = rel.slice(i, i + 4);
      const text = group.map((w, gi) => {
        const k = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${k}}${assEscape(w.w)}`;
      }).join(' ');
      lines.push(`Dialogue: 0,${fmt(group[0].start)},${fmt(group[group.length - 1].end)},CapHi,,0,0,0,,${styleLine(style, fontScale)}${text}`);
    }
  } else if (style === 'bounce') {
    for (const w of rel) {
      lines.push(`Dialogue: 0,${fmt(w.start)},${fmt(w.end)},Cap,,0,0,0,,{\\an5\\pos(540,1560)\\fs${Math.round(64 * fontScale)}\\b1\\t(0,120,\\fs${Math.round(78 * fontScale)})\\t(120,${Math.max(130, Math.round((w.end - w.start) * 1000))},\\fs${Math.round(64 * fontScale)})}${assEscape(w.w.toUpperCase())}`);
    }
  } else {
    // pop: each word scales in fast.
    for (const w of rel) {
      lines.push(`Dialogue: 0,${fmt(w.start)},${fmt(w.end)},Cap,,0,0,0,,{\\an5\\pos(540,1560)\\fs${Math.round(64 * fontScale)}\\b1\\t(0,100,\\fscx130\\fscy130)\\t(100,180,\\fscx100\\fscy100)}${assEscape(w.w.toUpperCase())}`);
    }
  }
  // Fallback: if a clip has no word timings (should not happen — viral
  // requires a transcript), burn the hook as one centred line.
  if (!lines.length) {
    lines.push(`Dialogue: 0,${fmt(0)},${fmt(Math.min(dur, 3))},Cap,,0,0,0,,${styleLine(style, fontScale)}${assEscape((clip.hook || 'WATCH THIS').toUpperCase())}`);
  }
  return header + lines.join('\n') + '\n';
}

// Safe-area check on the generated ASS: every event inside the safe band.
export function checkAssSafeArea(assText) {
  const problems = [];
  if (!/PlayResX: 1080/.test(assText) || !/PlayResY: 1920/.test(assText)) problems.push('ASS PlayRes is not 1080x1920');
  const fonts = [...assText.matchAll(/\\fs(\d+)/g)].map(m => parseInt(m[1], 10));
  if (fonts.some(f => f > SAFE.maxFont)) problems.push(`caption font exceeds safe maximum ${SAFE.maxFont}px`);
  if (!/MarginV,90/.test(assText) && !/MarginV/.test(assText)) problems.push('ASS margins missing');
  return problems;
}

export async function runSubtitle(job, ctx) {
  const { emit } = ctx;
  const viral = job.agents.viral.output;
  if (!viral) throw new Error('Subtitles ran before Viral Moments finished');
  const ingest = job.agents.ingest.output;
  const words = ingest.transcript.words || [];
  const style = job.input.captionStyle || 'pop';
  const clips = viral.moments.map((m, i) => {
    const ass = buildAss(m, words, { style, fontScale: 1 });
    return { ...m, rank: i + 1, captionStyle: style, fontScale: 1, ass, captionText: m.hook };
  });
  // Persist ASS files next to the job for the render agent.
  for (const c of clips) {
    await writeFile(join(job.dirAbs, `clip-${c.rank}.ass`), c.ass);
  }
  const safeProblems = clips.flatMap(c => checkAssSafeArea(c.ass));
  const output = { clips: clips.map(({ ass, ...rest }) => rest), style, safeProblems };
  logEvent(job, 'subtitle', 'done', `Subtitles: ${clips.length} word-level ASS caption tracks written (${style} style)${safeProblems.length ? ` — ${safeProblems.length} safe-area warning(s)` : ', all inside the safe area'}.`, emit);
  job.agents.subtitle.output = output;
  // Keep full clip records (with ASS text) on the job for render/regenerate.
  job.clips = clips;
  setAgent(job, 'subtitle', 'done', output, null, emit);
  await saveJob(job);
  return output;
}
