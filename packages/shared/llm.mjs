// llm.mjs — the ONE LLM helper for the pipeline. Provider chain, in order:
//   1. Claude (ANTHROPIC_API_KEY) — askJson in claude.mjs
//   2. OpenAI GPT-6 (OPENAI_API_KEY) — Chat Completions, JSON-object mode
//   3. Neither key → NotConfigured; the caller uses its honest heuristic
//      fallback and says so in the job log.
// Same contract as claude.mjs askJson: forced JSON, reply validated against
// the caller's schema. A wrong shape fails loudly, never silently faked.
// GPT-6 model ids (API, Nov 2026): gpt-6.2-sol (everyday, $2/$10 per MTok)
// and gpt-6.2-astra (frontier, $8/$40). OPENAI_MODEL overrides the default.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { askJson as askClaude, NotConfigured, SchemaMismatch, validateAgainstSchema } from './claude.mjs';

export { NotConfigured, SchemaMismatch, validateAgainstSchema };

export const OPENAI_MODEL_DEFAULT = 'gpt-6.2-sol';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function llmProvider() {
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

export function llmModel() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT;
  return null;
}

export function llmLabel() {
  const p = llmProvider();
  return p === 'claude' ? 'Claude' : p === 'openai' ? `GPT-6 (${llmModel()})` : 'heuristic';
}

async function askOpenAI({ system, user, name, schema, runsDir }) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT;
  const t0 = Date.now();
  const note = { step: name, provider: 'openai', model, ok: false, ms: 0, in_tok: 0, out_tok: 0, note: '' };
  const logRun = async () => {
    note.ms = Date.now() - t0;
    if (runsDir) {
      try {
        await mkdir(runsDir, { recursive: true });
        await appendFile(join(runsDir, 'agent.log'), JSON.stringify(note) + '\n');
      } catch { /* logging must never break the job */ }
    }
  };
  if (!key) {
    note.note = 'no OPENAI_API_KEY';
    await logRun();
    throw new NotConfigured('OPENAI_API_KEY is not set');
  }
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: 2048,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n\nReply with a single JSON object matching the requested shape. No other text.` },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    note.note = `OpenAI API HTTP ${res.status}`;
    await logRun();
    throw new Error(`OpenAI API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  note.in_tok = data.usage?.prompt_tokens || 0;
  note.out_tok = data.usage?.completion_tokens || 0;
  const raw = data.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    note.note = 'reply was not JSON';
    await logRun();
    throw new SchemaMismatch('GPT-6 reply was not valid JSON');
  }
  const problems = validateAgainstSchema(parsed, schema);
  if (problems.length) {
    note.note = `schema mismatch: ${problems.join('; ')}`;
    await logRun();
    throw new SchemaMismatch(`GPT-6 output failed schema validation: ${problems.join('; ')}`);
  }
  note.ok = true;
  await logRun();
  return parsed;
}

export async function askJson(opts) {
  const errors = [];
  let lastErr = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await askClaude(opts);
    } catch (err) {
      errors.push(`claude: ${err.message}`);
      lastErr = err;
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      return await askOpenAI(opts);
    } catch (err) {
      errors.push(`openai: ${err.message}`);
      lastErr = err;
    }
  }
  // One provider tried: rethrow its original error unchanged, so callers
  // (and tests) still see its real class and code.
  if (errors.length === 1) throw lastErr;
  if (errors.length) {
    // Keep the last provider's error code (NOT_CONFIGURED / SCHEMA_MISMATCH)
    // so callers can still tell "no key" from "bad reply".
    const err = new Error(`LLM failed (${errors.join(' | ').slice(0, 300)})`);
    if (lastErr?.code) err.code = lastErr.code;
    throw err;
  }
  throw new NotConfigured('neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set');
}
