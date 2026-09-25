import { ApiFailure, assertOrigin, assertRole, currentUser, errorResponse, mainApi, type Env, type ResolvedAction, type Schedule } from './core';
import { clearSettings, parseInstruction, publicSettings, saveSettings, testModel } from './model';
import { executeAction, expandActions, resolveAction } from './workflow';

type StoredProposal = { id: string; user_id: number; actions_json: string; status: string; next_index: number; results_json: string; expires_at: string };
function json(data: unknown, status = 200) { return Response.json({ data }, { status, headers: { 'Cache-Control': 'no-store' } }); }
async function parseBody<T>(request: Request): Promise<T> { try { return await request.json() as T; } catch { throw new ApiFailure(400, 'INVALID_JSON', '请求内容不是有效 JSON'); } }
function isWrite(request: Request) { return !['GET','HEAD','OPTIONS'].includes(request.method); }
async function handler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/assistant')) return new Response('Not found', { status: 404 });
  if (!url.pathname.startsWith('/assistant/api/')) {
    if (!url.pathname.startsWith('/assistant/assets/')) {
      try { await currentUser(env, request); }
      catch (error) {
        if (error instanceof ApiFailure && error.status === 401) return Response.redirect(new URL('/login?next=/assistant', request.url), 302);
        throw error;
      }
    }
    const assetUrl = new URL(request.url);
    assetUrl.pathname = assetUrl.pathname.replace(/^\/assistant(?=\/|$)/, '') || '/';
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }
  if (isWrite(request)) assertOrigin(request);
  const user = await currentUser(env, request);
  const path = url.pathname.slice('/assistant/api'.length);
  if (path === '/me' && request.method === 'GET') return json(user);
  if (path === '/settings' && request.method === 'GET') { assertRole(user, ['ADMIN']); return json(await publicSettings(env)); }
  if (path === '/settings' && request.method === 'PUT') { assertRole(user, ['ADMIN']); return json(await saveSettings(env, await parseBody(request))); }
  if (path === '/settings' && request.method === 'DELETE') { assertRole(user, ['ADMIN']); await clearSettings(env); return json({ success: true }); }
  if (path === '/settings/test' && request.method === 'POST') { assertRole(user, ['ADMIN']); return json(await testModel(env)); }
  if (path === '/export-data' && request.method === 'GET') {
    const filters = new URLSearchParams(url.search);
    if (filters.has('id')) { filters.set('ids', filters.get('id')!); filters.delete('id'); }
    filters.set('limit', String(Math.min(1000, Math.max(1, Number(filters.get('limit') ?? 500)))));
    return json(await mainApi<Schedule[]>(env, request, `/schedules/export-data?${filters.toString()}`));
  }
  if (path === '/interpret' && request.method === 'POST') {
    const body = await parseBody<{ input?: unknown; context?: unknown }>(request);
    if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 1000) throw new ApiFailure(422, 'INVALID_INPUT', '请输入不超过 1000 字的指令');
    const now = Math.floor(Date.now() / 1000);
    const throttle = await env.AI_DB.prepare(`INSERT INTO model_call_cooldowns (user_id, next_allowed_at) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET next_allowed_at = excluded.next_allowed_at
      WHERE model_call_cooldowns.next_allowed_at <= ?`).bind(user.id, now + 3, now).run();
    if ((throttle.meta.changes ?? 0) === 0) throw new ApiFailure(429, 'TOO_MANY_REQUESTS', '发送太快，请稍等几秒再试');
    const context = Array.isArray(body.context) ? body.context.filter((item): item is string => typeof item === 'string').slice(-4) : [];
    const parsed = await parseInstruction(env, body.input, context, user.role);
    if (!parsed.actions.length) return json({ question: parsed.question ?? '请补充要查询或操作的内容', actions: [] });
    const actions = expandActions(parsed.actions);
    const resolved = await Promise.all(actions.map((action) => resolveAction(env, request, user, action)));
    const missing = resolved.flatMap((item) => item.missing ?? []);
    if (missing.length) return json({ question: parsed.question ?? `请补充：${[...new Set(missing)].join('、')}`, actions: resolved });
    const hasWrites = resolved.some((item) => !['schedule_search','schedule_export','user_search','hours_balance','adjustments_search'].includes(item.action.kind));
    if (!hasWrites) return json({ actions: resolved });
    const id = crypto.randomUUID();
    await env.AI_DB.prepare("DELETE FROM proposals WHERE expires_at < datetime('now')").run();
    await env.AI_DB.prepare("INSERT INTO proposals (id, user_id, actions_json, status, expires_at) VALUES (?, ?, ?, 'PENDING', datetime('now', '+15 minutes'))")
      .bind(id, user.id, JSON.stringify(resolved)).run();
    return json({ proposalId: id, expiresInMinutes: 15, actions: resolved });
  }
  if (path === '/confirm' && request.method === 'POST') {
    const body = await parseBody<{ proposalId?: string; selections?: Record<string, number>; approvals?: number[]; passwords?: Record<string, string> }>(request);
    if (!body.proposalId || !/^[\da-f-]{36}$/i.test(body.proposalId)) throw new ApiFailure(422, 'INVALID_PROPOSAL', '确认凭证无效');
    const row = await env.AI_DB.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ? AND expires_at > datetime('now')")
      .bind(body.proposalId, user.id).first<StoredProposal>();
    if (!row) throw new ApiFailure(404, 'PROPOSAL_EXPIRED', '预览已过期，请重新输入指令');
    if (row.status !== 'PENDING') return json({ status: row.status, results: JSON.parse(row.results_json), message: row.status === 'RUNNING' ? '执行状态待核实，不会自动重复操作' : undefined });
    const actions = JSON.parse(row.actions_json) as ResolvedAction[];
    for (let index = 0; index < actions.length; index++) {
      const item = actions[index];
      if (item.candidates?.length && !item.selected) {
        const selected = item.candidates.find((candidate) => candidate.id === body.selections?.[String(index)]);
        if (!selected) throw new ApiFailure(422, 'TARGET_REQUIRED', `第 ${index + 1} 项需要选择目标`);
        item.selected = selected;
      }
      if (item.risk && !body.approvals?.includes(index)) throw new ApiFailure(422, 'EXPLICIT_CONFIRMATION_REQUIRED', `第 ${index + 1} 项需要单独确认`);
      if (item.action.kind === 'user_create' && (!body.passwords?.[String(index)] || body.passwords[String(index)].length < 5)) {
        throw new ApiFailure(422, 'PASSWORD_REQUIRED', `第 ${index + 1} 项需要填写至少 5 位初始密码`);
      }
    }
    const locked = await env.AI_DB.prepare("UPDATE proposals SET status = 'RUNNING' WHERE id = ? AND status = 'PENDING'").bind(row.id).run();
    if ((locked.meta.changes ?? 0) !== 1) throw new ApiFailure(409, 'ALREADY_RUNNING', '操作已开始，请勿重复提交');
    const results: { index: number; status: 'success' | 'failed'; data?: unknown; error?: string }[] = [];
    for (let index = 0; index < actions.length; index++) {
      try {
        const data = await executeAction(env, request, actions[index], body.passwords?.[String(index)]);
        results.push({ index, status: 'success', data });
        await env.AI_DB.prepare('UPDATE proposals SET next_index = ?, results_json = ? WHERE id = ?').bind(index + 1, JSON.stringify(results), row.id).run();
      } catch (error) {
        results.push({ index, status: 'failed', error: error instanceof Error ? error.message : '执行失败' });
        await env.AI_DB.prepare("UPDATE proposals SET status = 'FAILED', next_index = ?, results_json = ? WHERE id = ?").bind(index, JSON.stringify(results), row.id).run();
        return json({ status: 'FAILED', results, remaining: actions.length - index - 1 });
      }
    }
    await env.AI_DB.prepare("UPDATE proposals SET status = 'DONE' WHERE id = ?").bind(row.id).run();
    return json({ status: 'DONE', results, remaining: 0 });
  }
  throw new ApiFailure(404, 'NOT_FOUND', '接口不存在');
}

export default { async fetch(request: Request, env: Env): Promise<Response> { try { return await handler(request, env); } catch (error) { return errorResponse(error); } } };
