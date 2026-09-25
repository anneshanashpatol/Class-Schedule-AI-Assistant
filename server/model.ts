import { z } from 'zod';
import { actionSchema, ApiFailure, type Action, type Env, type Role } from './core';

interface SettingRow { endpoint: string; model: string; key_ciphertext: string; key_iv: string }
const settingsInput = z.object({ endpoint: z.string().max(500), model: z.string().trim().min(1).max(150), apiKey: z.string().max(500).optional() });

function endpointUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiFailure(422, 'INVALID_ENDPOINT', '接口地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.') ||
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
    throw new ApiFailure(422, 'INVALID_ENDPOINT', '仅支持公开的 HTTPS 接口地址');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  url.search = '';
  return url.toString();
}

async function cryptKey(env: Env): Promise<CryptoKey> {
  if (!env.AI_CONFIG_KEY) throw new ApiFailure(503, 'CONFIG_KEY_MISSING', '尚未在 Cloudflare 配置 AI_CONFIG_KEY Secret');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(env.AI_CONFIG_KEY), (char) => char.charCodeAt(0)); }
  catch { throw new ApiFailure(503, 'CONFIG_KEY_INVALID', 'AI_CONFIG_KEY 必须是 32 字节的 Base64 值'); }
  if (bytes.length !== 32) throw new ApiFailure(503, 'CONFIG_KEY_INVALID', 'AI_CONFIG_KEY 必须是 32 字节的 Base64 值');
  return crypto.subtle.importKey('raw', Uint8Array.from(bytes).buffer, 'AES-GCM', false, ['encrypt','decrypt']);
}
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function decode(value: string) { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
async function encrypt(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptKey(env), new TextEncoder().encode(value));
  return { cipher: encode(new Uint8Array(encrypted)), iv: encode(iv) };
}
async function decrypt(env: Env, row: SettingRow) {
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(row.key_iv) }, await cryptKey(env), decode(row.key_ciphertext)));
  } catch { throw new ApiFailure(503, 'CONFIG_KEY_MISMATCH', '无法解密 API Key，请核对 Cloudflare Secret'); }
}
async function getRow(env: Env) { return env.AI_DB.prepare('SELECT endpoint, model, key_ciphertext, key_iv FROM ai_settings WHERE id = 1').first<SettingRow>(); }
export async function publicSettings(env: Env) {
  const row = await getRow(env);
  return { endpoint: row?.endpoint ?? '', model: row?.model ?? '', hasApiKey: Boolean(row?.key_ciphertext), hasEncryptionKey: Boolean(env.AI_CONFIG_KEY) };
}
export async function saveSettings(env: Env, body: unknown) {
  const parsed = settingsInput.safeParse(body);
  if (!parsed.success) throw new ApiFailure(422, 'VALIDATION_ERROR', '模型配置无效');
  const current = await getRow(env);
  const endpoint = endpointUrl(parsed.data.endpoint);
  const model = parsed.data.model;
  let cipher = current?.key_ciphertext;
  let iv = current?.key_iv;
  if (parsed.data.apiKey) ({ cipher, iv } = await encrypt(env, parsed.data.apiKey));
  if (!cipher || !iv) throw new ApiFailure(422, 'API_KEY_REQUIRED', '请输入 API Key');
  await env.AI_DB.prepare(`INSERT INTO ai_settings (id, endpoint, model, key_ciphertext, key_iv)
    VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint, model=excluded.model,
    key_ciphertext=excluded.key_ciphertext, key_iv=excluded.key_iv, updated_at=datetime('now')`)
    .bind(endpoint, model, cipher, iv).run();
  return publicSettings(env);
}
export async function clearSettings(env: Env) { await env.AI_DB.prepare('DELETE FROM ai_settings WHERE id = 1').run(); }

