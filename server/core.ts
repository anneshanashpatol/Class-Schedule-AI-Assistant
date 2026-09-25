import { z } from 'zod';

export interface Env {
  MAIN_APP: Fetcher;
  AI_DB: D1Database;
  ASSETS: Fetcher;
  AI_CONFIG_KEY?: string;
}

export type Role = 'ADMIN' | 'TEACHER' | 'STUDENT';
export interface User { id: number; displayName: string; role: Role; status: string; remainingHundredths?: number }
export interface Schedule {
  id: number; teacher_name: string; student_names: string[]; subject: string;
  class_date: string; start_time: string; end_time: string; classroom: string;
  is_completed: number; version: number;
}
export interface UserRecord {
  id: number; username: string; display_name: string; role: Role; status: string;
  subject?: string; school?: string; grade?: string; remaining_hundredths?: number;
}
export interface Candidate { id: number; label: string; snapshot: string; data: Schedule | UserRecord }

export const scheduleFilters = z.object({
  id: z.number().int().positive().optional(), teacherName: z.string().optional(),
  studentName: z.string().optional(), participantName: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(),
  period: z.enum(['morning', 'afternoon', 'evening']).optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  subject: z.string().optional(), classroom: z.string().optional(), completed: z.enum(['true', 'false']).optional(),
}).strict();
export const userFilters = z.object({
  id: z.number().int().positive().optional(), username: z.string().optional(),
  role: z.enum(['ADMIN', 'TEACHER', 'STUDENT']).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(),
}).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const scheduleFields = z.object({
  teacherName: z.string().optional(), studentNames: z.array(z.string()).optional(), subject: z.string().optional(),
  classDate: date.optional(), startTime: time.optional(), endTime: time.optional(), classroom: z.string().optional(),
}).strict();
const userFields = z.object({ username: z.string().optional(), role: z.enum(['ADMIN','TEACHER','STUDENT']).optional(), subject: z.string().optional(), school: z.string().optional(), grade: z.string().optional() }).strict();
export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule_search'), filters: scheduleFilters }),
  z.object({ kind: z.literal('schedule_export'), filters: scheduleFilters }),
  z.object({ kind: z.literal('schedule_create'), fields: scheduleFields, repeatWeeks: z.number().int().min(1).max(20).optional() }),
  z.object({ kind: z.literal('schedule_update'), filters: scheduleFilters, fields: scheduleFields }),
  z.object({ kind: z.literal('schedule_delete'), filters: scheduleFilters }),
  z.object({ kind: z.literal('schedule_completion'), filters: scheduleFilters, completed: z.boolean() }),
  z.object({ kind: z.literal('user_search'), filters: userFilters }),
  z.object({ kind: z.literal('hours_balance'), filters: userFilters }),
  z.object({ kind: z.literal('user_create'), fields: userFields }),
  z.object({ kind: z.literal('user_update'), filters: userFilters, fields: userFields }),
  z.object({ kind: z.literal('user_status'), filters: userFilters, status: z.enum(['ACTIVE','DISABLED']) }),
  z.object({ kind: z.literal('user_delete'), filters: userFilters }),
  z.object({ kind: z.literal('hours_adjust'), filters: userFilters, amountHundredths: z.number().int(), note: z.string() }),
  z.object({ kind: z.literal('adjustments_search'), filters: userFilters }),
]);
export type Action = z.infer<typeof actionSchema>;
export interface ResolvedAction { action: Action; label: string; risk: boolean; candidates?: Candidate[]; selected?: Candidate; result?: unknown; missing?: string[] }

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiFailure) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  console.error(error);
  return Response.json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } }, { status: 500 });
}
export async function mainApi<T>(env: Env, request: Request, path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(`/api${path}`, request.url);
  const headers = new Headers(init.headers);
  const cookie = request.headers.get('Cookie');
  if (cookie) headers.set('Cookie', cookie);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.method && !['GET','HEAD'].includes(init.method)) headers.set('Origin', url.origin);
  const response = await env.MAIN_APP.fetch(new Request(url, { ...init, headers }));
  const body = await response.json().catch(() => ({})) as { data?: T; error?: { code?: string; message?: string } };
  if (!response.ok) throw new ApiFailure(response.status, body.error?.code ?? 'UPSTREAM_ERROR', body.error?.message ?? '原系统请求失败');
  return body.data as T;
}
export async function currentUser(env: Env, request: Request): Promise<User> {
  const user = await mainApi<User>(env, request, '/auth/me');
  if (user.status !== 'ACTIVE') throw new ApiFailure(401, 'UNAUTHENTICATED', '请先登录');
  return user;
}
export function assertRole(user: User, allowed: Role[]) {
  if (!allowed.includes(user.role)) throw new ApiFailure(403, 'FORBIDDEN', '当前账号没有执行此操作的权限');
}
export function assertOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new ApiFailure(403, 'INVALID_ORIGIN', '请求来源无效');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiFailure(403, 'CROSS_SITE', '拒绝跨站请求');
}
export function fingerprint(value: unknown) { return JSON.stringify(value); }
export function sanitizeText(value: string, max = 100) { return value.trim().slice(0, max); }
