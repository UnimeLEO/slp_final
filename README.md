# SLP Experimental Interaction Platform

用于 Second Language Pragmatics 期末实证研究的轻量级文字互动平台。

## 1.1.1a — 正式实验版本

本版用于正式运行真人与 AI 两种互动条件：参与者在自己的电脑操作；Human 条件由研究者扮演 Jimmy 回复，AI 条件通过服务端调用 OpenAI Responses API。一个 Cloudflare Worker 同时提供参与者与管理员 API；管理操作均需服务端验证研究者口令。

已经实现：

- 参与者编号与随机访问码验证，刷新后可重新验证并恢复当前会话。
- 每人两个任务与四种交叉平衡顺序，固定使用情境 A“旅行与补考”和情境 B“搬家与兼职”，创建时保存角色材料快照。
- 统一的文字消息接口、轮询收取消息、发送重试去重。
- 参与者主动结束与研究者手动终止，服务器阻止结束后的新消息。
- 管理端查看双方已发送消息，按参与者导出 JSON / CSV / TXT。
- AI 模型、输出预算、可选 reasoning effort 与延迟参数可在后台配置；正式角色 Prompt 由服务器固定提供。
- 生成结果先存 D1，再按目标时间发布到与 Human 相同的消息表和界面。
- AI 任务开始时冻结配置；连续未处理消息合并，同一任务同一时刻仅有一个生成任务。
- 身份信息仅在管理端返回，参与者接口不返回 Human / AI 条件及 interlocutor 角色说明。
- 登录后分两步显示 PLS 和电子 Consent Form：先确认已阅读 PLS，再阅读 consent bullet points 并勾选 Final confirmation；两个确认动作写入独立 D1 表后才能查看和开始任务。
- 两个任务结束且最后一批输入记录完成同步后，自动转到 Qualtrics，并通过 `Participant Code` 嵌入字段传递参与者编号。

知情同意、背景问卷与任务后的身份判断在平台外单独实施。参与者入口明确提示会记录删除和未发送的文字。

原定规模：4 名参与者 × 2 次互动 = 8 次。编号可直接填写 `01`、`02` 等，前导零按文本保留；兼容旧 `TEST01` 等字母编号。

### 本版记录功能

- 仅记录 Participant 聊天输入框，保存草稿、修改前后文本、选区、输入法与焦点事件。
- IndexedDB 原子保存，分批上传、重试去重、刷新恢复及未发送草稿保留。
- 草稿与正式消息关联，记录消息在 DOM/可见区域中的呈现观察。
- 完整 JSON、事件 CSV、草稿时间线和完整性检查；详见 [记录说明](RECORDING.md)。
- 从 1.0.x 升级：先部署新版 Worker，再执行 `worker/migrations/004-consent.sql`，保留现有记录及密钥。

### 界面

- 灰白配色、普通字体与细边框；参与者入口只保留标题、编号、访问码和 Continue，不显示研究简介或技术条件。
- 任务页采用左侧固定情境、右侧聊天；聊天记录独立滚动，输入框保持在下方。
- 对方名称默认 Jimmy，两种条件共用 `assets/config.js` 中的 `INTERLOCUTOR_NAME`。显示名不改变模型角色指令。
- Access code 保留现有 12 字符、三组格式；支持整串粘贴、自动分组与输入后跳到下一组。
- 工作台分别显示编号与访问码，提供“复制访问码”，不再强制整块选中。
- GitHub Pages 自动更新前端；首次启用记录需要新版 Worker 和 003 数据库迁移。

## 文件

| 文件 | 用途 |
| --- | --- |
| `index.html` | 英文参与者入口与文字会话 |
| `researcher.html` | 中文研究者工作台，含 Human 回复 |
| `assets/config.js` | 公共 API 地址配置，不存密钥 |
| `assets/common.js` | 通用请求、消息显示与下载 |
| `assets/participant.js` | 参与者流程 |
| `assets/researcher.js` | 研究者管理与回复 |
| `assets/logging.js` | Participant 记录、IndexedDB 恢复与分批同步 |
| `assets/exports.js` | 事件 CSV、时间线及数据完整性检查 |
| `worker/worker.mjs` | 完整 Cloudflare Worker 模块，无外部依赖 |
| `worker/schema.sql` | 独立 SLP D1 数据库表结构 |
| `worker/DEPLOY.md` | Cloudflare 控制台部署步骤 |
| `tests/worker.test.mjs` | Worker 与真实 SQLite 查询的本地集成检查 |