async function completion(env: Env, messages: { role: 'system' | 'user'; content: string }[], maxTokens = 4096, jsonMode = false, timeoutMs = 45000) {
  const row = await getRow(env);
  if (!row) throw new ApiFailure(503, 'MODEL_NOT_CONFIGURED', '管理员尚未配置模型');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiKey = await decrypt(env, row);
    const response = await fetch(row.endpoint, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: row.model, messages, temperature: 0, max_tokens: maxTokens, stream: false,
        ...(jsonMode && new URL(row.endpoint).hostname.endsWith('.siliconflow.cn') ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (response.status >= 300 && response.status < 400) throw new ApiFailure(502, 'MODEL_REDIRECT', '模型接口返回重定向；为保护 API Key，已拒绝跟随，请填写最终 HTTPS 地址');
    if (!response.ok) throw new ApiFailure(502, 'MODEL_ERROR', `模型服务返回 ${response.status}，请检查配置或稍后重试`);
    if (!response.body) throw new ApiFailure(502, 'MODEL_FORMAT', '模型返回内容为空');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 80_000) { await reader.cancel(); throw new ApiFailure(502, 'MODEL_TOO_LARGE', '模型返回内容过大'); }
      parts.push(value);
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { merged.set(part, offset); offset += part.byteLength; }
    let data: { choices?: { message?: { content?: string } }[] };
    try { data = JSON.parse(new TextDecoder().decode(merged)); }
    catch { throw new ApiFailure(502, 'MODEL_FORMAT', '模型返回格式无效'); }
    const content = data.choices?.[0]?.message?.content;
    if (!content || content.length > 30000) throw new ApiFailure(502, 'MODEL_FORMAT', '模型未返回可用内容');
    return content;
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (controller.signal.aborted) throw new ApiFailure(504, 'MODEL_TIMEOUT', '模型响应超时，请稍后重试');
    throw new ApiFailure(502, 'MODEL_NETWORK_ERROR', '无法连接模型接口，未收到服务商响应；请联系管理员');
  } finally { clearTimeout(timeout); }
}

export async function testModel(env: Env) {
  const result = await completion(env, [{ role: 'user', content: '请只回复 OK' }], 512);
  return { connected: Boolean(result.trim()) };
}

export async function explainFailure(env: Env, kind: Action['kind'], error: string, completed: number, remaining: number): Promise<string> {
  const content = await completion(env, [
    { role: 'system', content: '你是课程助手。根据系统错误用一句简短中文解释为什么本次操作中断，以及用户下一步可以核对什么。不得声称失败项已执行，不得编造具体课程信息。只输出普通文字。' },
    { role: 'user', content: JSON.stringify({ action: kind, systemError: error.slice(0, 240), completed, remaining }) },
  ], 180, false, 6000);
  return content.trim().slice(0, 300);
}

