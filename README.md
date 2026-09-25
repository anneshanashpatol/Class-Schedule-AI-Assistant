# 前程π AI 助手（独立项目）

这是与原排课网站并列的独立项目。它只接管 `https://qcp.dpdns.org/assistant` 和其子路径；原网站的源码、部署配置和业务数据库结构均不需要修改。页面与 API 由新 Cloudflare Worker 提供，业务请求经 `MAIN_APP` Service Binding 调用原 Worker。用户沿用原站在 `qcp.dpdns.org` 的登录 Cookie，因此无需在助手里再次登录。

## 已实现的操作

- 课程查询、新增、编辑、单条删除、完课状态修改、筛选导出 Excel；最多展开 20 条按周重复排课。
- 管理员查询、新增、编辑、停用/启用、删除用户，查询学生剩余课时和调整记录、调整学生课时余额；学生可查询自己的剩余课时。
- 普通写操作整批预览确认；删除、停用、余额调整及检测到排课时间重叠时需要逐条勾选后确认。批次中途失败会停止并报告已成功、失败、未执行项。
- 模型配置仅管理员可见；支持标准 OpenAI 兼容 `chat/completions` 接口地址、模型、API Key，以及连接测试。
- 不设置每日模型调用量上限；为防连续误触或脚本刷请求，同一账号的解析请求间隔至少 3 秒，每次模型响应设有输出和字节限制。

Cloudflare 免费版下，新旧 Worker 共用账号级请求额度。普通对话解析只调用一次外部模型，格式修复最多再调用一次；等待模型响应不计入 Worker CPU 时间，但 JSON 校验、目标筛选和页面处理仍占 CPU。每次只取有限候选并限制单批 20 项；正式环境应关注请求量、CPU 和 D1 用量，以及模型服务商自己的限额。

当前不支持批量删除、密码修改或重置、修改本人资料、持久聊天历史。权限以原 API 当前实现为准；特别是教师无法通过助手删除课程。教师和学生只查询或导出本人可见课程；教师可调整本人课程的完课状态（遵循原 API 的日期限制），学生可查询本人余额。所有业务写入都交给原 API。没有配置应用内模型调用量上限，第三方模型费用由对应服务商决定。

助手的身份、对话原则和权限边界写在 `server/COURSE_ASSISTANT.md`，构建时生成供 Worker 使用的 TypeScript 常量。`server/skills.ts` 统一登记十四项能力及适用角色；模型可在完整能力清单里判断本轮目的并提出工具请求，Worker 验证权限后查询真实目标、筛选候选并展示预览。已有姓名、日期、时段等线索时先查真实课程，不要求用户提供全部课程字段。模型不直接写业务数据。页面在内存中保留上轮目标和最近对话，用户补充信息时继续该目标，刷新后清空；待确认操作仍可短期存在助手 D1 中以防重复执行。

目前工具请求使用 OpenAI 兼容接口中的结构化 JSON 输出，由 Worker 执行；没有启用服务商原生 `tools` 参数。后者需先确认当前所选模型确实支持 Function Calling。这样正常请求只需一次模型调用，避免给免费模型增加额外往返与超时风险。

## 本地检查

Node.js 22：

```powershell
npm clean-install
npm test
npm run build
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config wrangler.jsonc
```

`npm run dev` 可打开前端页面；完整登录和业务调用需要 Cloudflare 的原 Worker Service Binding 与助手 D1。测试使用模拟的原 API 响应，不会修改生产数据。

## Cloudflare 网页部署

以下步骤只操作**新项目**及新资源。原 Worker 的 Custom Domain `qcp.dpdns.org` 保持原样。

