# Cloudflare 控制台部署：slp-final-admin（1.0.2）

## 当前升级：1.0.1 → 1.0.2

1. 用仓库 `worker/worker.mjs` 全文替换现有 Worker 入口并 Deploy。
2. 不执行 SQL，不更改 `DB`、`ADMIN_SECRET`、`OPENAI_API_KEY` 或模型参数。
3. `/health` 应返回 `version: "1.0.2"`、`recording_enabled: true`、`database: "ready"`。
4. GitHub Pages 更新后强制刷新两端；工作台页头应显示“正式版 1.0.2”。
5. 用一个新编号完成冒烟测试，确认消息、任务结束和ZIP下载正常。
6. 正式账号必须在升级后创建；旧会话会保留创建时的旧材料快照。

## 已部署 0.1.0：增量升级

1. 在现有 **SLP 专用数据库** Console 执行 `migrations/002-ai.sql`。该脚本只增加表与索引、更新版本标记，不删除 TEST01 或现有聊天。随后再执行 `migrations/003-recording.sql`。
2. 给现有 Worker 增加 Secret `OPENAI_API_KEY`，值为你的 OpenAI API 密钥。原有 `ADMIN_SECRET` 与 `DB` 绑定保留。
3. 模型名称可在新版工作台“AI 配置”填写；也可以先增加 Text 变量 `OPENAI_MODEL` 作为默认值。
4. 将新版 `worker.mjs` 全部粘贴到现有 Worker，点击 Deploy。迁移后尽快部署新代码，因为旧版只识别 schema version 1。
5. 刷新研究者工作台至 **0.3.0**，重新登录并配置模型。reasoning effort 默认不指定；如填写，必须为该模型支持的值。
6. 新建 `TEST02`，选顺序 2（AI A → Human B），用参与者页面验证 AI。也可以继续尚未结束的 TEST01-T2。

`ai_enabled` 只表示密钥和模型名称已配置，不代表已通过账户权限、配额和模型调用测试。

## 1. 新安装：创建独立 D1 数据库

Cloudflare → Storage & databases → D1 SQL database → Create database。

建议命名：`slp-final`。请创建独立数据库，不使用 Minor Thesis 的数据库。

打开数据库的 Console，将同目录 `schema.sql` 的全部内容粘贴执行。脚本创建聊天、AI 和草稿记录所需表与索引，不删除现有记录。

## 2. 绑定已有 Worker

Workers & Pages → `slp-final-admin` → Bindings → Add binding → D1 database。

| 设置 | 值 |
| --- | --- |
| Variable name / Binding name | `DB`（大写） |
| Database | 第一步创建的 `slp-final` |

保存绑定；若界面要求部署，执行部署。

## 3. 设置研究者口令

Worker → Settings → Variables and Secrets → Add。

| 设置 | 值 |
| --- | --- |
| Type | Secret |
| Variable name | `ADMIN_SECRET` |
| Value | 自己设置至少 20 个字符的随机口令 |

只在 Cloudflare 与研究者登录框填写，不发到聊天里，不提交到 GitHub。

可选变量 `ALLOWED_ORIGIN` 默认是 `https://unimeleo.github.io`。当前不必添加。若配置，填域名来源，不能带 `/slp_final/` 路径或末尾斜杠。

## 4. 粘贴 Worker 代码

Worker → Edit code。

用 `worker.mjs` 的全部内容替换默认代码，然后 Deploy。这个模块无依赖、无 import，不需要构建。

`worker.mjs` 是仓库中的源文件名；Cloudflare 编辑器若使用 `worker.js` 作为入口，可以直接替换其中内容。

## 5. 检查健康接口

从 Worker 的 Domains & Routes / 部署结果中复制实际 `workers.dev` 地址。在浏览器访问：

```text
https://你的实际Worker域名/health
```

数据库、密钥与模型名称均已配置时返回：

```json
{"ok":true,"service":"slp-final","version":"1.0.2","recording_enabled":true,"database":"ready","ai_enabled":true}
```

| 返回结果 | 检查 |
| --- | --- |
| D1 binding DB is missing | 大写绑定名是否为 `DB`，是否已部署 |
| D1 schema is not ready | 新装执行 `schema.sql`；从 0.1.0 升级执行 `migrations/002-ai.sql` |
| Set ADMIN_SECRET… | Secret 是否叫 `ADMIN_SECRET` 且至少 20 字符 |
| Researcher authentication failed | 登录口令是否与 Secret 完全相同 |
| 浏览器无法连接 | Worker 地址是否正确；是否已部署；ALLOWED_ORIGIN 是否误填路径 |

健康检查不验证研究者口令；管理端解锁时会验证。

## 6. 正式版冒烟测试

