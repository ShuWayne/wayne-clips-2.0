import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema, NotConfigured, askJson } from '../packages/shared/claude.mjs';

test('schema validator catches wrong shapes', () => {
  const schema = { type: 'object', required: ['moments'], properties: { moments: { type: 'array', minItems: 1, items: { type: 'object', required: ['start', 'score'], properties: { start: { type: 'number', minimum: 0 }, score: { type: 'number', minimum: 0, maximum: 1 } } } } } };
  assert.deepEqual(validateAgainstSchema({ moments: [{ start: 1, score: 0.5 }] }, schema), []);
  assert.ok(validateAgainstSchema({}, schema).some(p => p.includes('moments')));
  assert.ok(validateAgainstSchema({ moments: [{ start: 1, score: 2 }] }, schema).some(p => p.includes('score')));
  assert.ok(validateAgainstSchema({ moments: [{ start: -1, score: 0.5 }] }, schema).some(p => p.includes('start')));
  assert.ok(validateAgainstSchema({ moments: 'nope' }, schema).length > 0);
});

test('askJson without a key throws NotConfigured and never fakes a reply', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(
    askJson({ system: 'x', user: 'y', name: 'test', schema: { type: 'object', properties: {} } }),
    err => err instanceof NotConfigured,
  );
});
