import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainFailure, parseInstruction, testModel } from '../server/model';
import { ApiFailure, type Env } from '../server/core';

async function configuredEnv(model = 'XingChenAGI/Xing4.0-29B', endpoint = 'https://api.siliconflow.cn/v1/chat/completions'): Promise<Env> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('test-key')));
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const row = { endpoint, model, key_ciphertext: encode(cipher), key_iv: encode(iv) };
  return { AI_CONFIG_KEY: encode(raw), AI_DB: { prepare: () => ({ first: async () => row }) } as unknown as D1Database } as Env;
}

test('GLM 原生 Tool Call 可提交操作计划且只请求一次模型', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].function.name, 'submit_course_action_plan');
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_course_action_plan' } });
    assert.equal(body.response_format, undefined);
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'submit_course_action_plan',
      arguments: JSON.stringify({ actions: [{ kind: 'schedule_completion', filters: { participantName: '张晓燕', dateFrom: '2026-09-27', dateTo: '2026-09-27', period: 'afternoon' }, completed: true }] }),
    } }] } }] });
  };
  try {
    const plan = await parseInstruction(await configuredEnv('THUDM/GLM-4-9B-0414'), '张晓燕明天下午的课设置成已完课', [], 'ADMIN');
    assert.equal(calls, 1);
    assert.equal(plan.actions[0].kind, 'schedule_completion');
  } finally { globalThis.fetch = originalFetch; }
});

test('完课工具把 completed 放进 filters 时仍能提取并校验', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [{ function: {
    name: 'submit_course_action_plan', arguments: JSON.stringify({ actions: [{ kind: 'schedule_completion',
      filters: { participantName: '小齐', dateFrom: '2026-09-27', dateTo: '2026-09-27', completed: true } }] }),
  } }] } }] });
  try {
    const plan = await parseInstruction(await configuredEnv('THUDM/GLM-4-9B-0414'), '把明天小齐的课改成已完课', [], 'ADMIN');
    assert.deepEqual(plan.actions, [{ kind: 'schedule_completion', filters: {
      participantName: '小齐', dateFrom: '2026-09-27', dateTo: '2026-09-27',
    }, completed: true }]);
  } finally { globalThis.fetch = originalFetch; }
});

test('服务商拒绝 tools 时当次回退一次到 JSON', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (calls === 1) { assert.ok(body.tools); return new Response('', { status: 400 }); }
    assert.equal(body.tools, undefined);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ actions: [], reply: '我可以帮你查课程。' }) } }] });
  };
  try {
    const plan = await parseInstruction(await configuredEnv('THUDM/GLM-4-9B-0414', 'https://api-st.siliconflow.cn/v1/chat/completions'), '你好', [], 'ADMIN');
    assert.equal(calls, 2);
    assert.equal(plan.reply, '我可以帮你查课程。');
  } finally { globalThis.fetch = originalFetch; }
});

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
  let responseFormat: unknown;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requestedTokens = body.max_tokens;
    responseFormat = body.response_format;
    redirectMode = init?.redirect ?? '';
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  try {
    assert.deepEqual(await testModel(await configuredEnv()), { connected: true });
    assert.ok(requestedTokens <= 512);
    assert.equal(redirectMode, 'manual');
    assert.equal(responseFormat, undefined);
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
  let sentPrompt = '';
  let responseFormat: unknown;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sentPrompt = body.messages[0].content;
    responseFormat = body.response_format;
    return Response.json({ choices: [{ message: { content: `\n\`\`\`json\n${JSON.stringify({
    question: '', actions: [{ kind: 'schedule_create', fields: {
      teacherName: '丁茗辉', studentNames: ['王康凯'], subject: '数学', classDate: '2026-09-27', startTime: '10:00', endTime: '12:00', classroom: null,
    }, repeatWeeks: null }],
    })}\n\`\`\`\n` } }] });
  };
  try {
    const result = await parseInstruction(await configuredEnv(), '27号排课', [], 'ADMIN');
    assert.equal(result.question, undefined);
    assert.match(sentPrompt, /当前账号是管理员/);
    assert.deepEqual(responseFormat, { type: 'json_object' });
    assert.deepEqual(result.actions, [{ kind: 'schedule_create', fields: {
      teacherName: '丁茗辉', studentNames: ['王康凯'], subject: '数学', classDate: '2026-09-27', startTime: '10:00', endTime: '12:00',
    } }]);
  } finally { globalThis.fetch = originalFetch; }
});

