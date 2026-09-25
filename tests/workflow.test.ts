import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiFailure, mainApi, type Env, type Schedule, type User } from '../server/core';
import { executeAction, expandActions, resolveAction } from '../server/workflow';

const user: User = { id: 1, displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' };
const request = new Request('https://qcp.dpdns.org/assistant/api/interpret', { headers: { Cookie: 'session=abc' } });
function fakeEnv(handler: (request: Request) => Response | Promise<Response>): Env {
  return { MAIN_APP: { fetch: handler }, AI_DB: {} as D1Database, ASSETS: {} as Fetcher } as Env;
}
function ok(data: unknown) { return Response.json({ data }); }

test('重复排课展开至具体日期并限制总条数', () => {
  const list = expandActions([{ kind: 'schedule_create', fields: { classDate: '2026-09-29' }, repeatWeeks: 3 }]);
  assert.deepEqual(list.map((item) => item.kind === 'schedule_create' && item.fields.classDate), ['2026-09-29','2026-10-06','2026-10-13']);
  assert.throws(() => expandActions(Array.from({ length: 21 }, () => ({ kind: 'schedule_search' as const, filters: {} }))), /一次最多/);
});

test('新增课程时间重叠时在预览标明并要求逐条确认', async () => {
  const existing: Schedule = { id: 5, teacher_name: '张老师', student_names: ['王同学'], subject: '语文', class_date: '2026-09-29', start_time: '19:30', end_time: '20:30', classroom: '', is_completed: 0, version: 1 };
  const env = fakeEnv((forwarded) => {
    const url = new URL(forwarded.url);
    assert.equal(url.pathname, '/api/schedules');
    assert.equal(url.searchParams.get('dateFrom'), '2026-09-29');
    assert.equal(url.searchParams.get('dateTo'), '2026-09-29');
    return ok([existing]);
  });
  const result = await resolveAction(env, request, user, { kind: 'schedule_create', fields: { teacherName: '张老师', studentNames: ['李同学'], subject: '数学', classDate: '2026-09-29', startTime: '19:00', endTime: '20:00' } });
  assert.equal(result.risk, true);
  assert.match(result.label, /时间重叠/);
});

test('教师不可通过助手绕过原 API 的删课权限', async () => {
  await assert.rejects(() => resolveAction(fakeEnv(() => ok([])), request, { ...user, role: 'TEACHER' }, { kind: 'schedule_delete', filters: { teacherName: '张老师' } }), (error) => error instanceof ApiFailure && error.status === 403);
});

test('按课程起止时间筛选删除目标，时间不传给原站不支持的查询接口', async () => {
  const lessons: Schedule[] = [
    { id: 1, teacher_name: '丁茗辉', student_names: ['王康凯'], subject: '数学', class_date: '2026-09-27', start_time: '10:00', end_time: '12:00', classroom: '', is_completed: 0, version: 1 },
    { id: 2, teacher_name: '丁茗辉', student_names: ['王康凯'], subject: '数学', class_date: '2026-09-27', start_time: '13:00', end_time: '15:00', classroom: '', is_completed: 0, version: 1 },
  ];
  const env = fakeEnv((forwarded) => {
    const url = new URL(forwarded.url);
    assert.equal(url.searchParams.get('startTime'), null);
    assert.equal(url.searchParams.get('endTime'), null);
    assert.equal(url.searchParams.get('dateFrom'), '2026-09-27');
    assert.equal(url.searchParams.get('dateTo'), '2026-09-27');
    return ok(lessons);
  });
  const result = await resolveAction(env, request, user, { kind: 'schedule_delete', filters: { teacherName: '丁茗辉', studentName: '王康凯', dateFrom: '2026-09-27', dateTo: '2026-09-27', startTime: '10:00', endTime: '12:00' } });
  assert.equal(result.selected?.id, 1);
  assert.deepEqual(result.candidates?.map((item) => item.id), [1]);
  assert.equal(result.risk, true);
});

test('按指定日期、时段和参与者查询真实课程后预览完课目标', async () => {
  const lessons: Schedule[] = [
    { id: 1, teacher_name: '王老师', student_names: ['包梦妍'], subject: '数学', class_date: '2026-09-25', start_time: '09:00', end_time: '10:00', classroom: '', is_completed: 0, version: 1 },
    { id: 2, teacher_name: '王老师', student_names: ['包梦妍'], subject: '数学', class_date: '2026-09-25', start_time: '14:00', end_time: '15:00', classroom: '', is_completed: 0, version: 1 },
    { id: 3, teacher_name: '包梦妍老师', student_names: ['李同学'], subject: '英语', class_date: '2026-09-25', start_time: '16:00', end_time: '17:00', classroom: '', is_completed: 0, version: 1 },
  ];
  const env = fakeEnv((forwarded) => {
    const url = new URL(forwarded.url);
    assert.equal(url.searchParams.get('dateFrom'), '2026-09-25');
    assert.equal(url.searchParams.get('dateTo'), '2026-09-25');
    assert.equal(url.searchParams.get('participantName'), null);
    assert.equal(url.searchParams.get('period'), null);
    return ok(lessons);
  });
  const result = await resolveAction(env, request, user, { kind: 'schedule_completion', filters: {
    dateFrom: '2026-09-25', dateTo: '2026-09-25', participantName: '包梦妍', period: 'afternoon',
  }, completed: true });
  assert.deepEqual(result.candidates?.map((item) => item.id), [2, 3]);
  assert.equal(result.selected, undefined);
});

test('学生通过原站登录信息查询自己的剩余课时', async () => {
  const env = fakeEnv((forwarded) => {
    assert.equal(new URL(forwarded.url).pathname, '/api/auth/me');
    return ok({ id: 3, displayName: '李同学', role: 'STUDENT', status: 'ACTIVE', remainingHundredths: 125 });
  });
  const result = await resolveAction(env, request, { ...user, role: 'STUDENT' }, { kind: 'hours_balance', filters: {} });
  assert.deepEqual(result.result, { label: '李同学 · 剩余 1.25 课时' });
  const own = await resolveAction(env, request, { id: 3, displayName: '李同学', role: 'STUDENT', status: 'ACTIVE' }, { kind: 'hours_balance', filters: { role: 'STUDENT', username: '李同学' } });
  assert.deepEqual(own.result, result.result);
  await assert.rejects(() => resolveAction(env, request, { ...user, role: 'STUDENT' }, { kind: 'hours_balance', filters: { username: '别人' } }),
    (error) => error instanceof ApiFailure && error.status === 403);
});

test('管理员按姓名查询学生剩余课时，教师不可读取', async () => {
  const env = fakeEnv((forwarded) => {
    const url = new URL(forwarded.url);
    assert.equal(url.pathname, '/api/users');
    assert.equal(url.searchParams.get('role'), 'STUDENT');
    assert.equal(url.searchParams.get('search'), '李');
    return ok([{ id: 3, username: '李同学', display_name: '李同学', role: 'STUDENT', status: 'ACTIVE', remaining_hundredths: 250 }]);
  });
  const action = { kind: 'hours_balance' as const, filters: { username: '李' } };
  const result = await resolveAction(env, request, user, action);
  assert.match(JSON.stringify(result.result), /李同学 · 学生 · 启用 · 剩余 2.5 课时/);
  await assert.rejects(() => resolveAction(env, request, { ...user, role: 'TEACHER' }, action),
    (error) => error instanceof ApiFailure && error.status === 403);
});

test('管理员可列出学生余额，沿用原站用户列表权限', async () => {
  const env = fakeEnv((forwarded) => {
    const url = new URL(forwarded.url);
    assert.equal(url.searchParams.get('role'), 'STUDENT');
    assert.equal(url.searchParams.get('search'), null);
    return ok([{ id: 4, username: '王同学', display_name: '王同学', role: 'STUDENT', status: 'ACTIVE', remaining_hundredths: 0 }]);
  });
  const result = await resolveAction(env, request, user, { kind: 'hours_balance', filters: {} });
  assert.match(JSON.stringify(result.result), /剩余 0 课时/);
});

test('按用户编号查询会继续查分页，找不到时不会误报不存在', async () => {
  const env = fakeEnv((forwarded) => {
    const page = Number(new URL(forwarded.url).searchParams.get('page'));
    if (page === 1) return ok(Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })));
    if (page === 2) return ok([{ id: 150, username: '李同学', display_name: '李同学', role: 'STUDENT', status: 'ACTIVE', remaining_hundredths: 300 }]);
    throw new Error('不应继续请求');
  });
  const result = await resolveAction(env, request, user, { kind: 'hours_balance', filters: { id: 150 } });
  assert.match(JSON.stringify(result.result), /剩余 3 课时/);
});

test('业务请求仅转发当前会话，并对写操作设置同源 Origin', async () => {
  const env = fakeEnv(async (forwarded) => {
    assert.equal(new URL(forwarded.url).pathname, '/api/schedules');
    assert.equal(forwarded.headers.get('Cookie'), 'session=abc');
    assert.equal(forwarded.headers.get('Origin'), 'https://qcp.dpdns.org');
    return ok({ id: 9 });
  });
  assert.deepEqual(await mainApi(env, request, '/schedules', { method: 'POST', body: '{}' }), { id: 9 });
});

test('目标课程变化时拒绝执行旧预览', async () => {
  const original: Schedule = { id: 2, teacher_name: '张老师', student_names: ['李同学'], subject: '数学', class_date: '2026-09-29', start_time: '19:00', end_time: '20:00', classroom: '', is_completed: 0, version: 1 };
  const env = fakeEnv(() => ok({ ...original, version: 2 }));
  await assert.rejects(() => executeAction(env, request, { action: { kind: 'schedule_delete', filters: { subject: '数学' } }, label: '', risk: true, selected: { id: 2, label: '', data: original, snapshot: JSON.stringify(original) } }), (error) => error instanceof ApiFailure && error.code === 'TARGET_CHANGED');
});
