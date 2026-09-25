import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAgentTurn } from '../server/agent';
import { detectIntent, skills } from '../server/skills';
import { expandActions } from '../server/workflow';
import { ApiFailure, type Env, type User } from '../server/core';

test('能力表覆盖所有操作，并保留多目的和课程问答判断', () => {
  assert.equal(Object.keys(skills).length, 14);
  assert.deepEqual(detectIntent('下周二排课'), { kind: 'schedule_create', certain: true });
  assert.deepEqual(detectIntent('查剩余课时'), { kind: 'hours_balance', certain: true });
  assert.deepEqual(detectIntent('排课怎么操作'), { certain: false });
  assert.deepEqual(detectIntent('排课，再查剩余课时'), { certain: false });
  assert.deepEqual(detectIntent('排课，顺便看一下其他数据'), { certain: false });
});

test('学生和教师明确请求无权操作时直接告知，不调用模型', async () => {
  const env = {} as Env;
  const request = new Request('https://qcp.dpdns.org/assistant/api/interpret');
  const student = { id: 1, role: 'STUDENT' } as User;
  const teacher = { id: 2, role: 'TEACHER' } as User;
  const studentPlan = await planAgentTurn(env, request, student, '帮我排课', [], []);
  const teacherPlan = await planAgentTurn(env, request, teacher, '删除这节课', [], []);
  assert.match(studentPlan.reply ?? '', /没有.*权限/);
  assert.match(teacherPlan.reply ?? '', /没有.*权限/);
  assert.deepEqual(studentPlan.actions, []);
  assert.deepEqual(teacherPlan.actions, []);
});

test('一次只允许一个删除操作', () => {
  assert.throws(() => expandActions([
    { kind: 'schedule_delete', filters: { dateFrom: '2026-09-27' } },
    { kind: 'user_delete', filters: { username: '王老师' } },
  ]), (error: unknown) => error instanceof ApiFailure && error.code === 'BULK_DELETE_UNSUPPORTED');
});
