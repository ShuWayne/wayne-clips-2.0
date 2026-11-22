import test from 'node:test';
import assert from 'node:assert/strict';
import { askJson, NotConfigured, SchemaMismatch, llmProvider, llmModel } from '../packages/shared/llm.mjs';

const SCHEMA = { type: 'object', required: ['score'], properties: { score: { type: 'number', minimum: 0, maximum: 1 } } };
const OPTS = { system: 'x', user: 'y', name: 'test', schema: SCHEMA };

function withEnv(env, fn) {
  const saved = {};
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'CLAUDE_MODEL']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  return fn().finally(restore);
}

function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const okJson = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('provider chain: no keys -> none, Claude first, else GPT-6', async () => {
  await withEnv({}, async () => {
    assert.equal(llmProvider(), 'none');
    assert.equal(llmModel(), null);
  });
  await withEnv({ ANTHROPIC_API_KEY: 'x' }, async () => {
    assert.equal(llmProvider(), 'claude');
    assert.equal(llmModel(), 'claude-sonnet-5-5');
  });
  await withEnv({ OPENAI_API_KEY: 'x' }, async () => {
    assert.equal(llmProvider(), 'openai');
    assert.equal(llmModel(), 'gpt-6.2-sol');
  });
  await withEnv({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' }, async () => {
    assert.equal(llmProvider(), 'claude');
  });
});

test('askJson with no keys throws NotConfigured and never fakes a reply', async () => {
  await withEnv({}, async () => {
    await assert.rejects(askJson(OPTS), err => err instanceof NotConfigured);
  });
});

test('askJson with only an OpenAI key calls GPT-6 (gpt-6.2-sol) and validates the reply', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    const { calls, restore } = stubFetch(async () => okJson({
      choices: [{ message: { content: JSON.stringify({ score: 0.8 }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    try {
      const out = await askJson(OPTS);
      assert.deepEqual(out, { score: 0.8 });
      assert.equal(calls.length, 1);
      assert.ok(String(calls[0].url).includes('api.openai.com'));
      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.model, 'gpt-6.2-sol');
      assert.equal(body.response_format.type, 'json_object');
    } finally { restore(); }
  });
});

test('askJson with only an OpenAI key honours OPENAI_MODEL', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-6.2-astra' }, async () => {
    const { calls, restore } = stubFetch(async () => okJson({
      choices: [{ message: { content: JSON.stringify({ score: 0.5 }) } }],
      usage: {},
    }));
    try {
      await askJson(OPTS);
      assert.equal(JSON.parse(calls[0].opts.body).model, 'gpt-6.2-astra');
    } finally { restore(); }
  });
});

test('askJson rejects a non-JSON GPT-6 reply instead of faking one', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    const { restore } = stubFetch(async () => okJson({
      choices: [{ message: { content: 'not json at all' } }],
      usage: {},
    }));
    try {
      await assert.rejects(askJson(OPTS), err => err instanceof SchemaMismatch);
    } finally { restore(); }
  });
});

test('askJson prefers Claude when both keys exist and never calls OpenAI', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' }, async () => {
    const { calls, restore } = stubFetch(async url => {
      if (String(url).includes('anthropic.com')) {
        return okJson({
          content: [{ type: 'tool_use', name: 'structured_output', input: { score: 0.9 } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    try {
      const out = await askJson(OPTS);
      assert.deepEqual(out, { score: 0.9 });
      assert.equal(calls.length, 1);
      assert.ok(String(calls[0].url).includes('anthropic.com'));
    } finally { restore(); }
  });
});
