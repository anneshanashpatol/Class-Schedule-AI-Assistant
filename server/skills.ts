import { ApiFailure, type Action, type Role } from './core';

export type Kind = Action['kind'];
interface Skill {
  name: string;
  roles: readonly Role[];
  readOnly: boolean;
  instruction: string;
  clarification: string;
}
const everyone = ['ADMIN', 'TEACHER', 'STUDENT'] as const;
const managers = ['ADMIN'] as const;

export const skills: Record<Kind, Skill> = {
  schedule_search: { name: '查询课程', roles: everyone, readOnly: true,
    instruction: '使用 filters 查询日期、教师、学生、科目、完课状态等；空 filters 表示当前账号可见课程。',
    clarification: '请补充想查的课程日期、教师、学生或科目。' },
  schedule_export: { name: '导出课程', roles: everyone, readOnly: true,
    instruction: '使用 filters 确定要导出的当前账号可见课程，结果由页面下载 Excel。',
    clarification: '请补充要导出的课程范围或筛选条件。' },
  schedule_create: { name: '新增课程', roles: managers, readOnly: false,
    instruction: 'fields 需要 teacherName、studentNames 数组、subject、classDate、startTime、endTime。重复周数用 repeatWeeks，包含第一周且最多 20。',
    clarification: '请补充排课缺少的教师、学生、科目、日期或起止时间。' },
  schedule_update: { name: '编辑课程', roles: managers, readOnly: false,
    instruction: 'filters 定位原课程，fields 只写要修改的课程字段；不要用修改课程替代调整完课状态。',
    clarification: '请说明要编辑哪节课，以及要改成什么。' },
  schedule_delete: { name: '删除单条课程', roles: managers, readOnly: false,
    instruction: 'filters 定位待删除课程；只能单条删除，不生成多个删除 action。目标由真实 API 查询并在页面确认。',
    clarification: '请补充待删除课程的日期、时间、教师或学生姓名。' },
  schedule_completion: { name: '调整完课状态', roles: ['ADMIN', 'TEACHER'], readOnly: false,
    instruction: 'filters 只需用户已给的姓名、日期、时段等线索即可查询真实课程，不要索要课程全部字段。姓名身份不明用 participantName 同时匹配教师和学生；相对日期换算成明确日期，上午/下午/晚上写 period。completed 是布尔值，设为已完课为 true，撤销完课为 false。唯一目标也要预览确认，多个目标交页面选择；教师只能操作本人课程，原 API 限定可操作日期。',
    clarification: '请说明要标记为已完课还是撤销完课，以及是哪天哪节课。' },
  user_search: { name: '查询用户', roles: managers, readOnly: true,
    instruction: 'filters 可用 username、role、status；不要把用户查询和课程查询混淆。',
    clarification: '请补充要查询的用户名或身份。' },
  user_create: { name: '新增用户', roles: managers, readOnly: false,
    instruction: 'fields 必须有 username 和 role；教师可有 subject，学生可有 school、grade。密码由页面表单输入，不能进入模型。',
    clarification: '请补充新用户姓名和身份（管理员、教师或学生）。' },
  user_update: { name: '编辑用户', roles: managers, readOnly: false,
    instruction: 'filters 定位用户，fields 可修改 username、subject、school、grade；原 API 不支持修改已有用户的 role。',
    clarification: '请说明要编辑哪位用户，以及要修改什么资料。' },
  user_status: { name: '启用或停用用户', roles: managers, readOnly: false,
    instruction: 'filters 定位用户，status 为 ACTIVE 或 DISABLED；停用需逐条二次确认。',
    clarification: '请提供要启用或停用的用户姓名。' },
  user_delete: { name: '删除单个用户', roles: managers, readOnly: false,
    instruction: 'filters 定位用户；只能单个删除，不能生成多个删除 action；原 API 保护最后一位启用管理员。',
    clarification: '请提供要删除的用户姓名。' },
  hours_balance: { name: '查询剩余课时', roles: ['ADMIN', 'STUDENT'], readOnly: true,
    instruction: '使用 filters；学生只能查自己的余额，查本人时 filters 为空；管理员可按 username 查学生。',
    clarification: '请说明要查询哪位学生的剩余课时。' },
  hours_adjust: { name: '调整学生课时余额', roles: managers, readOnly: false,
    instruction: 'filters 定位学生，amountHundredths 为百分之一课时整数，note 为调整原因；必须逐条二次确认。',
    clarification: '请补充学生姓名、调整数量和原因。' },
  adjustments_search: { name: '查询课时调整记录', roles: managers, readOnly: true,
    instruction: 'filters 定位单个学生；原 API 只提供按学生查询调整记录。',
    clarification: '请提供要查询调整记录的学生姓名。' },
};

