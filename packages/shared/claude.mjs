// askJson — the ONE Claude helper. Forced tool call with a JSON schema,
// reply validated against the schema. A wrong shape fails loudly and is
// logged. Without ANTHROPIC_API_KEY every call throws NotConfigured and the
// caller must use its honest heuristic fallback (and say so in the log).
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export class NotConfigured extends Error { constructor(msg) { super(msg); this.code = 'NOT_CONFIGURED'; } }
export class SchemaMismatch extends Error { constructor(msg) { super(msg); this.code = 'SCHEMA_MISMATCH'; } }

const API_URL = 'https://api.anthropic.com/v1/messages';

export async function askJson({ system, user, name, schema, model, runsDir }) {
  const key = process.env.ANTHROPIC_API_KEY;
  const t0 = Date.now();
  const note = { step: name, ok: false, ms: 0, in_tok: 0, out_tok: 0, note: '' };
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
    note.note = 'no ANTHROPIC_API_KEY — caller must use heuristic fallback';
    await logRun();
    throw new NotConfigured('ANTHROPIC_API_KEY is not set');
  }
  const tool = {
    name: 'structured_output',
    description: 'Return exactly the requested JSON object.',
    input_schema: schema,
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'structured_output' },
    }),
  });
  if (!res.ok) {
    note.note = `Claude API HTTP ${res.status}`;
    await logRun();
    throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  note.in_tok = data.usage?.input_tokens || 0;
  note.out_tok = data.usage?.output_tokens || 0;
  const call = data.content?.find(c => c.type === 'tool_use' && c.name === 'structured_output');
  if (!call) {
    note.note = 'no forced tool call in reply';
    await logRun();
    throw new SchemaMismatch('Claude did not return the forced tool call');
  }
  const problems = validateAgainstSchema(call.input, schema);
  if (problems.length) {
    note.note = `schema mismatch: ${problems.join('; ')}`;
    await logRun();
    throw new SchemaMismatch(`Claude output failed schema validation: ${problems.join('; ')}`);
  }
  note.ok = true;
  await logRun();
  return call.input;
}

// Minimal JSON-schema validator: required, types, enums, ranges, items.
// Enough to fail loudly on a wrong shape; not a full JSON Schema engine.
export function validateAgainstSchema(value, schema, path = '$') {
  const problems = [];
  if (!schema || typeof schema !== 'object') return problems;
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${path} is not an object`); return problems;
    }
    for (const req of schema.required || []) {
      if (!(req in value)) problems.push(`${path}.${req} is required`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) problems.push(...validateAgainstSchema(value[k], sub, `${path}.${k}`));
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { problems.push(`${path} is not an array`); return problems; }
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path} has more than ${schema.maxItems} items`);
    for (let i = 0; i < value.length; i++) problems.push(...validateAgainstSchema(value[i], schema.items || {}, `${path}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') problems.push(`${path} is not a string`);
    else {
      if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path} is too short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path} is too long`);
      if (schema.enum && !schema.enum.includes(value)) problems.push(`${path} not in enum ${schema.enum.join(',')}`);
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || (schema.type === 'integer' && !Number.isInteger(value))) problems.push(`${path} is not a ${schema.type}`);
    else {
      if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} < ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path} > ${schema.maximum}`);
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${path} is not a boolean`);
  }
  return problems;
}