## 部署

前端使用 GitHub Pages：`main` 分支，`/(root)`。

- 参与者：<https://unimeleo.github.io/slp_final/>
- 研究者：<https://unimeleo.github.io/slp_final/researcher.html>

后端部署至已有的 `slp-final-admin` Worker，详见 [部署说明](worker/DEPLOY.md)。

公共配置已填入用户确认的 `https://slp-final-admin.njsukleo.workers.dev`。工作台也会生成含 Worker 地址的参与者链接。访问码、研究者口令与 API 密钥均不放入链接。

## AI 调度与延迟

AI 首先等待参与者消息，不自动开场。后续参与者轮询会处理待生成回复。生成请求被服务端 `await`，不依赖 `waitUntil` 的后台执行时间。目标等待存于 D1，不通过长时间 sleep 实现。模型请求超时为 25 秒，超时或不完整输出不作为正常消息发送。

`L` 定义为生成回复的 Unicode 字符数，`k` 单位为毫秒 / 字符。目标延迟 `k × L + U(a,b)` 从触发消息的服务器接收时间算起，最早发布时刻取目标到期时刻与生成完成时刻的较晚者。实际浏览器收到时间还包含轮询和网络耗时，**不能把最早发布时刻等同于实际显示时间**。

AI 配置与情境角色在任务开始时保存快照，后续全局改动只影响未开始的任务。密钥不在快照内。AI只接收 Jimmy 的正式角色说明与已发送的聊天记录，不接收 Participant 的私有任务卡。

网络重试不会重复入队；已排队的连续消息在生成前合并。生成期间新消息继续排队，待当前回复发布后再处理。D1 锁租期为 60 秒，可在执行中断后恢复；这不是账单级 exactly-once 保证：极端中断可能发生已调用 API 但尚未保存结果。失败不会自动无限重试，研究者可显式重试。

## 数据与时间

本版双方**已发送消息**、材料快照和任务状态保存在专用 SLP D1 数据库，便于两台电脑共享及恢复。`server_received_ms` 为服务器处理并接收消息时的 Unix 毫秒时间，不能直接用作参与者实际看到消息的时间。客户端另记 page_id 和页内时间；消息 DOM/可见区域观察与草稿记录详见 RECORDING.md。跨端时钟不作精确等同。

JSON 导出增加 `ai_jobs` 与 `ai_configs`，包含生成起止、目标延迟、最早发布时间、实际入消息表时间、返回模型名、usage、响应 ID、失败状态及配置快照。原聊天 CSV / TXT 仍为实际已发布聊天记录；完整 JSON 还含 recording，事件 CSV 与草稿时间线独立导出。

只记录 Participant 草稿；Human 输入框没有击键或草稿监听。草稿不会发给 AI。

研究者口令仅在当前页面内存中使用；刷新或锁定后重输。研究者工作台仅保存 Worker URL；Participant 本机另有 IndexedDB 草稿与待同步记录，详见 RECORDING.md。D1 仅保存参与者访问码的哈希。新访问码仅在创建响应中提供，请当时保存。

退出工作台会清除当前页的显示内容和未发送草稿；D1 中已发送的数据不会因此删除。

发送失败时保留原消息与客户端消息编号，使用“重试发送”可避免网络重试产生重复记录。服务器使用原子 SQL 状态检查，防止会话结束与消息写入之间的竞争。

## 测试

Node.js 24 环境：

```sh
node --test tests/*.test.mjs
```

检查使用内存 SQLite 适配 D1 调用形状，执行真实 Worker 请求处理程序和 SQL。覆盖数字编号的完整流程与前导零保留、研究者认证、参与者隔离、条件隐藏、四种顺序、双向消息、发送与结束幂等、导出、AI 配置快照、合并排队、并发锁、延迟截止时间、结束时取消与人工重试。AI 测试使用模拟的 Responses API，不消耗真实 API 费用；需部署后验证所选模型与账户可用性。

