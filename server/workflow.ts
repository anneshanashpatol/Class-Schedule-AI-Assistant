import { ApiFailure, assertRole, fingerprint, mainApi, type Action, type Candidate, type Env, type ResolvedAction, type Schedule, type User, type UserRecord } from './core';

function qs(filters: Record<string, unknown>, extra: Record<string, string | number> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value !== undefined && value !== '' && key !== 'id') params.set(key, String(value));
  return params.toString();
}
function hasFilter(filters: Record<string, unknown>) { return Object.values(filters).some((value) => value !== undefined && value !== ''); }
function scheduleCandidate(item: Schedule): Candidate {
  return { id: item.id, label: `${item.class_date} ${item.start_time}–${item.end_time} · ${item.subject} · ${item.teacher_name} · ${item.student_names.join('、')}`, snapshot: fingerprint(item), data: item };
}
function userCandidate(item: UserRecord): Candidate {
  const role = { ADMIN: '管理员', TEACHER: '教师', STUDENT: '学生' }[item.role];
  const balance = item.role === 'STUDENT' && typeof item.remaining_hundredths === 'number'
    ? ` · 剩余 ${item.remaining_hundredths / 100} 课时` : '';
  return { id: item.id, label: `${item.display_name} · ${role} · ${item.status === 'ACTIVE' ? '启用' : '停用'}${balance}`, snapshot: fingerprint(item), data: item };
}
function describeFields(fields: Record<string, unknown>) {
  const names: Record<string, string> = { teacherName: '教师', studentNames: '学生', subject: '科目', classDate: '日期', startTime: '开始时间', endTime: '结束时间', classroom: '教室', username: '姓名', school: '学校', grade: '年级' };
  return Object.entries(fields).map(([key, value]) => `${names[key] ?? key}：${Array.isArray(value) ? value.join('、') : String(value)}`).join('，');
}
function describeFilters(filters: Record<string, unknown>) {
  const names: Record<string, string> = { id: '编号', teacherName: '教师', studentName: '学生', dateFrom: '起始日期', dateTo: '结束日期', startTime: '开始时间', endTime: '结束时间', subject: '科目', classroom: '教室', completed: '完课状态' };
  return Object.entries(filters).map(([key, value]) => `${names[key] ?? key}：${value === 'true' ? '已完课' : value === 'false' ? '未完课' : value}`).join('，');
}
async function schedules(env: Env, request: Request, filters: Record<string, unknown>) {
  const { startTime, endTime, ...apiFilters } = filters;
  if (filters.id) {
    const item = await mainApi<Schedule>(env, request, `/schedules/${filters.id}`);
    return (!startTime || item.start_time === startTime) && (!endTime || item.end_time === endTime) ? [item] : [];
  }
  const found = await mainApi<Schedule[]>(env, request, `/schedules?${qs(apiFilters, { page: 1, pageSize: 100 })}`);
  if (found.length === 100 && (startTime || endTime)) throw new ApiFailure(422, 'TOO_MANY_SCHEDULES', '待筛选课程超过 100 条，请补充日期、教师或学生');
  return found.filter((item) => (!startTime || item.start_time === startTime) && (!endTime || item.end_time === endTime));
}
async function users(env: Env, request: Request, filters: Record<string, unknown>) {
  const query = { search: filters.username, role: filters.role, status: filters.status };
  if (!filters.id) return mainApi<UserRecord[]>(env, request, `/users?${qs(query, { page: 1, pageSize: 100 })}`);
  for (let page = 1; page <= 5; page++) {
    const found = await mainApi<UserRecord[]>(env, request, `/users?${qs(query, { page, pageSize: 100 })}`);
    const target = found.find((item) => item.id === filters.id);
    if (target) return [target];
    if (found.length < 100) return [];
  }
  throw new ApiFailure(422, 'USER_NAME_REQUIRED', '用户数量较多，请同时提供准确姓名以定位该编号');
}
function required(fields: Record<string, unknown>, names: string[]): string[] {
  return names.filter((name) => fields[name] === undefined || fields[name] === '' || (Array.isArray(fields[name]) && fields[name].length === 0));
}
function addWeeks(date: string, weeks: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new ApiFailure(422, 'INVALID_DATE', '日期无效');
  parsed.setUTCDate(parsed.getUTCDate() + weeks * 7);
  return parsed.toISOString().slice(0, 10);
}
function validDate(date: string) { const parsed = new Date(`${date}T00:00:00Z`); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date; }
function sameName(left: string, right: string) { return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase(); }
async function createConflicts(env: Env, request: Request, fields: { classDate?: string; startTime?: string; endTime?: string; teacherName?: string; studentNames?: string[] }) {
  const lessons = await schedules(env, request, { dateFrom: fields.classDate, dateTo: fields.classDate });
  const conflicts = lessons.filter((lesson) => lesson.start_time < fields.endTime! && lesson.end_time > fields.startTime! &&
    (sameName(lesson.teacher_name, fields.teacherName!) || lesson.student_names.some((name) => fields.studentNames!.some((student) => sameName(name, student)))));
  return { conflicts, incomplete: lessons.length === 100 };
}
export function expandActions(actions: Action[]): Action[] {
  const expanded: Action[] = [];
  for (const action of actions) {
    if (action.kind === 'schedule_create' && action.repeatWeeks && action.repeatWeeks > 1) {
      if (!action.fields.classDate) throw new ApiFailure(422, 'MISSING_DATE', '重复排课需要明确首次上课日期');
      for (let week = 0; week < action.repeatWeeks; week++) expanded.push({ kind: 'schedule_create', fields: { ...action.fields, classDate: addWeeks(action.fields.classDate, week) } });
    } else expanded.push(action);
  }
  if (expanded.length > 20) throw new ApiFailure(422, 'TOO_MANY_ACTIONS', '一次最多处理 20 条操作');
  return expanded;
}

