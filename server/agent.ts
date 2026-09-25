import type { Action, Env, ResolvedAction, User } from './core';
import { parseInstruction, type ConversationTurn } from './model';
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
  if (/^(?:算了|不用了|停止|换个话题|别弄了|(?:取消|撤销)(?:刚才|之前|这个|那项|这项|操作|任务|计划))/.test(input.trim()))
    return { reply: '好的，先不继续这项操作。', actions: [], hasWrites: false };
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
