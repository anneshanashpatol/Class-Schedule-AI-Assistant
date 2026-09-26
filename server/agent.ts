import type { Action, Env, ResolvedAction, User } from './core';
import { decideTurn, parseInstruction, type ConversationTurn } from './model';
import { assertSkillRole, detectIntent, isReadOnly, type Kind } from './skills';
import { expandActions, resolveAction } from './workflow';

export interface AgentPlan {
  reply?: string;
  question?: string;
  actions: ResolvedAction[];
  hasWrites: boolean;
  intentKind?: Kind;
}

const hourQuantity = /(?<![\d.])(\d+(?:\.\d{1,2})?|半|[一二两三四五六七八九十]+)(?:个)?(半)?\s*课时(?![\d.])/g;
const hourDirection = /增加|添加|加上|加|补充|补回|充值|返还|减少|删减|删除|扣除|扣掉|减掉|扣|减/g;
const negativeHours = /^(?:减少|删减|删除|扣除|扣掉|减掉|扣|减)$/;

function chineseHours(value: string): number | undefined {
  if (value === '半') return 0.5;
  if (/^\d+(?:\.\d{1,2})?$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    if ((tens && !digits[tens]) || (ones && !digits[ones])) return undefined;
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return digits[value];
}

export function hoursFromUserWords(input: string): number | undefined {
  const matches = [...input.matchAll(hourQuantity)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const hours = chineseHours(match[1]);
  const total = hours === undefined ? undefined : hours + (match[2] ? 0.5 : 0);
  if (total === undefined || total <= 0 || !Number.isSafeInteger(Math.round(total * 100)) ||
      Math.abs(total * 100 - Math.round(total * 100)) > 1e-8) return undefined;
  const before = input.slice(0, match.index);
  if (/(?:不要|别|不是|取消|不用).{0,12}$/.test(before)) return undefined;
  const directions = [...before.matchAll(hourDirection)];
  const direction = directions.at(-1)?.[0];
  if (!direction) return undefined;
  return Math.round(total * 100) * (negativeHours.test(direction) ? -1 : 1);
}

function groundHourActions(actions: Action[], input: string, context: ConversationTurn[], pendingActions: Action[], activeKind?: Kind): Action[] {
  let amount = hoursFromUserWords(input);
  if (amount === undefined && [...input.matchAll(hourQuantity)].length === 0 && activeKind === 'hours_adjust') {
    const pendingHours = pendingActions.filter((action) => action.kind === 'hours_adjust');
    if (pendingHours.length === 1) amount = pendingHours[0].amountHundredths;
    else amount = hoursFromUserWords(context.filter((turn) => turn.role === 'user').at(-1)?.text ?? '');
  }
  return actions.map((action) => action.kind === 'hours_adjust'
    ? { ...action, amountHundredths: amount ?? 0 } : action);
}

function groundActions(actions: Action[], input: string, context: ConversationTurn[], activeKind?: Kind): Action[] {
  const userWords = activeKind && input.length < 12
    ? [...context.filter((turn) => turn.role === 'user').slice(-4).map((turn) => turn.text), input].join(' ')
    : input;
  const relativeDays = [/(?:今天|今日)/.test(userWords) ? 0 : undefined, /明天/.test(userWords) ? 1 : undefined,
    /后天/.test(userWords) ? 2 : undefined].filter((day): day is number => day !== undefined);
  const statedDay = relativeDays.length === 1 ? relativeDays[0] : undefined;
  const beijingToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date());
  const groundedDate = statedDay === undefined ? undefined : (() => {
    const date = new Date(`${beijingToday}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + statedDay);
    return date.toISOString().slice(0, 10);
  })();
  return actions.map((action) => {
    if ('filters' in action) {
      const filters = { ...action.filters };
      if ('period' in filters && !/上午|早上|下午|中午|傍晚|晚上|晚间|夜里/.test(userWords)) delete filters.period;
      if (groundedDate && action.kind.startsWith('schedule_')) {
        (filters as Record<string, unknown>).dateFrom = groundedDate;
        (filters as Record<string, unknown>).dateTo = groundedDate;
      }
      return { ...action, filters } as Action;
    }
    if (action.kind === 'schedule_create' && groundedDate && action.fields.classDate)
      return { ...action, fields: { ...action.fields, classDate: groundedDate } };
    return action;
  });
}

export async function planAgentTurn(env: Env, request: Request, user: User, input: string,
  context: ConversationTurn[], pendingActions: Action[], activeKind?: Kind): Promise<AgentPlan> {
  const compactInput = input.trim().replace(/[\s，,。.!！]/g, '');
  if (/^(?:你好|您好|嗨|哈喽|hello|hi|在吗)[？?]*$/i.test(compactInput))
    return { reply: '你好呀，想聊什么？', actions: [], hasWrites: false };
  if (/^(?:(?:谢谢|多谢|辛苦了|好|好的|好吧|行|嗯|明白了|知道了)(?:先这样|就这样|不用了|没事了)?|先这样|就这样|没事|没事了)$/.test(compactInput))
    return { reply: '好，随时需要查课或调整课程，继续告诉我就行。', actions: [], hasWrites: false };
  if (/^(?:算了|不用了|停止|换个话题|别弄了|(?:取消|撤销)(?:刚才|之前|这个|那项|这项|操作|任务|计划))/.test(input.trim()))
    return { reply: '好的，先不继续这项操作。', actions: [], hasWrites: false };
  const decision = await decideTurn(env, input, context, user.role, activeKind, pendingActions);
  if (/(?:没(?:有)?让你|我没说|不是(?:要|让你)|别(?:查|弄|做)|不要(?:查|弄|做))/.test(input)) {
    decision.mode = 'cancel';
    decision.reply = '抱歉，我理解错了。刚才那项操作不会继续，你可以直接告诉我想聊什么。';
  }
  if (decision.mode !== 'action') return { reply: decision.reply, actions: [], hasWrites: false,
    intentKind: decision.mode === 'cancel' ? undefined : activeKind };
  const instruction = activeKind && input.length < 12 && decision.request ? `${input}。结合前文：${decision.request}` : input;
  const parsed = await parseInstruction(env, instruction, context, user.role, pendingActions, activeKind);
  const continuedKind = parsed.intentKind ?? activeKind ?? detectIntent(input, pendingActions).kind;
  if (!parsed.actions.length) return {
    reply: parsed.reply,
    question: parsed.question,
    actions: [], hasWrites: false, intentKind: continuedKind,
  };

  const grounded = groundHourActions(groundActions(parsed.actions, input, context, activeKind), input, context, pendingActions, activeKind);
  for (const action of grounded) assertSkillRole(action.kind, user.role);
  const actions = expandActions(grounded);
  const resolved = await Promise.all(actions.map((action) => resolveAction(env, request, user, action)));
  const missing = [...new Set(resolved.flatMap((item) => item.missing ?? []))];
  return {
    question: missing.length ? parsed.question ?? `请补充：${missing.join('、')}` : parsed.question,
    actions: resolved,
    hasWrites: resolved.some((item) => !isReadOnly(item.action.kind)),
    intentKind: resolved.length === 1 ? resolved[0].action.kind : continuedKind,
  };
}
