import type { Action, Env, ResolvedAction, User } from './core';
import { answerConversation, parseInstruction, type ConversationTurn } from './model';
import { assertSkillRole, detectIntent, isReadOnly, type Kind } from './skills';
import { expandActions, resolveAction } from './workflow';

export interface AgentPlan {
  reply?: string;
  question?: string;
  actions: ResolvedAction[];
  hasWrites: boolean;
  intentKind?: Kind;
}

export async function planAgentTurn(env: Env, request: Request, user: User, input: string,
  context: ConversationTurn[], pendingActions: Action[], activeKind?: Kind): Promise<AgentPlan> {
  const compactInput = input.trim().replace(/[\s，,。.!！]/g, '');
  if (/^(?:(?:谢谢|多谢|辛苦了|好|好的|好吧|行|嗯|明白了|知道了)(?:先这样|就这样|不用了|没事了)?|先这样|就这样|没事|没事了)$/.test(compactInput))
    return { reply: '好，随时需要查课或调整课程，继续告诉我就行。', actions: [], hasWrites: false };
  if (/^(?:算了|不用了|停止|换个话题|别弄了|(?:取消|撤销)(?:刚才|之前|这个|那项|这项|操作|任务|计划))/.test(input.trim()))
    return { reply: '好的，先不继续这项操作。', actions: [], hasWrites: false };
  if (/^(?:你(?:是谁|能做什么|会什么|可以做什么|怎么用)|(?:怎么|如何)(?:使用|用这个助手)|(?:请)?介绍(?:一下)?(?:你|功能)|什么是(?:一)?课时|解释(?:一下)?(?:这个错误|失败原因))/.test(input.trim())) {
    return { reply: await answerConversation(env, input, context, user.role), actions: [], hasWrites: false, intentKind: activeKind };
  }
  const parsed = await parseInstruction(env, input, context, user.role, pendingActions, activeKind);
  const continuedKind = parsed.intentKind ?? activeKind ?? detectIntent(input, pendingActions).kind;
  if (!parsed.actions.length) return {
    reply: parsed.reply,
    question: parsed.question,
    actions: [], hasWrites: false, intentKind: continuedKind,
  };

  for (const action of parsed.actions) assertSkillRole(action.kind, user.role);
  const actions = expandActions(parsed.actions);
  const resolved = await Promise.all(actions.map((action) => resolveAction(env, request, user, action)));
  const missing = [...new Set(resolved.flatMap((item) => item.missing ?? []))];
  return {
    question: missing.length ? parsed.question ?? `请补充：${missing.join('、')}` : parsed.question,
    actions: resolved,
    hasWrites: resolved.some((item) => !isReadOnly(item.action.kind)),
    intentKind: resolved.length === 1 ? resolved[0].action.kind : continuedKind,
  };
}