记录器测试包含原始事件、组合输入、断网、刷新、发送确认丢失、长文本、IndexedDB 故障及实际 Worker/SQLite 的联通。模拟事件不能替代操作系统输入法测试；部署后还需两台电脑验证，步骤见 RECORDING.md。

## 版本

- **0.0.1**：首个前端框架与页面发布检查。
- **0.1.0**：D1 会话、认证、Human 聊天与聊天记录导出。

- **0.2.0**：Responses API、持久化 AI 任务、延迟控制、参数快照和 AI 调度元数据导出。
- **0.2.1**：简约灰白界面、手绘布局、数字编号、分段访问码输入及单独复制。

- **0.3.0**：Participant 草稿与事件记录、IndexedDB 暂存、重试恢复、消息呈现观察、完整性检查及事件导出。

- **0.3.3**：活动任务的按键事件改为本地暂存，任务结束时批量上传。
- **1.0.0**：注入两套正式情境，锁定服务器端材料，移除测试界面标记，并隔离 Participant 与 Jimmy 的私有角色信息。
- **1.0.1**：两套 Jimmy Prompt 增加请求序列约束：先等待明确请求，再陈述既有顾虑并协商折中方案。
- **1.0.2**：两套 Jimmy Prompt 改为由 Robin 主动提出解决方案；Jimmy 负责表达顾虑、说明限制并回应提议。
- **1.1.0**：增加服务器端同意门控、PLS/Consent 页面，以及带参与者编号的 Qualtrics 完成跳转。
- **1.1.1**：PLS 与 Consent 分页；PLS 增加阅读确认，Consent 说明改为 bullet points 并只保留 Final confirmation 复选框。
- **1.1.1a**：Prompt 修订 a；要求 Jimmy 使用自己的非正式措辞，避免复述角色说明中的表达。后续仅修改 Prompt 时按 `b`、`c`、`d` 依次顺延。

### Frontend update 0.3.1

Participant sends now display the server-confirmed message immediately, without waiting for the next AI-processing poll. Confirmed sends do not advance the polling cursor, so an earlier unseen reply cannot be skipped. Both conditions share this display path.

Open a task in the researcher console and click **下载当前任务 ZIP**. Each archive contains only that task: `data.json`, `chat.csv`, `chat.txt`, `events.csv`, and `timeline.txt`. All files use the same fetched export snapshot; integrity warnings are retained in JSON and the timeline. End the task and allow recording to sync before taking a final export. ZIP compression runs locally in the browser with no external library or upload.

This release changes frontend files only. Refresh GitHub Pages after deployment; no Worker deployment or D1 migration is needed. The Worker health version remains 0.3.0.

### Read-efficiency fix 0.3.2

Deploy `worker/worker.mjs` to the existing Worker, then hard-refresh both Pages interfaces. No D1 migration is required. Worker health reports 0.3.2. Deployment does not reset an exhausted Cloudflare account quota.

Both upload conflict checks now iterate the incoming JSON batch first and perform exact `(session_id,page_id,seq)` indexed lookups, avoiding history-by-batch scans. Fully linked sent drafts are no longer updated on every event upload. Ordinary `admin_session` calls omit recording aggregates by default; send `include_recording:true` for a full summary. The researcher UI requests that summary when opening a task or clicking **刷新记录统计**, rather than on every chat poll. The session list refreshes every 15 seconds. Chat polling and automatic recording uploads use capped exponential backoff after errors; durable local events are retained.

Validated by 42 automated tests, including query-plan checks for both indexed conflict lookups, an assertion that normal monitoring never queries the event table, and automatic upload retry backoff. Query-plan/VM measurements are local SQLite evidence, not measured Cloudflare billable rows.

### Local-first recording 0.3.3

Participant keystroke events remain durably stored in browser IndexedDB while a task is active. They are uploaded only when the task ends or when a later login recovers an unfinished local outbox. Uploads contain up to 500 events while remaining below the 250000-byte client limit. Ordinary chat messages still reach D1 immediately so Human and AI conversations continue normally.

Deploy the current `worker/worker.mjs`, then hard-refresh the participant and researcher pages. No D1 migration or secret change is required. `/health` should report version `0.3.3`.
