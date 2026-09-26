import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursFromUserWords, planAgentTurn } from '../server/agent';
import { assertSkillRole, detectIntent, skills } from '../server/skills';
import { expandActions } from '../server/workflow';
import { ApiFailure, type Env, type User } from '../server/core';

test('能力表覆盖所有操作，并保留多目的和课程问答判断', () => {
  assert.equal(Object.keys(skills).length, 14);
  assert.deepEqual(detectIntent('下周二排课'), { kind: 'schedule_create', certain: true });
  assert.deepEqual(detectIntent('查剩余课时'), { kind: 'hours_balance', certain: true });
  assert.equal(detectIntent('排课怎么操作').certain, false);
  assert.equal(detectIntent('排课，再查剩余课时').certain, false);
  assert.equal(detectIntent('排课，顺便看一下其他数据').certain, false);
});

test('角色权限由服务端能力表校验', () => {
  assert.throws(() => assertSkillRole('schedule_create', 'STUDENT'),
    (error: unknown) => error instanceof ApiFailure && error.status === 403);
  assert.throws(() => assertSkillRole('schedule_delete', 'TEACHER'),
    (error: unknown) => error instanceof ApiFailure && error.status === 403);
  assert.doesNotThrow(() => assertSkillRole('schedule_completion', 'TEACHER'));
});

async function modelEnv(lessons: unknown[] = []): Promise<Env> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('test-key')));
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const row = { endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'THUDM/GLM-4-9B-0414', key_ciphertext: encode(cipher), key_iv: encode(iv) };
  return { AI_CONFIG_KEY: encode(raw), AI_DB: { prepare: () => ({ first: async () => row }) } as unknown as D1Database,
    MAIN_APP: { fetch: async (request: Request) => {
      const url = new URL(request.url);
      assert.equal(url.searchParams.get('dateFrom'), '2026-09-27');
      assert.equal(url.searchParams.get('dateTo'), '2026-09-27');
      assert.equal(url.searchParams.get('participantName'), null);
      return Response.json({ data: lessons });
    } } as Fetcher } as Env;
}

test('模型选择完课工具后，Worker 用姓名日期时段查真实课程并预览候选', async () => {
  const originalFetch = globalThis.fetch;
  let prompt = '';
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (!body.tools) return Response.json({ choices: [{ message: { content: JSON.stringify({ mode: 'action', request: '张晓燕明天下午的课帮我设置成已完课' }) } }] });
    prompt = body.messages[0].content;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ actions: [{ kind: 'schedule_completion',
      filters: { participantName: '张晓燕', dateFrom: '2026-09-27', dateTo: '2026-09-27', period: 'afternoon' }, completed: true }] }) } }] });
  };
  try {
    const lessons = [
      { id: 1, teacher_name: '张晓燕', student_names: ['李同学'], subject: '数学', class_date: '2026-09-27', start_time: '09:00', end_time: '10:00', classroom: '', is_completed: 0, version: 1 },
      { id: 2, teacher_name: '王老师', student_names: ['张晓燕'], subject: '语文', class_date: '2026-09-27', start_time: '14:00', end_time: '15:00', classroom: '', is_completed: 0, version: 1 },
      { id: 3, teacher_name: '张晓燕', student_names: ['王同学'], subject: '英语', class_date: '2026-09-27', start_time: '16:00', end_time: '17:00', classroom: '', is_completed: 0, version: 1 },
    ];
    const plan = await planAgentTurn(await modelEnv(lessons), new Request('https://qcp.dpdns.org/assistant/api/interpret'),
      { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User,
      '张晓燕明天下午的课帮我设置成已完课', [], []);
    assert.equal(calls, 2);
    assert.match(prompt, /查询真实课程/);
    assert.deepEqual(plan.actions[0].candidates?.map((item) => item.id), [2, 3]);
    assert.equal(plan.actions[0].selected, undefined);
    assert.equal(plan.hasWrites, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('追问后的补充沿用页面目标，同时模型仍可选择其他能力', async () => {
  const originalFetch = globalThis.fetch;
  let prompt = '';
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.tools) return Response.json({ choices: [{ message: { content: JSON.stringify({ mode: 'action', request: '是下午那节' }) } }] });
    prompt = body.messages[0].content;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: '好的，我记得是在找那节课。', actions: [] }) } }] });
  };
  try {
    const plan = await planAgentTurn(await modelEnv(), new Request('https://qcp.dpdns.org/assistant/api/interpret'),
      { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User,
      '是下午那节', [{ role: 'assistant', text: '你说的是哪一节？' }], [], 'schedule_completion');
    assert.equal(plan.intentKind, 'schedule_completion');
    assert.match(prompt, /上轮目标是 schedule_completion/);
    assert.match(prompt, /schedule_completion/);
  } finally { globalThis.fetch = originalFetch; }
});