1. 等待 GitHub Pages 更新至 1.0.2。刷新工作台，页头应显示“正式版 1.0.2”。
2. 输入实际 Worker 地址、研究者口令，点击“连接并解锁”。
3. 创建一个未使用的测试编号，保持顺序 1：Human A → AI B。先保存新访问码。
4. 复制工作台中的“参与者链接”，在另一台电脑或另一浏览器打开。链接包含非敏感服务器地址，不含口令或访问码。
5. 输入编号及访问码，点击 Continue，再点击 Start conversation。
6. 工作台打开对应的 T1 会话，双方互发消息。
7. 参与者结束后，工作台应显示已结束；也可以用新的测试编号测试研究者终止。
8. 导出 JSON / CSV / TXT，核对消息与结束原因。
9. 在模型和密钥配置完成后，继续 Task 2 验证 AI，或另建编号并使用 AI 优先的顺序 2。
10. 在工作台打开 AI 任务，查看“AI 回复状态”。错误只在管理端显示技术原因；可显式重试失败的回复。导出 JSON 检查生成耗时和延迟记录。

编号可用 `01`、`02` 等，无需前缀，前导零保留；重复编号不会覆盖原记录。

## 已知边界

- 知情同意、背景问卷与任务后身份判断在平台外单独实施。
- 消息通过轮询传递，前台约 1.5 秒一次，隐藏页约 5 秒一次；两种角色使用同一个服务。
- 每次读取最多 500 条新消息，后续轮询继续读取，避免单次返回无限增长。
- 参与者刷新后需重新输入编号与访问码，服务端恢复当前任务和已发送消息；草稿与待确认发送可通过 IndexedDB 恢复；本机站点数据被清除或未提交时不保证恢复。
- 客户端记录 DOM/可见区域观察、草稿与消息关联；这些时间不是已阅读的证明，完整性结果也不能保证崩溃前没有丢失尾部。

## AI 连接错误

- `provider_http_401`：检查 Worker 的 `OPENAI_API_KEY`。
- `provider_http_403` / `provider_http_404`：检查账户模型访问权限与 API 模型名称。
- `provider_http_429`：检查 API 配额与限流。
- `provider_http_400`：检查所选模型对 reasoning effort 和输出预算参数的支持。
- `provider_response_incomplete`：未完整结束的响应不会作为正常回复发布；检查输出预算和 reasoning 设置。
- `provider_timeout`：模型请求超过 25 秒；该任务不会自行无限重复调用。

更正 Cloudflare 密钥后，可以在管理端点击重试。模型与参数已冻结到开始时的任务快照；更改模型参数只会影响尚未开始的 AI 任务。

现有 SLP Worker 同时服务两端。如为整个 Worker 启用 Cloudflare Access 登录保护，会影响 GitHub Pages 的跨域 API 请求；研究者操作由 `ADMIN_SECRET` 验证。

## 0.3.2: prevent excessive D1 reads

Replace the deployed Worker with the current `worker/worker.mjs` and deploy. No SQL migration or secret changes are needed. Hard-refresh the participant and researcher pages to load assets tagged `v=032`. Check `/health` for version `0.3.2` once D1 is available again. An exhausted daily account quota remains blocked until its reset or a plan change; deploying this fix does not restore the consumed quota.

## 0.3.3: local-first recording

Replace the deployed Worker with the current `worker/worker.mjs` and deploy, then hard-refresh both GitHub Pages interfaces to load assets tagged `v=033`. No SQL migration or secret changes are required. Check `/health` for version `0.3.3`.

During an active task, participant keystroke events stay in browser IndexedDB. The client uploads them in byte-bounded batches of up to 500 only when the task ends or when it recovers an older unfinished outbox. Chat messages continue to be written immediately.

## 1.0.0: formal experiment release

Deploy the current `worker/worker.mjs`, then hard-refresh both GitHub Pages interfaces to load assets tagged `v=100`. No SQL migration or secret changes are required. `/health` must report version `1.0.0` before formal participant accounts are created.

Scenario A is the Sydney trip and make-up examination task. Scenario B is the furniture shopping and part-time shift task. Both sets of Participant and Jimmy instructions are fixed server-side. The AI receives only Jimmy's role instructions and the sent chat transcript; the Participant's private task card is excluded. Existing sessions retain their earlier material snapshots, so formal participant accounts must be created after deploying 1.0.0.

## 1.0.1: request-sequence constraint

Both Jimmy prompts now require the interlocutor to wait for Robin to make a specific request, avoid proposing solutions on Robin's behalf beforehand, and state existing concerns before exploring compromises. Deploy the Worker and hard-refresh both interfaces; no SQL migration is required.

## 1.0.2: participant-led solutions

Both Jimmy prompts now prohibit proactive solutions, compromises, and alternatives. Jimmy states concerns and relevant constraints, responds to Robin's proposals, and may accept a reasonable proposal. Deploy the Worker and hard-refresh both interfaces; no SQL migration is required.
