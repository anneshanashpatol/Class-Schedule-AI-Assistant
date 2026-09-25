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

test('教师不可通过助手绕过原 API 的删课权限', async () => {
  await assert.rejects(() => resolveAction(fakeEnv(() => ok([])), request, { ...user, role: 'TEACHER' }, { kind: 'schedule_delete', filters: { teacherName: '张老师' } }), (error) => error instanceof ApiFailure && error.status === 403);
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