test('取消刚才的操作会清掉目标，不会误当成撤销完课', async () => {
  const plan = await planAgentTurn({} as Env, new Request('https://qcp.dpdns.org/assistant/api/interpret'),
    { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User,
    '取消刚才的操作', [], [], 'schedule_completion');
  assert.equal(plan.intentKind, undefined);
  assert.deepEqual(plan.actions, []);
  assert.match(plan.reply ?? '', /不继续/);
});

test('礼貌结束不会把上一轮写操作重新交给模型执行', async () => {
  const plan = await planAgentTurn({} as Env, new Request('https://qcp.dpdns.org/assistant/api/interpret'),
    { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User,
    '谢谢，先这样', [{ role: 'assistant', text: '我找到了两节，请选择' }], [], 'schedule_completion');
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.intentKind, undefined);
  assert.match(plan.reply ?? '', /随时/);
});

test('课程助手能力问答只生成自然回复，不重放上一轮工具调用', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.at(-1).content, '你能做什么？');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ mode: 'reply', reply: '我可以帮你查询课程、排课和调整完课状态。' }) } }] });
  };
  try {
    const plan = await planAgentTurn(await modelEnv(), new Request('https://qcp.dpdns.org/assistant/api/interpret'),
      { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User,
      '你能做什么？', [{ role: 'assistant', text: '我找到了两节，请选择' }], [], 'schedule_completion');
    assert.deepEqual(plan.actions, []);
    assert.match(plan.reply ?? '', /查询课程/);
  } finally { globalThis.fetch = originalFetch; }
});

