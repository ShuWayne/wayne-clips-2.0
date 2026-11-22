// Render + QA — cut, reframe, effects, captions, encode with ffmpeg,
// then REAL QA with ffprobe (dimensions, duration, audio present/sync,
// black frames) + subtitle safe-area check. Auto-fix loop: caption font
// x0.85, then safe mode. Contact-sheet JPEG per clip. Exports above the
// source resolution are flagged upscaled xN.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffprobe, blackframeSeconds, run } from '../packages/shared/media.mjs';
import { logEvent, setAgent, saveJob } from '../packages/shared/job.mjs';
import { buildAss, checkAssSafeArea } from './subtitle.mjs';

const RES = { '1080p': { w: 1080, h: 1920 }, '4K': { w: 2160, h: 3840 }, '8K': { w: 4320, h: 7680 } };

export function reframeFilter(sourceW, sourceH, target, mode, clip) {
  const { w, h } = RES[target];
  if (mode === 'keyframed') {
    // Crop X follows keyframes: linear drift from x0 to x1 across the clip.
    const cropW = Math.round(sourceH * 9 / 16);
    const x0 = Math.round(((clip.cropX0 ?? 44.3) / 100) * (sourceW - cropW));
    const x1 = Math.round(((clip.cropX1 ?? 52.8) / 100) * (sourceW - cropW));
    const dur = Math.max(1, clip.end - clip.start);
    return `crop=${cropW}:${sourceH}:x='${x0}+(${x1}-${x0})*min(t/${dur.toFixed(2)},1)':y=0,scale=${w}:${h}`;
  }
  if (sourceW > sourceH) {
    // 16:9 source -> 9:16: blur-pad by default (sharp video over blurred copy).
    return `split[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:5[bg];[b]scale=${w}:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
}

function effectChain(clip, effects, target, fontScale) {
  const parts = [];
  for (const e of effects || []) {
    if (e.id === 'slow-push') continue; // handled by keyframed reframe
    if (e.id === 'fade-in-out') {
      const dur = (clip.end - clip.start).toFixed(2);
      parts.push(`fade=t=in:st=0:d=0.4,fade=t=out:st=${(dur - 0.4).toFixed(2)}:d=0.4`);
    } else if (e.draw) parts.push(e.draw);
  }
  return parts;
}

export async function renderClip(job, clip, { attempt = 1 } = {}) {
  const dir = job.dirAbs;
  const ingest = job.agents.ingest.output;
  const source = join(dir, ingest.sourceFile);
  const target = (job.input.resolutions || ['1080p'])[0];
  const { w, h } = RES[target];
  const upscaled = ingest.probe.height < h ? +(h / ingest.probe.height).toFixed(1) : 1;
  const mode = clip.reframeMode || (ingest.probe.width > ingest.probe.height ? 'blur-pad' : 'center');
  const outFile = join(dir, `clip-${clip.rank}.mp4`);
  const assFile = join(dir, `clip-${clip.rank}.ass`);
  // Rebuild ASS with the current font scale (auto-fix loop shrinks it).
  const words = ingest.transcript.words || [];
  const ass = buildAss(clip, words, { style: clip.captionStyle || job.input.captionStyle || 'pop', fontScale: clip.fontScale || 1 });
  await writeFile(assFile, ass);

  const vf = [];
  const rf = reframeFilter(ingest.probe.width, ingest.probe.height, target, mode, clip);
  vf.push(rf);
  const fx = (job.agents.effects.output?.perClip || []).find(p => p.rank === clip.rank)?.effects || [];
  if (attempt === 1) vf.push(...effectChain(clip, fx, target, clip.fontScale || 1));
  // Subtitles LAST in the chain (safe mode drops effects, keeps captions).
  vf.push(`subtitles='${assFile.replace(/'/g, "'\\\\''")}':force_style='Fontname=Anton,Fontsize=${Math.round(64 * (clip.fontScale || 1))},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Alignment=5,MarginV=90'`);
  const dur = (clip.end - clip.start).toFixed(2);
  const args = ['-y', '-v', 'error', '-ss', String(clip.start), '-to', String(clip.end),
    '-i', source, '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-t', dur, outFile];
  await run('ffmpeg', args, { timeoutMs: 600000 });
  return { outFile, target, upscaled, mode, assFile };
}

export async function qaClip(job, clip, outFile) {
  const problems = [];
  const warnings = [];
  const probe = await ffprobe(outFile);
  const { w, h } = RES[(job.input.resolutions || ['1080p'])[0]];
  if (probe.width !== w || probe.height !== h) problems.push(`dimensions ${probe.width}x${probe.height} != ${w}x${h}`);
  const expected = clip.end - clip.start;
  if (Math.abs(probe.duration - expected) > 0.6) problems.push(`duration ${probe.duration.toFixed(2)}s != expected ${expected.toFixed(2)}s`);
  if (!probe.hasAudio) problems.push('no audio stream');
  if (probe.hasAudio && probe.audioDuration !== null && Math.abs(probe.audioDuration - probe.videoDuration) > 0.5) {
    warnings.push(`audio/video duration drift ${(probe.audioDuration - probe.videoDuration).toFixed(2)}s`);
  }
  const black = await blackframeSeconds(outFile);
  if (black !== null && black > 1) warnings.push(`${black.toFixed(1)}s of black frames detected`);
  const assText = await import('node:fs/promises').then(fs => fs.readFile(join(job.dirAbs, `clip-${clip.rank}.ass`), 'utf8').catch(() => ''));
  problems.push(...checkAssSafeArea(assText));
  return { probe, problems, warnings };
}