test('删课输出的筛选结构错误时只重试一次，并保留日期和起止时间', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const content = calls === 1
      ? JSON.stringify({ actions: [{ kind: 'schedule_delete', filters: { classDate: '2026-09-27', teacherName: '丁茗辉', studentNames: ['王康凯'] } }] })
      : JSON.stringify({ actions: [{ kind: 'schedule_delete', filters: { dateFrom: '2026-09-27', dateTo: '2026-09-27', startTime: '10:00', endTime: '12:00', teacherName: '丁茗辉', studentName: '王康凯', subject: '数学' } }] });
    return Response.json({ choices: [{ message: { content } }] });
  };
  try {
    const parsed = await parseInstruction(await configuredEnv(), '9月27日10:00-12:00丁茗辉老师王康凯的数学课删了', [], 'ADMIN');
    assert.equal(calls, 2);
    assert.deepEqual(parsed.actions, [{ kind: 'schedule_delete', filters: { dateFrom: '2026-09-27', dateTo: '2026-09-27', startTime: '10:00', endTime: '12:00', teacherName: '丁茗辉', studentName: '王康凯', subject: '数学' } }]);
  } finally { globalThis.fetch = originalFetch; }
});

test('课程问答可自然回复，并只传最近的页面内对话', async () => {
  const originalFetch = globalThis.fetch;
  let sentConversation: unknown;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sentConversation = JSON.parse(body.messages[1].content).recentConversation;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: '一课时通常按学校设定的时长计算，具体以课程设置为准。', actions: [] }) } }] });
  };
  try {
    const context = [{ role: 'user' as const, text: '你好' }, { role: 'assistant' as const, text: '你好，想聊课程安排吗？' }];
    const parsed = await parseInstruction(await configuredEnv(), '什么是一课时？', context, 'STUDENT');
    assert.deepEqual(sentConversation, context);
    assert.deepEqual(parsed, { actions: [], question: undefined, reply: '一课时通常按学校设定的时长计算，具体以课程设置为准。' });
  } finally { globalThis.fetch = originalFetch; }
});

test('用户补充结束时间时把待补齐排课交给模型合并', async () => {
  const originalFetch = globalThis.fetch;
  let pendingInRequest: unknown;
  globalThis.fetch = async (_input, init) => {
    pendingInRequest = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).pendingActions;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ actions: [{ kind: 'schedule_create', fields: {
      teacherName: '丁茗辉', studentNames: ['王康凯'], subject: '数学', classDate: '2026-09-27', startTime: '10:00', endTime: '12:00',
    } }] }) } }] });
  };
  try {
    const pending = [{ kind: 'schedule_create' as const, fields: { teacherName: '丁茗辉', studentNames: ['王康凯'], subject: '数学', classDate: '2026-09-27', startTime: '10:00' } }];
    const result = await parseInstruction(await configuredEnv(), '12点结束', [{ role: 'assistant', text: '几点结束？' }], 'ADMIN', pending);
    assert.deepEqual(pendingInRequest, pending);
    assert.equal(result.actions[0].kind, 'schedule_create');
    if (result.actions[0].kind === 'schedule_create') assert.equal(result.actions[0].fields.endTime, '12:00');
  } finally { globalThis.fetch = originalFetch; }
});

test('仅执行失败时的补充解释使用短输出，不发送课程或密码', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: { max_tokens: number; messages: { content: string }[] } | undefined;
  globalThis.fetch = async (_input, init) => {
    sentBody = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: '课程已变化，请刷新后重新核对。' } }] });
  };
  try {
    assert.equal(await explainFailure(await configuredEnv(), 'schedule_delete', '目标课程已变化', 0, 2), '课程已变化，请刷新后重新核对。');
    assert.equal(sentBody?.max_tokens, 180);
    assert.match(sentBody?.messages[1].content ?? '', /目标课程已变化/);
  } finally { globalThis.fetch = originalFetch; }
});

test('完课操作的日期、时段和布尔值常见格式可安全归一', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: {
      kind: 'schedule_completion', filters: { classDate: '2026-09-25', participantName: '包梦妍', period: '下午' }, completed: 'true',
    } }) } }] });
  };
  try {
    const parsed = await parseInstruction(await configuredEnv(), '帮我给今天下午包梦妍的课点完课', [], 'ADMIN');
    assert.equal(calls, 1);
    assert.deepEqual(parsed.actions, [{ kind: 'schedule_completion', filters: {
      dateFrom: '2026-09-25', dateTo: '2026-09-25', participantName: '包梦妍', period: 'afternoon',
    }, completed: true }]);
  } finally { globalThis.fetch = originalFetch; }
});

test('模型两次输出不合约定时转为追问，不返回格式错误', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: '{"unknown":"value"}' } }] });
  };
  try {
    const parsed = await parseInstruction(await configuredEnv(), '帮我处理这节课', [], 'ADMIN');
    assert.equal(calls, 2);
    assert.deepEqual(parsed.actions, []);
    assert.match(parsed.question ?? '', /补充/);
  } finally { globalThis.fetch = originalFetch; }
});

test('模型给出冲突日期时不会静默选一个日期执行', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ actions: [{
    kind: 'schedule_completion', filters: { classDate: '2026-09-25', dateFrom: '2026-09-26', participantName: '包梦妍' }, completed: true,
  }] }) } }] });
  try {
    const parsed = await parseInstruction(await configuredEnv(), '把包梦妍的课点完课', [], 'ADMIN');
    assert.deepEqual(parsed.actions, []);
    assert.ok(parsed.question);
  } finally { globalThis.fetch = originalFetch; }
});
