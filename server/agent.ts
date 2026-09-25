import type { Action, Env, ResolvedAction, User } from './core';
import { parseInstruction, type ConversationTurn } from './model';
import { assertSkillRole, detectIntent, isReadOnly, skills } from './skills';
import { expandActions, resolveAction } from './workflow';

export interface AgentPlan {
  reply?: string;
  question?: string;
  actions: ResolvedAction[];
  hasWrites: boolean;
}

export async function planAgentTurn(env: Env, request: Request, user: User, input: string,
  context: ConversationTurn[], pendingActions: Action[]): Promise<AgentPlan> {
  const intent = detectIntent(input, pendingActions);
  if (intent.certain && intent.kind && !skills[intent.kind].roles.includes(user.role)) {
    return { reply: `当前账号没有${skills[intent.kind].name}的权限。`, actions: [], hasWrites: false };
  }

  const parsed = await parseInstruction(env, input, context, user.role, pendingActions, intent.certain ? intent.kind : undefined);
  if (!parsed.actions.length) return {
    reply: parsed.reply,
    question: parsed.question ?? (intent.certain && intent.kind && !parsed.reply ? skills[intent.kind].clarification : undefined),
    actions: [], hasWrites: false,
  };

  if (intent.certain && intent.kind && parsed.actions.some((action) => action.kind !== intent.kind)) {
    return { question: `我理解你想${skills[intent.kind].name}，但这句话也可能指其他操作。请确认你要做什么。`, actions: [], hasWrites: false };
  }

  for (const action of parsed.actions) assertSkillRole(action.kind, user.role);
  const actions = expandActions(parsed.actions);
  const resolved = await Promise.all(actions.map((action) => resolveAction(env, request, user, action)));
  const missing = [...new Set(resolved.flatMap((item) => item.missing ?? []))];
  return {
    question: missing.length ? parsed.question ?? `请补充：${missing.join('、')}` : undefined,
    actions: resolved,
    hasWrites: resolved.some((item) => !isReadOnly(item.action.kind)),
  };
}
