// Shared job record — one job.json per job, written after every agent.
// jobs/<id>/job.json is the single source of truth for a job.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const AGENT_IDS = ['scout', 'ingest', 'viral', 'subtitle', 'effects', 'render', 'publish'];
export const AGENT_NAMES = {
  scout: 'Scout', ingest: 'Ingest', viral: 'Viral Moments', subtitle: 'Subtitles',
  effects: 'Effects', render: 'Render + QA', publish: 'Publish',
};
export const AGENT_ROLES = {
  scout: 'Finds niches taking off and rights-cleared sources.',
  ingest: 'Downloads the source, extracts audio, probes resolution, transcribes.',
  viral: 'Scores every moment and picks the clips worth posting.',
  subtitle: 'Word-level captions, safe-area aware, burned in.',
  effects: 'Picks parameterised presets by emotion, never more than the moment needs.',
  render: 'Cuts, reframes, encodes, then checks dimensions, audio and caption safety.',
  publish: 'Writes title, caption and hashtags. Uploads only after your approval.',
};

export function newJob(input, jobsRoot) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id, createdAt: now, updatedAt: now,
    status: 'queued', // queued | running | done | failed
    input: {
      sourceUrl: input.sourceUrl || null,
      sourceFile: input.sourceFile || null, // filename inside the job dir
      rightsConfirmed: !!input.rightsConfirmed,
      rightsBasis: input.rightsBasis || 'user_asserted',
      formats: input.formats || ['9:16'],
      resolutions: input.resolutions || ['1080p'],
      niche: input.niche || '',
      uploadMode: input.uploadMode || 'review',
      pageId: input.pageId || null,
      licenceId: input.licenceId || null,
      captionStyle: input.captionStyle || 'pop',
    },
    agents: {},
    events: [],
    clips: [],
    drafts: [],
    dir: `jobs/${id}`,
  };
  for (const a of AGENT_IDS) {
    job.agents[a] = { status: 'pending', attempts: 0, output: null, error: null, lastLine: 'Waiting.' };
  }
  job.dirAbs = join(jobsRoot, id);
  return job;
}

export async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  const { dirAbs, ...persisted } = job;
  await mkdir(job.dirAbs, { recursive: true });
  await writeFile(join(job.dirAbs, 'job.json'), JSON.stringify(persisted, null, 2));
  return job;
}

export async function loadJob(jobsRoot, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    const raw = await readFile(join(jobsRoot, id, 'job.json'), 'utf8');
    const job = JSON.parse(raw);
    job.dirAbs = join(jobsRoot, id);
    return job;
  } catch { return null; }
}

export function logEvent(job, agent, status, message, emit) {
  const ev = { id: job.events.length + 1, agent, status, message, createdAt: new Date().toISOString() };
  job.events.push(ev);
  if (agent && job.agents[agent]) job.agents[agent].lastLine = message;
  if (emit) emit({ type: 'log', ...ev });
  return ev;
}

export function setAgent(job, agent, status, output = undefined, error = undefined, emit) {
  const a = job.agents[agent];
  a.status = status;
  if (output !== undefined) a.output = output;
  if (error !== undefined) a.error = error;
  if (emit) emit({ type: 'status', agent, status, attempt: a.attempts, message: a.lastLine || '' });
}

// --- Publish ledger: one upload per clip per platform, on disk. ---
export async function ledgerPath(dataRoot) { return join(dataRoot, 'publish-ledger.json'); }
export async function readLedger(dataRoot) {
  try { return JSON.parse(await readFile(await ledgerPath(dataRoot), 'utf8')); }
  catch { return { approvals: [] }; }
}
export async function writeLedger(dataRoot, ledger) {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(await ledgerPath(dataRoot), JSON.stringify(ledger, null, 2));
}
export function ledgerKey(jobId, rank, platform) { return `${jobId}:${rank}:${platform.toLowerCase()}`; }
export function countApprovalsToday(ledger) {
  const today = new Date().toISOString().slice(0, 10);
  return ledger.approvals.filter(a => a.date === today).length;
}
