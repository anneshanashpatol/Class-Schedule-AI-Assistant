import { z } from 'zod';
import { actionSchema, ApiFailure, type Action, type Env, type Role } from './core';
import { agentInstructions } from './agent-instructions.generated';
import { skillPrompt, skills } from './skills';

interface SettingRow { endpoint: string; model: string; key_ciphertext: string; key_iv: string }
const planTool = { type: 'function', function: { name: 'submit_course_action_plan',
  description: '提交课程助手的本轮回复、追问和工具操作请求。课程及用户查询由 Worker 执行，写操作只生成预览。',
  parameters: { type: 'object', properties: {
    actions: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: Object.keys(skills) }, filters: { type: 'object' }, fields: { type: 'object' },
      completed: { type: 'boolean' }, status: { type: 'string' }, repeatWeeks: { type: 'integer' },
      amountHundredths: { type: 'integer' }, note: { type: 'string' },
    }, required: ['kind'] } },
    reply: { type: 'string' }, question: { type: 'string' }, intentKind: { type: 'string', enum: Object.keys(skills) },
  }, required: ['actions'] },
} } as const;
const nativeToolsUnavailable = new Set<string>();
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

async function completion(env: Env, messages: { role: 'system' | 'user' | 'assistant'; content: string }[], maxTokens = 4096, jsonMode = false, timeoutMs = 45000, preferTools = false) {
  const row = await getRow(env);
  if (!row) throw new ApiFailure(503, 'MODEL_NOT_CONFIGURED', '管理员尚未配置模型');
  const useTools = preferTools && row.model === 'THUDM/GLM-4-9B-0414' &&
    new URL(row.endpoint).hostname.endsWith('.siliconflow.cn') && !nativeToolsUnavailable.has(row.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiKey = await decrypt(env, row);
    const response = await fetch(row.endpoint, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: row.model, messages, temperature: 0, max_tokens: maxTokens, stream: false,
        ...(useTools ? { tools: [planTool], tool_choice: 'auto' }
          : jsonMode && new URL(row.endpoint).hostname.endsWith('.siliconflow.cn') ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (response.status >= 300 && response.status < 400) throw new ApiFailure(502, 'MODEL_REDIRECT', '模型接口返回重定向；为保护 API Key，已拒绝跟随，请填写最终 HTTPS 地址');
    if (useTools && (response.status === 400 || response.status === 422)) {
      nativeToolsUnavailable.add(row.endpoint);
      return completion(env, messages, maxTokens, jsonMode, timeoutMs, false);
    }
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
    let data: { choices?: { message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
    try { data = JSON.parse(new TextDecoder().decode(merged)); }
    catch { throw new ApiFailure(502, 'MODEL_FORMAT', '模型返回格式无效'); }
    const message = data.choices?.[0]?.message;
    if (useTools && message?.tool_calls?.length) {
      if (message.tool_calls.length > 3 || message.tool_calls.some((call) => call.function?.name !== planTool.function.name)) {
        nativeToolsUnavailable.add(row.endpoint);
        return completion(env, messages, maxTokens, jsonMode, timeoutMs, false);
      }
      try {
        const plans = message.tool_calls.map((call) => JSON.parse(call.function?.arguments ?? '')) as Record<string, unknown>[];
        return JSON.stringify({ ...plans[0], actions: plans.flatMap((plan) => Array.isArray(plan.actions) ? plan.actions : []) });
      } catch {
        nativeToolsUnavailable.add(row.endpoint);
        return completion(env, messages, maxTokens, jsonMode, timeoutMs, false);
      }
    }
    const content = message?.content;
    if (useTools && !content) {
      nativeToolsUnavailable.add(row.endpoint);
      return completion(env, messages, maxTokens, jsonMode, timeoutMs, false);
    }
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

const modelOutput = z.object({ question: z.string().max(300).optional(), reply: z.string().max(1000).optional(),
  intentKind: z.enum(Object.keys(skills) as [Action['kind'], ...Action['kind'][]]).optional(), actions: z.array(actionSchema).max(20) });
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
        if ((filters.dateFrom && filters.dateFrom !== filters.classDate) || (filters.dateTo && filters.dateTo !== filters.classDate)) return raw;
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
export async function parseInstruction(env: Env, input: string, context: ConversationTurn[], role: Role, pendingActions: Action[] = [], activeKind?: Action['kind']): Promise<{ question?: string; reply?: string; intentKind?: Action['kind']; actions: Action[] }> {
  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const today = now.slice(0, 10);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDate = tomorrow.toISOString().slice(0, 10);
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: `${agentInstructions}\n当前账号是${role === 'ADMIN' ? '管理员' : role === 'TEACHER' ? '教师' : '学生'}。${activeKind ? `上轮目标是 ${activeKind}（${skills[activeKind].name}）；若当前消息只是补充，继续该目标，不重新要求已有线索。` : ''}你可以在全部能力中选择本轮需要的工具。若用户转到新目标，以新目标为准；若只是闲聊或致谢，自然回复且 actions 为空，不能重复执行操作。\n${skillPrompt()}\n现在北京时间：${now}。今天是 ${today}，明天是 ${tomorrowDate}。将相对日期换算成明确日期。无权限时使用 reply 和空 actions。` },
    { role: 'user', content: JSON.stringify({ recentConversation: context.slice(-8).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 500) })), pendingActions: pendingActions.slice(0, 3), instruction: input.slice(0, 1000) }) },
  ];
  let content = await completion(env, messages, 4096, true, 45000, true);
  let lastParsed: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed: unknown;
    try { parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()); }
    catch { parsed = undefined; }
    lastParsed = parsed;
    const result = modelOutput.safeParse(normalizeModelOutput(omitNullFields(parsed)));
    if (result.success) return { actions: result.data.actions, question: result.data.question?.trim() || undefined, reply: result.data.reply?.trim() || undefined,
      ...(result.data.intentKind ? { intentKind: result.data.intentKind } : {}) };
    if (attempt === 0) {
      const issues = result.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '顶层'}: ${issue.message}`);
      content = await completion(env, [
        { role: 'system', content: `修正课程助手的 JSON 输出。只输出 JSON 对象，顶层为 actions 数组，可有 question 字符串。${skillPrompt()}若目标或意图仍不清楚，返回 question 和空 actions，不猜课程 ID。` },
        { role: 'user', content: JSON.stringify({ now, role, instruction: input.slice(0, 1000), previousOutput: content.slice(0, 2000), validationErrors: issues }) },
      ], 2048, true);
    }
  }
  const question = lastParsed && typeof lastParsed === 'object' && !Array.isArray(lastParsed) &&
    typeof (lastParsed as Record<string, unknown>).question === 'string'
    ? String((lastParsed as Record<string, unknown>).question).trim().slice(0, 300) : '';
  return { actions: [], question: question || '我还不能可靠地确定这项操作。请补充要处理的对象和关键信息。', intentKind: activeKind };
}

export async function answerConversation(env: Env, input: string, context: ConversationTurn[], role: Role): Promise<string> {
  const answer = await completion(env, [
    { role: 'system', content: `你是前程π课程小助手。当前账号身份：${role}。只回答最后一条用户消息，用自然、简洁的中文。你可介绍排课、查课、完课、课时和账号管理的能力与确认流程，但不能编造实时课程、用户、余额或执行结果。若问题需要真实数据，说明可以帮用户查询。不要输出 JSON。` },
    ...context.slice(-6).map((turn) => ({ role: turn.role, content: turn.text.slice(0, 500) })),
    { role: 'user', content: input.slice(0, 1000) },
  ], 400, false, 12000);
  return answer.trim().slice(0, 1000);
}