export async function resolveAction(env: Env, request: Request, user: User, action: Action): Promise<ResolvedAction> {
  if (action.kind === 'schedule_create') {
    assertRole(user, ['ADMIN']);
    const missing = required(action.fields, ['teacherName','studentNames','subject','classDate','startTime','endTime']);
    if (missing.length) return { action, label: '新增课程：请补齐教师、学生、科目、日期与起止时间', risk: false, missing };
    const f = action.fields;
    if (!validDate(f.classDate!) || f.startTime! >= f.endTime!) return { action, label: '课程日期或时间无效，请重新说明', risk: false, missing: ['有效日期和结束时间'] };
    const { conflicts, incomplete } = await createConflicts(env, request, f);
    const warning = conflicts.length ? `；与 ${conflicts.length} 节现有课程的教师或学生时间重叠${conflicts.length <= 3 ? `：${conflicts.map((item) => `${item.start_time}–${item.end_time} ${item.subject}`).join('、')}` : ''}` : '';
    const limitWarning = incomplete ? '；当天课程较多，请再核对原站课程表' : '';
    return { action, label: `新增课程：${f.classDate} ${f.startTime}–${f.endTime} · ${f.subject} · ${f.teacherName} · ${f.studentNames?.join('、')}${warning}${limitWarning}`, risk: Boolean(conflicts.length || incomplete) };
  }
  if (action.kind === 'user_create') {
    assertRole(user, ['ADMIN']);
    const missing = required(action.fields, ['username','role']);
    const roleName = action.fields.role ? { ADMIN: '管理员', TEACHER: '教师', STUDENT: '学生' }[action.fields.role] : '待指定身份';
    return { action, label: `新增用户：${action.fields.username ?? '待填写'} · ${roleName}（确认时填写初始密码）`, risk: false, missing };
  }
  if (action.kind.startsWith('schedule_')) {
    if (['schedule_update','schedule_delete'].includes(action.kind)) assertRole(user, ['ADMIN']);
    if (action.kind === 'schedule_completion') assertRole(user, ['ADMIN','TEACHER']);
    const filters = action.filters;
    if (action.kind !== 'schedule_search' && action.kind !== 'schedule_export' && !hasFilter(filters)) {
      return { action, label: '请提供足以定位课程的日期、教师、学生或科目', risk: action.kind === 'schedule_delete', missing: ['课程筛选条件'] };
    }
    if (action.kind === 'schedule_export') return { action, label: `导出课程：${describeFilters(filters) || '当前账号可见的全部课程'}`, risk: false, result: { exportFilters: filters } };
    const found = (await schedules(env, request, filters)).map(scheduleCandidate);
    if (action.kind === 'schedule_search') return { action, label: `找到 ${found.length} 条课程${found.length === 100 ? '（仅显示前100条，请缩小条件）' : ''}`, risk: false, result: found };
    if (found.length === 0) return { action, label: '没有找到匹配的课程，请修改描述', risk: action.kind === 'schedule_delete', missing: ['目标课程'] };
    if (found.length > 20) return { action, label: '匹配课程超过 20 条，请补充日期、教师或学生', risk: action.kind === 'schedule_delete', missing: ['更精确的课程条件'] };
    const selected = found.length === 1 ? found[0] : undefined;
    const verb = action.kind === 'schedule_update' ? '编辑课程' : action.kind === 'schedule_delete' ? '删除课程' : '修改完课状态';
    if (action.kind === 'schedule_update' && Object.keys(action.fields).length === 0) return { action, label: '请说明要修改的字段', risk: false, missing: ['修改内容'] };
    const impact = action.kind === 'schedule_delete' ? '；删除后不可恢复，已完课课程不会返还课时' : action.kind === 'schedule_update' ? `；改为 ${describeFields(action.fields)}` : action.kind === 'schedule_completion' ? `；改为${action.completed ? '已完课' : '未完课'}` : '';
    return { action, label: `${verb}：${selected?.label ?? `请从 ${found.length} 条匹配课程中选择`}${impact}`, risk: action.kind === 'schedule_delete', candidates: found, selected };
  }
  if (action.kind === 'hours_balance') {
    if (user.role === 'STUDENT') {
      if ((action.filters.id && action.filters.id !== user.id) ||
          (action.filters.username && action.filters.username !== user.displayName) ||
          (action.filters.role && action.filters.role !== 'STUDENT') || action.filters.status) {
        throw new ApiFailure(403, 'FORBIDDEN', '学生只能查询自己的剩余课时');
      }
      const own = await mainApi<User>(env, request, '/auth/me');
      return { action, label: '我的剩余课时', risk: false,
        result: { label: typeof own.remainingHundredths === 'number' ? `${own.displayName} · 剩余 ${own.remainingHundredths / 100} 课时` : '尚无课时余额记录' } };
    }
    assertRole(user, ['ADMIN']);
    if (action.filters.role && action.filters.role !== 'STUDENT') throw new ApiFailure(422, 'STUDENT_REQUIRED', '只能查询学生的剩余课时');
    const found = (await users(env, request, { ...action.filters, role: 'STUDENT' })).map(userCandidate);
    return { action, label: `找到 ${found.length} 位学生${found.length === 100 ? '（仅显示前100位，请缩小姓名范围）' : ''}`, risk: false, result: found };
  }
  assertRole(user, ['ADMIN']);
  if (action.kind === 'user_search') {
    const found = (await users(env, request, action.filters)).map(userCandidate);
    return { action, label: `找到 ${found.length} 位用户${found.length === 100 ? '（仅显示前100位）' : ''}`, risk: false, result: found };
  }
  if (!hasFilter(action.filters)) return { action, label: '请提供用户名或身份以定位用户', risk: action.kind === 'user_delete' || action.kind === 'hours_adjust', missing: ['用户筛选条件'] };
  const found = (await users(env, request, action.filters)).map(userCandidate);
  if (!found.length) return { action, label: '没有找到匹配的用户', risk: false, missing: ['目标用户'] };
  if (found.length > 20) return { action, label: '匹配用户超过 20 位，请提供更精确的姓名', risk: false, missing: ['更精确的用户条件'] };
  const selected = found.length === 1 ? found[0] : undefined;
  const labels: Record<string,string> = { user_update: '编辑用户', user_status: '修改账号状态', user_delete: '删除用户', hours_adjust: '调整课时余额', adjustments_search: '查看课时调整记录' };
  if (action.kind === 'user_update' && action.fields.role) return { action, label: '现有用户接口不支持修改身份角色', risk: false, missing: ['支持的修改内容'] };
  if (action.kind === 'user_update' && Object.keys(action.fields).length === 0) return { action, label: '请说明要修改的资料', risk: false, missing: ['修改内容'] };
  if (action.kind === 'hours_adjust' && (!action.amountHundredths || !action.note.trim())) return { action, label: '请提供非零调整数量和原因', risk: true, missing: ['调整数量和原因'] };
  if (action.kind === 'hours_adjust' && selected && (selected.data as UserRecord).role !== 'STUDENT') return { action, label: '课时余额只能调整学生账号', risk: true, missing: ['学生账号'] };
  if (action.kind === 'adjustments_search' && selected) {
    const result = await mainApi<unknown>(env, request, `/users/${selected.id}/adjustments`);
    return { action, label: `${labels[action.kind]}：${selected.label}`, risk: false, result };
  }
  if (action.kind === 'adjustments_search' && !selected) return { action, label: '找到多位匹配用户，请补充准确姓名后查询调整记录', risk: false, missing: ['准确的用户姓名'] };
  const impact = action.kind === 'hours_adjust' ? `；${action.amountHundredths > 0 ? '+' : ''}${action.amountHundredths / 100} 课时，原因：${action.note}${selected ? `，预计余额 ${((selected.data as UserRecord).remaining_hundredths ?? 0) / 100} → ${(((selected.data as UserRecord).remaining_hundredths ?? 0) + action.amountHundredths) / 100}` : ''}` : action.kind === 'user_status' ? `；改为${action.status === 'ACTIVE' ? '启用' : '停用'}` : action.kind === 'user_update' ? `；改为 ${describeFields(action.fields)}` : action.kind === 'user_delete' ? '；删除后账号不可登录，历史课程姓名保留' : '';
  return { action, label: `${labels[action.kind]}：${selected?.label ?? `请从 ${found.length} 位用户中选择`}${impact}`, risk: action.kind === 'user_delete' || action.kind === 'hours_adjust' || (action.kind === 'user_status' && action.status === 'DISABLED'), candidates: found, selected };
}

