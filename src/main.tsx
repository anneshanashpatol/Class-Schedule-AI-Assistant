import React, { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, Bot, CheckCircle2, Download, Loader2, Send, Settings2, ShieldAlert, Sparkles, X } from 'lucide-react';
import './style.css';

type Role = 'ADMIN' | 'TEACHER' | 'STUDENT';
interface User { id: number; displayName: string; role: Role }
interface Candidate { id: number; label: string; data: Record<string, unknown> }
interface PreviewAction {
  action: { kind: string; filters?: Record<string, unknown>; fields?: Record<string, unknown> };
  label: string; risk: boolean; candidates?: Candidate[]; selected?: Candidate;
  result?: unknown; missing?: string[];
}
interface Preview { question?: string; reply?: string; intentKind?: string; proposalId?: string; expiresInMinutes?: number; actions: PreviewAction[] }
interface Settings { endpoint: string; model: string; hasApiKey: boolean; hasEncryptionKey: boolean }
interface Result { status: string; results: { index: number; status: string; data?: unknown; error?: string }[]; remaining?: number; message?: string; explanation?: string }

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/assistant/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const body = await response.json().catch(() => ({})) as { data?: T; error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? '请求失败');
  return body.data as T;
}
const names: Record<string, string> = {
  schedule_search: '查询课程', schedule_export: '导出课程', schedule_create: '新增课程', schedule_update: '编辑课程',
  schedule_delete: '删除课程', schedule_completion: '调整完课状态', user_search: '查询用户', user_create: '新增用户',
  user_update: '编辑用户', user_status: '修改账号状态', user_delete: '删除用户', hours_balance: '查询剩余课时', hours_adjust: '调整课时余额', adjustments_search: '查询课时调整',
};
const initialExamples = ['本月××号，××:00-××:00，给老师：×××，学生：×××排一节××课', '查一下老师：×××/学生：×××明天的课程', '导出本月的所有课程'];
function formatResultEntry(value: unknown): string {
  if (value === null || value === undefined) return '无记录';
  if (typeof value !== 'object') return String(value);
  if ('label' in value && typeof value.label === 'string') return value.label;
  const row = value as Record<string, unknown>;
  if (typeof row.remainingHundredths === 'number') return `剩余 ${row.remainingHundredths / 100} 课时`;
  if (row.success === true) return '已完成';
  if ('amount_hundredths' in row) {
    const amount = Number(row.amount_hundredths) / 100;
    return `${row.created_at ?? ''} · ${amount > 0 ? '+' : ''}${amount} 课时 · ${row.note ?? ''} · 操作人：${row.operator_name ?? '未知'}`;
  }
  const captions: Record<string, string> = { id: '编号', username: '姓名', display_name: '姓名', role: '身份', status: '状态', subject: '科目', school: '学校', grade: '年级' };
  return Object.entries(row).filter(([key]) => key in captions).map(([key, field]) => `${captions[key]}：${field}`).join('，') || '已获取记录';
}
function assistantSummary(preview: Preview): string {
  if (preview.question) return preview.question;
  if (!preview.actions.length) return preview.reply || '可以继续告诉我你想了解的课程问题。';
  if (preview.proposalId) {
    if (preview.actions.some((item) => item.action.kind === 'schedule_delete')) return '我找到了可能要删除的课程。请核对下方的具体记录；你确认后才会删除。';
    if (preview.actions.some((item) => item.action.kind === 'schedule_create')) return '排课信息整理好了。请先看看日期、时间和上课人员是否正确。';
    if (preview.actions.length === 1 && preview.actions[0].action.kind === 'schedule_completion') {
      const count = preview.actions[0].candidates?.length ?? 0;
      return count > 1 ? `我按你给的线索找到了 ${count} 节课，请在下方选择要调整的那一节，再确认。`
        : '我找到了对应课程。请核对下方的日期、时间和人员，确认后再调整完课状态。';
    }
    return '我整理好了操作内容。请核对下方预览，确认后才会执行。';
  }
  const entries = preview.actions.flatMap((item) => {
    if (Array.isArray(item.result)) return item.result.slice(0, 5).map(formatResultEntry);
    return item.result === undefined ? [] : [formatResultEntry(item.result)];
  }).filter(Boolean);
  if (entries.length) return `查到了：${entries.join('；')}${entries.length >= 5 ? '。更多结果见下方' : ''}`.slice(0, 800);
  if (preview.actions.every((item) => Array.isArray(item.result) && item.result.length === 0)) return '暂时没有找到符合条件的记录。可以换个日期或名字再试。';
  return preview.reply || '查询完成，结果见下方。';
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState('');
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [activeIntent, setActiveIntent] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [approval, setApproval] = useState<number[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { api<User>('/me').then(setUser).catch((reason) => setAuthError(reason instanceof Error ? reason.message : '登录状态无效')).finally(() => setLoading(false)); }, []);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!input.trim() || busy) return;
    const message = input.trim();
    setInput(''); setBusy(true); setError(''); setResult(null);
    const context = history.slice(-8).map((item) => ({ role: item.role, text: item.text.slice(0, 500) }));
    const pendingActions = preview?.question ? preview.actions.slice(0, 3).map((item) => item.action) : [];
    setHistory((items) => [...items, { role: 'user', text: message }]);
    try {
      const next = await api<Preview>('/interpret', { method: 'POST', body: JSON.stringify({ input: message, context, pendingActions, activeIntent }) });
      if (next.actions.length) {
        setPreview(next); setSelection({}); setApproval([]); setPasswords({});
      } else if (!next.intentKind) {
        setPreview(null); setSelection({}); setApproval([]); setPasswords({});
      }
      setActiveIntent(next.intentKind ?? null);
      setHistory((items) => [...items, { role: 'assistant', text: assistantSummary(next) }]);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '解析失败';
      setError(message);
      setHistory((items) => [...items, { role: 'assistant', text: message }]);
    }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!preview?.proposalId || busy) return;
    setBusy(true); setError('');
    try {
      const response = await api<Result>('/confirm', { method: 'POST', body: JSON.stringify({ proposalId: preview.proposalId, selections: selection, approvals: approval, passwords }) });
      setResult(response);
      setActiveIntent(null);
      const failed = response.results.find((item) => item.status === 'failed');
      const summary = response.status === 'DONE' ? `操作已完成，共成功 ${response.results.length} 项。`
        : failed ? `第 ${failed.index + 1} 项没有完成：${failed.error ?? '原因未知'}。之前成功 ${response.results.filter((item) => item.status === 'success').length} 项，后面还有 ${response.remaining ?? 0} 项未执行。${response.explanation ? `AI 补充：${response.explanation}` : '可以继续问我原因。'}`
          : response.message ?? '操作状态还在核实中，请不要重复提交。';
      setHistory((items) => [...items, { role: 'assistant', text: summary }]);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '执行失败';
      setError(message);
      setHistory((items) => [...items, { role: 'assistant', text: `这次没能确认执行结果：${message}。请先到原课程表核对，避免重复操作。` }]);
    }
    finally { setBusy(false); }
  }

  async function exportExcel(filters: Record<string, unknown>) {
    setBusy(true); setError('');
    try {
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; offset < 10000; offset += 500) {
        const params = new URLSearchParams();
        Object.entries(filters).forEach(([key, value]) => { if (!['startTime', 'endTime', 'participantName', 'period'].includes(key) && value !== undefined && value !== '') params.set(key, String(value)); });
        params.set('offset', String(offset)); params.set('limit', '500');
        const batch = await api<Record<string, unknown>[]>(`/export-data?${params}`);
        rows.push(...batch.filter((row) => {
          const start = String(row.start_time ?? '');
          const people = [row.teacher_name, ...(Array.isArray(row.student_names) ? row.student_names : [])]
            .map((name) => String(name).trim().replace(/(?:老师|同学)$/, ''));
          const periodMatches = !filters.period || (filters.period === 'morning' ? start < '12:00' : filters.period === 'afternoon' ? start >= '12:00' && start < '18:00' : start >= '18:00');
          return (!filters.startTime || start === filters.startTime) && (!filters.endTime || row.end_time === filters.endTime) &&
            (!filters.participantName || people.includes(String(filters.participantName).trim().replace(/(?:老师|同学)$/, ''))) && periodMatches;
        }));
        if (batch.length < 500) break;
        if (offset === 9500) throw new Error('匹配课程超过 10000 条，请缩小导出范围');
      }
      const { Workbook } = await import('exceljs');
      const book = new Workbook(); const sheet = book.addWorksheet('课程');
      sheet.columns = [
        { header: '日期', key: 'date', width: 16 }, { header: '时间', key: 'time', width: 20 },
        { header: '科目', key: 'subject', width: 20 }, { header: '教师', key: 'teacher', width: 16 },
        { header: '学生', key: 'students', width: 28 }, { header: '教室', key: 'classroom', width: 16 },
        { header: '完课', key: 'completed', width: 12 },
      ];
      const safe = (value: unknown) => { const text = String(value ?? ''); return /^[=+\-@]/.test(text) ? `'${text}` : text; };
      rows.forEach((row) => sheet.addRow({ date: row.class_date, time: `${row.start_time}–${row.end_time}`, subject: safe(row.subject), teacher: safe(row.teacher_name), students: safe(Array.isArray(row.student_names) ? row.student_names.join('、') : ''), classroom: safe(row.classroom), completed: row.is_completed ? '是' : '否' }));
      const buffer = await book.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const link = document.createElement('a'); link.href = url; link.download = `课程导出-${new Date().toISOString().slice(0, 10)}.xlsx`; link.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导出失败'); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="center"><Loader2 className="spin" /><p>正在核对登录状态…</p></main>;
  if (!user) return <main className="center"><ShieldAlert size={38} /><h1>请先登录原网站</h1><p>{authError}</p><a className="button" href="/login?next=/assistant">前往登录</a></main>;
  return <div className="app">
    <header className="topbar"><a className="back" href="/calendar"><ArrowLeft size={18} />返回课程表</a><div className="brand"><span className="brand-mark">π</span><span>前程π <b>AI 助手</b></span></div><div className="top-actions"><span className="identity">{user.displayName} · {user.role === 'ADMIN' ? '管理员' : user.role === 'TEACHER' ? '教师' : '学生'}</span>{user.role === 'ADMIN' && <button className="icon-button" title="模型设置" aria-label="模型设置" onClick={() => setSettingsOpen(true)}><Settings2 size={20} /></button>}</div></header>
    <div className="workspace"><aside className="intro"><div className="eyebrow"><Sparkles size={16} /> 自然语言工作台</div><h1>用一句话<br />安排接下来的课程。</h1><p>描述你想查询或操作的课程、用户。助手会先核对信息，再给你确认。</p><div className="intro-note"><ShieldAlert size={18} /><span>删除、停用、课时调整和排课时间重叠会逐条二次确认。所有权限以当前账号为准。</span></div></aside>
      <main className="chat"><div className="chat-head"><div className="bot-avatar"><Bot size={22} /></div><div><h2>课程助手</h2><span>可以聊天和处理课程 · 刷新后清空对话</span></div></div>
        <div className="feed" aria-live="polite">{history.length === 0 && <div className="welcome"><div className="welcome-symbol"><Sparkles size={24} /></div><h3>今天想处理什么？</h3><p>可以从下面的例子开始，也可以直接输入你的需求。</p><div className="examples">{initialExamples.map((text) => <button key={text} onClick={() => setInput(text)}>{text}</button>)}</div></div>}
          {history.map((item, index) => <div className={`bubble bubble--${item.role}`} key={index}>{item.text}</div>)}
          {preview && <div className="preview"><div className="preview-title"><h3>操作预览</h3>{preview.expiresInMinutes && <small>{preview.expiresInMinutes} 分钟内有效</small>}</div>{preview.actions.map((item, index) => <section className="action" key={index}><div className="action-top"><span className="number">{index + 1}</span><strong>{names[item.action.kind] ?? item.action.kind}</strong>{item.risk && <span className="risk">需逐条确认</span>}</div><p>{item.label}</p>{item.candidates && item.candidates.length > 1 && <label className="field">选择目标<select value={selection[String(index)] ?? ''} onChange={(event) => setSelection((old) => ({ ...old, [index]: Number(event.target.value) }))}><option value="">请选择</option>{item.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>}{item.result !== undefined && item.action.kind !== 'schedule_export' && <div className="read-result">{Array.isArray(item.result) ? (item.result.length ? item.result.map((entry, i) => <div key={i}>{typeof entry === 'object' && entry && 'label' in entry ? String(entry.label) : formatResultEntry(entry)}</div>) : '没有结果') : formatResultEntry(item.result)}</div>}{item.action.kind === 'schedule_export' && <button className="secondary" disabled={busy} onClick={() => void exportExcel(item.action.filters ?? {})}><Download size={16} />下载 Excel</button>}{item.action.kind === 'user_create' && preview.proposalId && <label className="field">初始密码<input type="password" autoComplete="new-password" minLength={5} value={passwords[String(index)] ?? ''} onChange={(event) => setPasswords((old) => ({ ...old, [index]: event.target.value }))} placeholder="仅用于创建账号，不发送给模型" /></label>}{item.risk && preview.proposalId && <label className="approval"><input type="checkbox" checked={approval.includes(index)} onChange={(event) => setApproval((old) => event.target.checked ? [...old, index] : old.filter((value) => value !== index))} /><span>我已核对第 {index + 1} 项的目标和影响，确认执行</span></label>}</section>)}{preview.proposalId && !result && <button className="button confirm" disabled={busy || preview.actions.some((item, index) => item.risk && !approval.includes(index))} onClick={() => void confirm()}>{busy ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}确认执行</button>}</div>}
          {result && <div className="result"><h3>{result.status === 'DONE' ? '执行完成' : '执行中断'}</h3>{result.results.map((item) => <p key={item.index}>第 {item.index + 1} 项：{item.status === 'success' ? `成功${item.data == null ? '' : ` · ${formatResultEntry(item.data)}`}` : `失败 · ${item.error}`}</p>)}{Boolean(result.remaining) && <small>其余 {result.remaining} 项未执行。</small>}{result.explanation && <p>AI 补充：{result.explanation}</p>}{result.message && <small>{result.message}</small>}</div>}
          {error && <div className="error" role="alert">{error}</div>}{busy && !preview && <div className="thinking"><Loader2 className="spin" size={17} />正在理解并核对…</div>}</div>
        <form className="composer" onSubmit={(event) => void send(event)}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：本月××号，××:00-××:00，给老师：×××，学生：×××排一节××课" maxLength={1000} rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} /><div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button className="button" disabled={busy || !input.trim()} aria-label="发送指令"><Send size={17} />发送</button></div></form>
      </main></div>{settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [endpoint, setEndpoint] = useState(''); const [model, setModel] = useState(''); const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [generatedKey, setGeneratedKey] = useState('');
  useEffect(() => { api<Settings>('/settings').then((data) => { setSettings(data); setEndpoint(data.endpoint); setModel(data.model); }).catch((reason) => setError(reason instanceof Error ? reason.message : '加载失败')); }, []);
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); setMessage(''); try { const saved = await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify({ endpoint, model, apiKey: apiKey || undefined }) }); setSettings(saved); setApiKey(''); setMessage('配置已保存'); } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); } finally { setBusy(false); } }
  async function test() { setBusy(true); setError(''); setMessage(''); try { await api('/settings/test', { method: 'POST' }); setMessage('连接成功'); } catch (reason) { setError(reason instanceof Error ? reason.message : '连接失败'); } finally { setBusy(false); } }
  async function clear() { if (!confirm('确定清除模型配置和 API Key？')) return; setBusy(true); try { await api('/settings', { method: 'DELETE' }); setSettings({ endpoint: '', model: '', hasApiKey: false, hasEncryptionKey: Boolean(settings?.hasEncryptionKey) }); setEndpoint(''); setModel(''); setApiKey(''); setMessage('配置已清除'); } catch (reason) { setError(reason instanceof Error ? reason.message : '清除失败'); } finally { setBusy(false); } }
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-head"><div><span className="eyebrow">管理员设置</span><h2 id="settings-title">模型连接</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div><p>全站共用这一套 OpenAI 兼容接口配置。密钥仅保存在服务端。</p>{settings && !settings.hasEncryptionKey && <div className="error"><p>先在新 Worker 的 Cloudflare Secret 中配置 AI_CONFIG_KEY。生成后复制到 Cloudflare 后台；关闭页面后这里不会保存密钥。</p><button className="secondary" type="button" onClick={() => { const bytes = crypto.getRandomValues(new Uint8Array(32)); setGeneratedKey(btoa(String.fromCharCode(...bytes))); }}>生成加密密钥</button>{generatedKey && <code className="generated-key">{generatedKey}</code>}</div>}<form onSubmit={(event) => void save(event)}><label className="field">接口地址<input type="url" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://example.com/v1" /></label><label className="field">模型名称<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="填写服务商提供的模型 ID" /></label><label className="field">API Key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? '已配置；留空表示不更换' : '请输入 API Key'} /></label>{error && <div className="error" role="alert">{error}</div>}{message && <div className="success">{message}</div>}<div className="dialog-actions"><button className="text-danger" type="button" onClick={() => void clear()} disabled={busy || !settings?.hasApiKey}>清除配置</button><button className="secondary" type="button" onClick={() => void test()} disabled={busy || !settings?.hasApiKey}>测试连接</button><button className="button" disabled={busy}>保存配置</button></div></form></section></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
