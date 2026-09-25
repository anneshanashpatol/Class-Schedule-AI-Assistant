import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstruction, testModel } from '../server/model';
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

test('连接失败时不向页面暴露底层网络异常', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('private network detail'); };
  try {
    await assert.rejects(testModel(await configuredEnv()), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.code, 'MODEL_NETWORK_ERROR');
      assert.doesNotMatch(error.message, /private network detail/);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('连接测试只请求少量输出 token', async () => {
  const originalFetch = globalThis.fetch;
  let requestedTokens = 0;
  let redirectMode = '';
  globalThis.fetch = async (_input, init) => {
    requestedTokens = JSON.parse(String(init?.body)).max_tokens;
    redirectMode = init?.redirect ?? '';
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  try {
    assert.deepEqual(await testModel(await configuredEnv()), { connected: true });
    assert.ok(requestedTokens <= 512);
    assert.equal(redirectMode, 'manual');
  } finally { globalThis.fetch = originalFetch; }
});

test('模型接口重定向时拒绝转发密钥', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/collect' } });
  try {
    await assert.rejects(testModel(await configuredEnv()), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.code, 'MODEL_REDIRECT');
      assert.match(error.message, /重定向/);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('模型把可省略字段返回为 null 时仍能解析排课', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    question: '', actions: [{ kind: 'schedule_create', fields: {
      teacherName: '丁茗辉', studentNames: ['王康凯'], subject: '数学', classDate: '2026-09-27', startTime: '10:00', endTime: '12:00', classroom: null,
    }, repeatWeeks: null }],
  }) } }] });
  try {
    const result = await parseInstruction(await configuredEnv(), '27号排课', []);
    assert.equal(result.question, undefined);
    assert.deepEqual(result.actions, [{ kind: 'schedule_create', fields: {
      teacherName: '丁茗辉', studentNames: ['王康凯'], subject: '数学', classDate: '2026-09-27', startTime: '10:00', endTime: '12:00',
    } }]);
  } finally { globalThis.fetch = originalFetch; }
});