export async function executeAction(env: Env, request: Request, item: ResolvedAction, password?: string) {
  const action = item.action;
  if (action.kind === 'schedule_search' || action.kind === 'user_search' || action.kind === 'hours_balance' || action.kind === 'schedule_export') return item.result;
  if (action.kind === 'schedule_create') return mainApi(env, request, '/schedules', { method: 'POST', body: JSON.stringify({ ...action.fields, classroom: action.fields.classroom ?? '' }) });
  if (action.kind === 'user_create') {
    if (!password || password.length < 5) throw new ApiFailure(422, 'PASSWORD_REQUIRED', '请输入至少 5 位初始密码');
    return mainApi(env, request, '/users', { method: 'POST', body: JSON.stringify({ ...action.fields, password }) });
  }
  const target = item.selected;
  if (!target) throw new ApiFailure(422, 'TARGET_REQUIRED', '请先选定目标');
  if (action.kind === 'adjustments_search') return mainApi(env, request, `/users/${target.id}/adjustments`);
  if (action.kind.startsWith('schedule_')) {
    const latest = await mainApi<Schedule>(env, request, `/schedules/${target.id}`);
    if (fingerprint(latest) !== target.snapshot) throw new ApiFailure(409, 'TARGET_CHANGED', '课程已变化，请重新预览');
    if (action.kind === 'schedule_delete') return mainApi(env, request, `/schedules/${target.id}`, { method: 'DELETE' });
    if (action.kind === 'schedule_completion') return mainApi(env, request, `/schedules/${target.id}/completion`, { method: 'PATCH', body: JSON.stringify({ completed: action.completed, version: latest.version }) });
    if (action.kind === 'schedule_update') return mainApi(env, request, `/schedules/${target.id}`, { method: 'PATCH', body: JSON.stringify({ teacherName: latest.teacher_name, studentNames: latest.student_names, subject: latest.subject, classDate: latest.class_date, startTime: latest.start_time, endTime: latest.end_time, classroom: latest.classroom, ...action.fields, version: latest.version }) });
  }
  const current = (await users(env, request, { id: target.id, username: (target.data as UserRecord).username }))[0];
  if (!current || fingerprint(current) !== target.snapshot) throw new ApiFailure(409, 'TARGET_CHANGED', '用户资料已变化，请重新预览');
  if (action.kind === 'user_delete') {
    if (current.role === 'ADMIN' && current.status === 'ACTIVE') {
      const activeAdmins = await users(env, request, { role: 'ADMIN', status: 'ACTIVE' });
      if (activeAdmins.length <= 1) throw new ApiFailure(409, 'LAST_ADMIN', '不能删除最后一位启用的管理员');
    }
    return mainApi(env, request, `/users/${target.id}`, { method: 'DELETE' });
  }
  if (action.kind === 'user_status') return mainApi(env, request, `/users/${target.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: action.status }) });
  if (action.kind === 'user_update') return mainApi(env, request, `/users/${target.id}`, { method: 'PATCH', body: JSON.stringify({ username: current.username, subject: current.subject ?? '', school: current.school ?? '', grade: current.grade ?? '', ...action.fields }) });
  if (action.kind === 'hours_adjust') return mainApi(env, request, `/users/${target.id}/adjust-hours`, { method: 'POST', body: JSON.stringify({ amountHundredths: action.amountHundredths, note: action.note, requestId: crypto.randomUUID() }) });
  throw new ApiFailure(422, 'UNSUPPORTED_ACTION', '不支持的操作');
}