1. 用 GitHub Desktop 将本文件夹作为独立仓库发布到 GitHub。确认没有提交 `node_modules`、`dist`、`.wrangler`、`.env` 或 `wrangler.production.jsonc`。
2. 在同一 Cloudflare 账号创建新的 D1，建议名称 `course-scheduler-assistant-db`。不要绑定或迁移原站 D1。记录新 D1 的 Database ID。
3. 在原 Worker 的 **Settings → Domains & Routes** 确认 `qcp.dpdns.org` 位于 **Custom Domains**。记录原 Worker 名称（默认 `course-scheduler`）。在账号的域名概览页记录承载 `qcp.dpdns.org` 的 Zone ID。
4. 在 **Workers & Pages → Create application → Import a repository** 中选择助手仓库，创建新 Worker。项目名默认 `course-scheduler-assistant`，生产分支 `main`，根目录留空。Build command 填 `npm run build`；Deploy command 填 `npm run deploy`；建议关闭非生产分支自动部署，避免预览代码连接正式业务 Worker。
5. 在该新 Worker 的 **Settings → Builds → Variables and secrets** 填写以下构建变量：

   | 名称 | 值 |
   | --- | --- |
   | `NODE_VERSION` | `22` |
   | `BUILD_AI_D1_DATABASE_ID` | 第 2 步的新 D1 Database ID |
   | `BUILD_ZONE_ID` | 第 3 步的 Zone ID |
   | `BUILD_MAIN_WORKER_NAME` | 原 Worker 实际名称，默认 `course-scheduler` |
   | `BUILD_ASSISTANT_HOST` | `qcp.dpdns.org`，使用默认值可不填 |

   若修改新 Worker 或新 D1 名称，再分别填写 `BUILD_ASSISTANT_WORKER_NAME`、`BUILD_AI_D1_DATABASE_NAME`。新 Worker 的构建授权令牌需要 Worker 发布、Routes 修改及新 D1 编辑权限。部署脚本先应用**助手 D1**迁移，再发布新 Worker 并注册 `/assistant` 与 `/assistant/*` 两条精确 Route；不会运行原项目迁移。
6. 第一次部署完成后访问 `/assistant`，以原站管理员账号登录的浏览器应能直接进入。打开右上角“模型设置”，点击“生成加密密钥”；将显示的 Base64 值复制到**新 Worker** 的 **Settings → Variables and Secrets**，名称 `AI_CONFIG_KEY`、类型 `Secret`。保存后刷新助手页面，再填写模型接口、模型名、API Key 并测试连接。请安全备份此加密密钥；丢失后已保存的模型 API Key 无法解密，需重新配置。
7. 验收时先检查原站 `/calendar`、`/schedules`、`/api/health` 不受影响，再测试助手登录、查询、预览及可清理的测试排课。删除、停用和课时调整应逐条要求确认。上线前检查模型服务商的计费设置。

后续只更新助手仓库并由该项目的 Cloudflare Builds 自动发布；新 D1、Secret 和 Route 会继续使用同一资源。不要改动首次迁移文件；结构变更需新增迁移。代码回滚不会自动回滚数据库。

## 接口与安全边界

- `GET /assistant/api/me`：原站会话与当前角色。
- `GET/PUT/DELETE /assistant/api/settings`、`POST /assistant/api/settings/test`：管理员模型配置。
- `POST /assistant/api/interpret`：解析指令、查询候选、生成 15 分钟预览；只保存短期操作计划，不保存聊天全文。
- `POST /assistant/api/confirm`：提交选择、逐项高风险确认及新增用户的初始密码；仅服务端使用原 API 执行。重复提交返回已有状态，不自动重做写操作。
- `GET /assistant/api/export-data`：按当前账号可见范围导出数据。页面最多导出 10000 条，超出时提示缩小筛选条件。

外部模型只收到当前指令及最多八条简短上下文；不会收到新增用户表单中的密码、会话 Cookie、完整用户表或课程数据库。模型可能返回错误或遗漏，页面预览和原 API 校验是必要的执行关口。单轮正常解析调用一次模型；模型格式错误时最多追加一次修复调用；执行失败时才尝试一次短说明调用。
