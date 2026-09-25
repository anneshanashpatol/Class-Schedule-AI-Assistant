import { z } from 'zod';
import { actionSchema, ApiFailure, type Action, type Env } from './core';

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

async function completion(env: Env, messages: { role: 'system' | 'user'; content: string }[], maxTokens = 4096, diagnostics = false) {
  const row = await getRow(env);
  if (!row) throw new ApiFailure(503, 'MODEL_NOT_CONFIGURED', '管理员尚未配置模型');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let apiKey = '';
  try {
    apiKey = await decrypt(env, row);
    const response = await fetch(row.endpoint, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: row.model, messages, temperature: 0, max_tokens: maxTokens, stream: false }),
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
    if (controller.signal.aborted) throw new ApiFailure(504, 'MODEL_TIMEOUT', '模型在 45 秒内未响应，请稍后重试');
    const type = error instanceof Error ? error.name : typeof error;
    const rawDetail = error instanceof Error ? error.message : String(error);
    const detail = (apiKey ? rawDetail.replaceAll(apiKey, '[redacted]') : rawDetail).replace(/[\r\n]+/g, ' ').slice(0, 200);
    console.error('Model API network failure', {
      host: new URL(row.endpoint).hostname,
      type,
      detail,
    });
    throw new ApiFailure(502, 'MODEL_NETWORK_ERROR', diagnostics
      ? `无法连接模型接口，未收到服务商响应（${type}: ${detail}）`
      : '无法连接模型接口，未收到服务商响应；请联系管理员');
  } finally { clearTimeout(timeout); }
}

export async function testModel(env: Env) {
  const result = await completion(env, [{ role: 'user', content: '请只回复 OK' }], 512, true);
  return { connected: Boolean(result.trim()) };
}

const modelOutput = z.object({ question: z.string().max(300).optional(), actions: z.array(actionSchema).max(20) });
const systemPrompt = `你是中文排课管理指令解析器。只输出 JSON 对象，不要 Markdown。格式 {"question":"信息不足时的简短追问，可省略","actions":[...]}。
允许 kind：schedule_search(filters), schedule_export(filters), schedule_create(fields,repeatWeeks?), schedule_update(filters,fields), schedule_delete(filters), schedule_completion(filters,completed), user_search(filters), user_create(fields), user_update(filters,fields), user_status(filters,status), user_delete(filters), hours_adjust(filters,amountHundredths,note), adjustments_search(filters)。
课程 filters 可用 id,teacherName,studentName,dateFrom,dateTo,subject,classroom,completed("true"/"false")；用户 filters 可用 id,username,role,status。不要猜测数据库 ID。日期用 YYYY-MM-DD，时间用 HH:mm。缺少必填信息请写 question，不要猜结束时间、密码、用户身份或目标。重复排课用 repeatWeeks（包含首周，最多20），不要自行列出20条。调整余额单位为百分之一课时，必须有原因。不要生成密码操作。单次最多20项。`;
export async function parseInstruction(env: Env, input: string, context: string[]): Promise<{ question?: string; actions: Action[] }> {
  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const content = await completion(env, [
    { role: 'system', content: `${systemPrompt}\n现在北京时间：${now}。将相对日期换算成明确日期。` },
    { role: 'user', content: JSON.stringify({ recentContext: context.slice(-4).map((text) => text.slice(0, 300)), instruction: input.slice(0, 1000) }) },
  ]);
  let parsed: unknown;
  try { parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new ApiFailure(502, 'MODEL_FORMAT', '模型返回格式不正确，请换一种说法重试'); }
  const result = modelOutput.safeParse(parsed);
  if (!result.success) throw new ApiFailure(502, 'MODEL_FORMAT', '模型返回的操作不符合约定，请换一种说法重试');
  return result.data;
}
