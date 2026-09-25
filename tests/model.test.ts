import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testModel } from '../server/model';
import { ApiFailure, type Env } from '../server/core';

async function configuredEnv(): Promise<Env> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('test-key')));
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const row = { endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'XingChenAGI/Xing4.0-29B', key_ciphertext: encode(cipher), key_iv: encode(iv) };
  return { AI_CONFIG_KEY: encode(raw), AI_DB: { prepare: () => ({ first: async () => row }) } as unknown as D1Database } as Env;
}

test('立即发生的模型网络错误不会被显示为超时', async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  let logged = '';
  globalThis.fetch = async () => { throw new TypeError('fetch failed test-key'); };
  console.error = (...parts: unknown[]) => { logged = JSON.stringify(parts); };
  try {
    await assert.rejects(testModel(await configuredEnv()), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.code, 'MODEL_NETWORK_ERROR');
      assert.match(error.message, /无法连接/);
      assert.doesNotMatch(error.message, /超时/);
      return true;
    });
    assert.match(logged, /fetch failed/);
    assert.doesNotMatch(logged, /test-key/);
  } finally { globalThis.fetch = originalFetch; console.error = originalConsoleError; }
});

test('连接测试只请求少量输出 token', async () => {
  const originalFetch = globalThis.fetch;
  let requestedTokens = 0;
  globalThis.fetch = async (_input, init) => {
    requestedTokens = JSON.parse(String(init?.body)).max_tokens;
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  try {
    assert.deepEqual(await testModel(await configuredEnv()), { connected: true });
    assert.ok(requestedTokens <= 512);
  } finally { globalThis.fetch = originalFetch; }
});