const modelOutput = z.object({ question: z.string().max(300).optional(), reply: z.string().max(1000).optional(), actions: z.array(actionSchema).max(20) });
export interface ConversationTurn { role: 'user' | 'assistant'; text: string }
function omitNullFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)
      .map(([key, field]) => [key, omitNullFields(field)]));
  }
  return value;
}
function normalizeModelOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const output = value as Record<string, unknown>;
  const actions = Array.isArray(output.actions) ? output.actions
    : output.action && typeof output.action === 'object' ? [output.action]
      : output.actions === undefined && (typeof output.question === 'string' || typeof output.reply === 'string') ? [] : undefined;
  if (!actions) return value;
  return { ...output, actions: actions.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const action = { ...raw } as Record<string, unknown>;
    if (action.filters && typeof action.filters === 'object' && !Array.isArray(action.filters)) {
      const filters = { ...action.filters } as Record<string, unknown>;
      if (typeof filters.classDate === 'string') {
        filters.dateFrom ??= filters.classDate;
        filters.dateTo ??= filters.classDate;
        delete filters.classDate;
      }
      const periods: Record<string, string> = { 上午: 'morning', 下午: 'afternoon', 晚上: 'evening' };
      if (typeof filters.period === 'string') filters.period = periods[filters.period] ?? filters.period;
      action.filters = filters;
    }
    if (action.kind === 'schedule_completion' && (action.completed === 'true' || action.completed === 'false')) action.completed = action.completed === 'true';
    return action;
  }) };
}
const systemPrompt = `你是中文课程管理助手。像正常助手一样用自然、简洁的中文交流，但输出必须是 JSON 对象，不要 Markdown。顶层必须有 actions 数组。课程相关的一般问答、解释或文案协助，使用 reply 字符串和空 actions；仅在确实缺少操作信息时添加 question 字符串，具体询问缺少什么。信息充足时不要输出 question。如果上一轮有待补齐操作，当前消息是补充信息时，把新信息与待补齐操作合成完整 action；如果用户取消或改变目标，以当前消息为准。可以根据最近对话中已显示的系统错误解释失败原因，但不能声称失败项已经执行。reply 不得编造当前课程、用户、余额或执行结果；涉及真实数据的查询必须生成查询 action，涉及写入必须生成操作 action，执行前由系统展示预览并取得确认。仅处理课程相关话题。
允许 kind：schedule_search(filters), schedule_export(filters), schedule_create(fields,repeatWeeks?), schedule_update(filters,fields), schedule_delete(filters), schedule_completion(filters,completed), user_search(filters), hours_balance(filters), user_create(fields), user_update(filters,fields), user_status(filters,status), user_delete(filters), hours_adjust(filters,amountHundredths,note), adjustments_search(filters)。
查询“剩余课时”“课时余额”“还有多少课时”必须使用 hours_balance；当前学生查自己余额时 filters 用空对象；管理员查指定学生时 filters.username 填姓名，查全部学生时 filters 用空对象。查询余额不是调整余额，不能用 hours_adjust。
课程 filters 可用 id,teacherName,studentName,participantName,dateFrom,dateTo,period,startTime,endTime,subject,classroom,completed("true"/"false")；人名是教师还是学生不明确时用 participantName，不要猜身份；上午/下午/晚上分别用 period="morning"/"afternoon"/"evening"。指定日期时同时设置 dateFrom 和 dateTo 为该日期；指定确切时刻才使用 startTime 或 endTime，不要把 classDate 或 studentNames 放进 filters。"点完课"或"标记已完课"用 schedule_completion，completed 为布尔值 true；取消完课时为 false，筛选课程写在 filters 中。删除课程必须用 kind=schedule_delete 和 filters，不要用 fields。用户 filters 可用 id,username,role,status。课程 fields 使用 teacherName、studentNames(姓名数组)、subject、classDate、startTime、endTime、classroom；用户 fields 使用 username、role(ADMIN/TEACHER/STUDENT)、subject、school、grade。新增课程必须有教师、学生、科目、日期和起止时间；新增用户必须有姓名及身份，密码由页面收集。不要猜测数据库 ID。日期用 YYYY-MM-DD，时间用 HH:mm。缺少必填信息请写 question，不要猜结束时间、密码、用户身份或目标。重复排课用 repeatWeeks（包含首周，最多20），不要自行列出20条。调整余额单位为百分之一课时，必须有原因。不要生成密码操作。单次最多20项。`;
const roleInstructions: Record<Role, string> = {
  ADMIN: '当前账号是管理员，可使用上述全部操作。',
  TEACHER: '当前账号是教师，只能查询或导出本人可见课程，以及修改本人课程的完课状态。',
  STUDENT: '当前账号是学生，只能查询或导出本人可见课程，以及查询自己的剩余课时；查询本人课时余额时 filters 用空对象。',
};
export async function parseInstruction(env: Env, input: string, context: ConversationTurn[], role: Role, pendingActions: Action[] = []): Promise<{ question?: string; reply?: string; actions: Action[] }> {
  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: `${systemPrompt}\n${roleInstructions[role]}不允许的操作用 reply 简短说明并返回空 actions。现在北京时间：${now}。将相对日期换算成明确日期。` },
    { role: 'user', content: JSON.stringify({ recentConversation: context.slice(-8).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 500) })), pendingActions: pendingActions.slice(0, 3), instruction: input.slice(0, 1000) }) },
  ];
  let content = await completion(env, messages, 4096, true);
  let lastParsed: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed: unknown;
    try { parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()); }
    catch { parsed = undefined; }
    lastParsed = parsed;
    const result = modelOutput.safeParse(normalizeModelOutput(omitNullFields(parsed)));
    if (result.success) return { actions: result.data.actions, question: result.data.question?.trim() || undefined, reply: result.data.reply?.trim() || undefined };
    if (attempt === 0) {
      const issues = result.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '顶层'}: ${issue.message}`);
      content = await completion(env, [
        { role: 'system', content: '修正课程助手的 JSON 输出。只输出 JSON 对象，顶层为 actions 数组，可有 question 字符串。完课操作为 kind="schedule_completion", filters 对象, completed 布尔值。课程日期写 dateFrom 和 dateTo；上午/下午/晚上写 period="morning"/"afternoon"/"evening"；人名身份不明写 participantName。若目标或意图仍不清楚，返回 question 和空 actions，不猜课程 ID。' },
        { role: 'user', content: JSON.stringify({ now, role, instruction: input.slice(0, 1000), previousOutput: content.slice(0, 2000), validationErrors: issues }) },
      ], 2048, true);
    }
  }
  const question = lastParsed && typeof lastParsed === 'object' && !Array.isArray(lastParsed) &&
    typeof (lastParsed as Record<string, unknown>).question === 'string'
    ? String((lastParsed as Record<string, unknown>).question).trim().slice(0, 300) : '';
  return { actions: [], question: question || '我还不能可靠地确定这项操作。请补充要处理的对象和关键信息，例如课程开始时间或科目。' };
}