export function assertSkillRole(kind: Kind, role: Role): void {
  if (!skills[kind].roles.includes(role)) throw new ApiFailure(403, 'FORBIDDEN', `当前${role === 'TEACHER' ? '教师' : role === 'STUDENT' ? '学生' : '管理员'}账号没有${skills[kind].name}的权限`);
}
export function isReadOnly(kind: Kind): boolean { return skills[kind].readOnly; }
function requiredKeys(kind: Kind): string {
  if (kind === 'schedule_create' || kind === 'user_create') return 'fields';
  if (kind === 'schedule_update' || kind === 'user_update') return 'filters、fields';
  if (kind === 'schedule_completion') return 'filters、completed(布尔值)';
  if (kind === 'user_status') return 'filters、status(ACTIVE/DISABLED)';
  if (kind === 'hours_adjust') return 'filters、amountHundredths(整数)、note';
  return 'filters';
}
export function skillPrompt(kind?: Kind): string {
  const selected = kind ? [[kind, skills[kind]] as const] : Object.entries(skills) as [Kind, Skill][];
  const catalog = selected.map(([id, skill]) => `${id}（${skill.name}，操作必需键：${requiredKeys(id)}）：${skill.instruction}`).join('\n');
  return `每个 action 都必须有 kind 和所列必需键。${catalog}\n课程 filters 可用 id、teacherName、studentName、participantName、dateFrom、dateTo、period(morning/afternoon/evening)、startTime、endTime、subject、classroom、completed("true"/"false")。指定某一天须同时设置 dateFrom 和 dateTo；人名角色不明用 participantName。课程 fields 可用 teacherName、studentNames、subject、classDate、startTime、endTime、classroom。用户 filters 可用 id、username、role、status；用户 fields 可用 username、role、subject、school、grade。日期 YYYY-MM-DD，时间 HH:mm。不要猜 ID。单次最多 20 项。`;
}

const intentSignals: Partial<Record<Kind, RegExp>> = {
  schedule_completion: /(?:点完课|标记.{0,5}完课|设(?:置)?.{0,5}完课|改(?:为|成).{0,3}完课|取消完课|撤销完课|完课状态)/,
  schedule_delete: /(?:删(?:掉|除)?.{0,8}(?:课程|这节课|的课)|删课)/,
  schedule_create: /(?:排课|安排.{0,8}(?:上课|课程|一节课)|新增课程)/,
  schedule_update: /(?:编辑课程|修改.{0,8}(?:课程|上课时间|教室|科目)|改.{0,8}(?:上课时间|教室|科目))的?/,
  schedule_export: /(?:导出|下载).{0,12}(?:课程|课表)/,
  schedule_search: /(?:查找|查询|看看|搜索).{0,12}(?:课程|课表|的课)/,
  user_create: /(?:新增|添加|创建).{0,10}(?:用户|账号|教师账号|学生账号)/,
  user_delete: /(?:删除|删掉).{0,10}(?:用户|账号)/,
  user_status: /(?:停用|启用|禁用|恢复).{0,10}(?:用户|账号|老师|学生)/,
  user_update: /(?:编辑|修改).{0,10}(?:用户|账号|教师资料|学生资料)/,
  user_search: /(?:查询|查找|搜索).{0,10}(?:用户|账号)/,
  hours_adjust: /(?:调整|增加|减少|充值|扣除).{0,10}(?:课时|余额)/,
  hours_balance: /(?:剩余课时|课时余额|还有多少课时)/,
  adjustments_search: /(?:课时调整记录|余额调整记录|调整记录)/,
};

export function detectIntent(input: string, pending: Action[] = [], activeKind?: Kind): { kind?: Kind; certain: boolean } {
  if (/^(?:算了|不用了|取消这个|停止|换个话题)/.test(input.trim())) return { certain: false };
  if (/(?:怎么|如何|为什么|解释|介绍|什么是|有什么规则|会.{0,15}吗)/.test(input.trim())) return { kind: activeKind, certain: false };
  if (/[，,；;]|然后|同时|顺便|再(?:帮|查|给|删|导|改|设|调)/.test(input)) return { kind: activeKind, certain: false };
  const matched = (Object.entries(intentSignals) as [Kind, RegExp][]).filter(([, pattern]) => pattern.test(input)).map(([kind]) => kind);
  if (matched.length === 1) return { kind: matched[0], certain: true };
  if (matched.length > 1) return { certain: false };
  const pendingKinds = [...new Set(pending.map((action) => action.kind))];
  return pendingKinds.length === 1 ? { kind: pendingKinds[0], certain: false }
    : activeKind ? { kind: activeKind, certain: false } : { certain: false };
}