export async function makePosterAndSheet(job, clip) {
  const dir = job.dirAbs;
  const outFile = join(dir, `clip-${clip.rank}.mp4`);
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', outFile, '-frames:v', '1', '-q:v', '3', join(dir, `clip-${clip.rank}.jpg`)], { timeoutMs: 60000 });
  await run('ffmpeg', ['-y', '-v', 'error', '-i', outFile, '-vf', 'fps=1,scale=360:640,tile=3x2', '-frames:v', '1', '-q:v', '4', join(dir, `clip-${clip.rank}-sheet.jpg`)], { timeoutMs: 120000 });
}

export async function runRender(job, ctx, { onlyRank = null, overrides = null } = {}) {
  const { emit } = ctx;
  const clips = (job.clips || []).filter(c => !onlyRank || c.rank === onlyRank);
  if (!clips.length) throw new Error('Render ran with no clips');
  const results = [];
  for (const clip of clips) {
    if (overrides) {
      if (overrides.captionText) { clip.captionText = overrides.captionText; clip.hook = overrides.captionText; }
      if (overrides.captionStyle) clip.captionStyle = overrides.captionStyle;
      if (overrides.fontScale) clip.fontScale = overrides.fontScale;
      if (overrides.cropKeyframes?.length) {
        clip.cropX0 = overrides.cropKeyframes[0]?.x ?? clip.cropX0;
        clip.cropX1 = overrides.cropKeyframes[overrides.cropKeyframes.length - 1]?.x ?? clip.cropX1;
        clip.reframeMode = 'keyframed';
      }
      if (overrides.grade) clip.grade = overrides.grade;
    }
    let attempt = 1, qa = null, rendered = null, fixed = null;
    while (attempt <= 3) {
      rendered = await renderClip(job, clip, { attempt });
      qa = await qaClip(job, clip, rendered.outFile);
      if (!qa.problems.length) break;
      if (attempt === 1 && qa.problems.some(p => p.includes('font'))) {
        clip.fontScale = +(clip.fontScale || 1) * 0.85;
        fixed = 'caption font x0.85';
        logEvent(job, 'render', 'running', `Render: clip #${clip.rank} QA failed (${qa.problems.join('; ')}) — auto-fix: caption font x0.85, re-rendering.`, emit);
      } else if (attempt === 2) {
        fixed = 'safe mode (effects dropped, plain captions)';
        job.agents.effects.output = job.agents.effects.output || { perClip: [] };
        job.agents.effects.output.perClip = (job.agents.effects.output.perClip || []).filter(p => p.rank !== clip.rank);
        logEvent(job, 'render', 'running', `Render: clip #${clip.rank} QA still failing — auto-fix: safe mode, re-rendering.`, emit);
      } else break;
      attempt++;
    }
    const ok = qa && !qa.problems.length;
    await makePosterAndSheet(job, clip).catch(() => {});
    const rec = {
      rank: clip.rank, file: `clip-${clip.rank}.mp4`, poster: `clip-${clip.rank}.jpg`,
      sheet: `clip-${clip.rank}-sheet.jpg`, target: rendered.target,
      upscaled: rendered.upscaled, mode: rendered.mode,
      duration: qa?.probe?.duration ?? null,
      width: qa?.probe?.width ?? null, height: qa?.probe?.height ?? null,
      hasAudio: qa?.probe?.hasAudio ?? false,
      qa: ok ? ['passed'] : qa.problems,
      warnings: qa?.warnings || [],
      autoFixed: fixed,
      captionText: clip.captionText, captionStyle: clip.captionStyle || job.input.captionStyle,
      fontScale: clip.fontScale || 1,
    };
    results.push(rec);
    logEvent(job, 'render', ok ? 'done' : 'failed',
      `Render: clip #${clip.rank} ${ok ? `done — ${rec.width}x${rec.height}, ${rec.duration?.toFixed(1)}s, audio ${rec.hasAudio ? 'yes' : 'NO'}${rec.upscaled > 1 ? `, upscaled x${rec.upscaled}` : ''}${fixed ? ` (auto-fixed: ${fixed})` : ''}` : `FAILED QA — ${qa.problems.join('; ')}`}`, emit);
  }
  const prev = job.agents.render.output?.results || [];
  const merged = onlyRank ? [...prev.filter(r => r.rank !== onlyRank), ...results] : results;
  const output = { results: merged };
  job.agents.render.output = output;
  setAgent(job, 'render', results.every(r => r.qa[0] === 'passed') ? 'done' : 'degraded', output, null, emit);
  await saveJob(job);
  return output;
}