test('问候与纠错默认走对话，不查询管理员或重放旧目标', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools, undefined);
    const input = body.messages.at(-1).content;
    return Response.json({ choices: [{ message: { content: JSON.stringify(input === '你好'
      ? { mode: 'reply', reply: '你好，今天想聊点什么？' }
      : { mode: 'cancel', reply: '抱歉，我理解错了，不会继续查询管理员。' }) } }] });
  };
  try {
    const env = await modelEnv();
    const request = new Request('https://qcp.dpdns.org/assistant/api/interpret');
    const user = { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User;
    const greeting = await planAgentTurn(env, request, user, '你好', [], []);
    assert.deepEqual(greeting.actions, []);
    assert.match(greeting.reply ?? '', /想聊什么/);
    const correction = await planAgentTurn(env, request, user, '我没让你查管理员呀', [
      { role: 'user', text: '你好' }, { role: 'assistant', text: '查到了三个管理员' },
    ], [], 'user_search');
    assert.deepEqual(correction.actions, []);
    assert.equal(correction.intentKind, undefined);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('完课请求先找真实候选，移除模型凭空加的上午条件', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.tools) return Response.json({ choices: [{ message: { content: JSON.stringify({ mode: 'action', request: '把明天学生小齐的英语课改成已完课' }) } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ actions: [{ kind: 'schedule_completion',
      filters: { participantName: '小齐', dateFrom: '2026-09-27', dateTo: '2026-09-27', subject: '英语', period: 'morning' }, completed: true }] }) } }] });
  };
  try {
    const lessons = [
      { id: 1, teacher_name: '李老师', student_names: ['小齐'], subject: '英语', class_date: '2026-09-27', start_time: '10:00', end_time: '11:00', classroom: '', is_completed: 0, version: 1 },
      { id: 2, teacher_name: '王老师', student_names: ['小齐'], subject: '英语', class_date: '2026-09-27', start_time: '14:00', end_time: '15:00', classroom: '', is_completed: 0, version: 1 },
    ];
    const plan = await planAgentTurn(await modelEnv(lessons), new Request('https://qcp.dpdns.org/assistant/api/interpret'),
      { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User,
      '把明天学生：小齐的英语课改成已完课', [], []);
    assert.equal(plan.actions[0].action.kind, 'schedule_completion');
    assert.deepEqual(plan.actions[0].candidates?.map((item) => item.id), [1, 2]);
    assert.equal(plan.actions[0].selected, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('一次只允许一个删除操作', () => {
  assert.throws(() => expandActions([
    { kind: 'schedule_delete', filters: { dateFrom: '2026-09-27' } },
    { kind: 'user_delete', filters: { username: '王老师' } },
  ]), (error: unknown) => error instanceof ApiFailure && error.code === 'BULK_DELETE_UNSUPPORTED');
});

test('课时按用户说的数量换算为后端百分之一课时单位', () => {
  assert.equal(hoursFromUserWords('给小齐增加1个课时'), 100);
  assert.equal(hoursFromUserWords('给小齐添加0.5课时'), 50);
  assert.equal(hoursFromUserWords('给小齐添加0.01课时'), 1);
  assert.equal(hoursFromUserWords('扣除小齐1.25课时'), -125);
  assert.equal(hoursFromUserWords('给小齐减少一个半课时'), -150);
  assert.equal(hoursFromUserWords('给小齐加半课时'), 50);
  assert.equal(hoursFromUserWords('给小齐添加二十课时'), 2000);
  assert.equal(hoursFromUserWords('把小齐余额调整为10课时'), undefined);
  assert.equal(hoursFromUserWords('给小齐增加课时'), undefined);
  assert.equal(hoursFromUserWords('不要给小齐加1课时'), undefined);
  assert.equal(hoursFromUserWords('给小齐增加1课时，再扣0.5课时'), undefined);
});

test('模型把增加1课时误写成1个百分之一课时，预览仍按100提交', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.tools) return Response.json({ choices: [{ message: { content: JSON.stringify({ mode: 'action' }) } }] });
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'submit_course_action_plan',
      arguments: JSON.stringify({ actions: [{ kind: 'hours_adjust', filters: { username: '小齐' }, amountHundredths: 1, note: '补缴' }] }),
    } }] } }] });
  };
  try {
    const env = await modelEnv();
    env.MAIN_APP = { fetch: async () => Response.json({ data: [{ id: 7, username: '小齐', display_name: '小齐',
      role: 'STUDENT', status: 'ACTIVE', remaining_hundredths: 300 }] }) } as Fetcher;
    const plan = await planAgentTurn(env, new Request('https://qcp.dpdns.org/assistant/api/interpret'),
      { id: 1, role: 'ADMIN', displayName: '管理员', status: 'ACTIVE' } as User,
      '给小齐增加1个课时，原因：补缴', [], []);
    assert.equal(plan.actions[0].action.kind, 'hours_adjust');
    if (plan.actions[0].action.kind === 'hours_adjust') assert.equal(plan.actions[0].action.amountHundredths, 100);
    assert.match(plan.actions[0].label, /\+1 课时/);
    assert.match(plan.actions[0].label, /3 → 4/);
    assert.equal(plan.actions[0].risk, true);
  } finally { globalThis.fetch = originalFetch; }
});
