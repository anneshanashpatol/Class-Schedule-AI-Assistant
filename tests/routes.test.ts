import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/index';
import type { Env } from '../server/core';

const base = 'https://qcp.dpdns.org';
function envFor(sessionValid: boolean): Env {
  return {
    MAIN_APP: { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/auth/me') return sessionValid && request.headers.get('Cookie') === 'session=valid'
        ? Response.json({ data: { id: 1, displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' } })
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, { status: 401 });
      return Response.json({ data: [] });
    } },
    ASSETS: { fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`) },
    AI_DB: {} as D1Database,
  } as Env;
}

test('同域会话可进入助手，并将资源路径映射到独立项目', async () => {
  const response = await worker.fetch(new Request(`${base}/assistant`, { headers: { Cookie: 'session=valid' } }), envFor(true));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/');
});

test('未登录会跳转原站登录页，API 返回 401', async () => {
  const env = envFor(false);
  const page = await worker.fetch(new Request(`${base}/assistant`), env);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('Location'), `${base}/login?next=/assistant`);
  const api = await worker.fetch(new Request(`${base}/assistant/api/me`), env);
  assert.equal(api.status, 401);
});

test('跨站写请求在解析或写入前被拒绝', async () => {
  const response = await worker.fetch(new Request(`${base}/assistant/api/interpret`, { method: 'POST', headers: { Cookie: 'session=valid', Origin: 'https://evil.example' }, body: '{}' }), envFor(true));
  assert.equal(response.status, 403);
});

test('确认凭证只能执行一次，高风险项必须逐条授权', async () => {
  let writes = 0;
  const row = {
    id: '11111111-1111-1111-1111-111111111111', user_id: 1, status: 'PENDING', next_index: 0,
    expires_at: '2099-01-01 00:00:00', results_json: '[]',
    actions_json: JSON.stringify([{ action: { kind: 'schedule_create', fields: { teacherName: '张老师', studentNames: ['李同学'], subject: '数学', classDate: '2026-09-29', startTime: '19:00', endTime: '20:00' } }, label: '新增课程', risk: true }]),
  };
  const env = {
    ...envFor(true),
    MAIN_APP: { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/auth/me') return Response.json({ data: { id: 1, displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' } });
      if (path === '/api/schedules') { writes++; return Response.json({ data: { id: 5 } }, { status: 201 }); }
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    } },
    AI_DB: { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
      first: async () => row,
      run: async () => {
        if (sql.includes("SET status = 'RUNNING'")) { if (row.status !== 'PENDING') return { meta: { changes: 0 } }; row.status = 'RUNNING'; }
        if (sql.includes("SET status = 'DONE'")) row.status = 'DONE';
        if (sql.includes('SET next_index =')) { row.next_index = Number(args[0]); row.results_json = String(args[1]); }
        return { meta: { changes: 1 } };
      },
    }) }) },
  } as unknown as Env;
  const url = `${base}/assistant/api/confirm`;
  const makeRequest = (approvals: number[]) => new Request(url, { method: 'POST', headers: { Cookie: 'session=valid', Origin: base }, body: JSON.stringify({ proposalId: row.id, approvals }) });
  const rejected = await worker.fetch(makeRequest([]), env);
  assert.equal(rejected.status, 422);
  assert.equal(writes, 0);
  const first = await worker.fetch(makeRequest([0]), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).data.status, 'DONE');
  const repeated = await worker.fetch(makeRequest([0]), env);
  assert.equal((await repeated.json()).data.status, 'DONE');
  assert.equal(writes, 1);
});
