# Cloudflare 控制台部署：slp-final-admin（0.2.1）

## 已部署 0.2.0：升级到 0.2.1

1. 用仓库 `worker/worker.mjs` 的完整内容替换现有 Worker 入口代码，然后点击 Deploy。
2. 不执行 SQL，不重设 `DB`、`ADMIN_SECRET`、`OPENAI_API_KEY` 或模型配置。现有数据与配置保留。
3. 打开 `/health`，确认 `version` 为 `0.2.1`。
4. GitHub Pages 更新后强制刷新工作台，即可创建 `01` 等数字编号；旧编号仍可登录。
5. 从创建结果中点击“复制访问码”，参与者可以将整串粘贴到任一 Access code 分段框中。

纯数字编号需要新版 Worker 的校验支持，仅刷新前端不足以启用。

## 已部署 0.1.0：增量升级

1. 在现有 **SLP 专用数据库** Console 执行 `migrations/002-ai.sql`。该脚本只增加表与索引、更新版本标记，不删除 TEST01 或现有聊天。
2. 给现有 Worker 增加 Secret `OPENAI_API_KEY`，值为你的 OpenAI API 密钥。原有 `ADMIN_SECRET` 与 `DB` 绑定保留。
3. 模型名称可在新版工作台“AI 配置”填写；也可以先增加 Text 变量 `OPENAI_MODEL` 作为默认值。
4. 将新版 `worker.mjs` 全部粘贴到现有 Worker，点击 Deploy。迁移后尽快部署新代码，因为旧版只识别 schema version 1。
5. 刷新研究者工作台至 **0.2.1**，重新登录并配置模型。reasoning effort 默认不指定；如填写，必须为该模型支持的值。
6. 新建 `TEST02`，选顺序 2（AI A → Human B），用参与者页面验证 AI。也可以继续尚未结束的 TEST01-T2。

`ai_enabled` 只表示密钥和模型名称已配置，不代表已通过账户权限、配额和模型调用测试。

## 1. 新安装：创建独立 D1 数据库

Cloudflare → Storage & databases → D1 SQL database → Create database。

建议命名：`slp-final`。请创建独立数据库，不使用 Minor Thesis 的数据库。

打开数据库的 Console，将同目录 `schema.sql` 的全部内容粘贴执行。脚本创建 `schema_meta`、`participants`、`sessions`、`messages` 四个表与索引，不删除现有记录。

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
{"ok":true,"service":"slp-final","version":"0.2.1","database":"ready","ai_enabled":true}
```

| 返回结果 | 检查 |
| --- | --- |
| D1 binding DB is missing | 大写绑定名是否为 `DB`，是否已部署 |
| D1 schema is not ready | 新装执行 `schema.sql`；从 0.1.0 升级执行 `migrations/002-ai.sql` |
| Set ADMIN_SECRET… | Secret 是否叫 `ADMIN_SECRET` 且至少 20 字符 |
| Researcher authentication failed | 登录口令是否与 Secret 完全相同 |
| 浏览器无法连接 | Worker 地址是否正确；是否已部署；ALLOWED_ORIGIN 是否误填路径 |

健康检查不验证研究者口令；管理端解锁时会验证。

## 6. 两端聊天测试

1. 等待 GitHub Pages 更新至 0.2.1。刷新工作台，页头应显示“开发版 0.2.1”。
2. 输入实际 Worker 地址、研究者口令，点击“连接并解锁”。
3. 创建 `TEST01`，保持顺序 1：Human A → AI B。先保存新访问码。
4. 复制工作台中的“参与者链接”，在另一台电脑或另一浏览器打开。链接包含非敏感服务器地址，不含口令或访问码。
5. 输入 TEST01 及访问码，点击 Continue，再点击 Start conversation。
6. 工作台打开 `TEST01-T1`，双方互发消息。
7. 参与者结束后，工作台应显示已结束；也可以用新的测试编号测试研究者终止。
8. 导出 JSON / CSV / TXT，核对消息与结束原因。
9. 在模型和密钥配置完成后，继续 Task 2 验证 AI，或创建 TEST02 并使用 AI 优先的顺序 2。
10. 在工作台打开 AI 任务，查看“AI 回复状态”。错误只在管理端显示技术原因；可显式重试失败的回复。导出 JSON 检查生成耗时和延迟记录。

测试创建更多记录时用 TEST02、TEST03 等编号。重复编号不会覆盖原记录。

编号可用 `01`、`02` 等，无需前缀，前导零保留。以上 TEST 编号为兼容旧流程的示例；测试记录可用尚未使用的编号，重复编号不会覆盖记录。

## 已知边界

- 0.2.0 包括 AI，尚无草稿记录与正式问卷。
- 消息通过轮询传递，前台约 1.5 秒一次，隐藏页约 5 秒一次；两种角色使用同一个服务。
- 每次读取最多 500 条新消息，后续轮询继续读取，避免单次返回无限增长。
- 参与者刷新后需重新输入编号与访问码，服务端恢复当前任务和已发送消息；尚未发送的草稿不能恢复。
- 后续完整记录阶段会增加参与者实际显示时间、草稿与消息的关联和完整性检查。

## AI 连接错误

- `provider_http_401`：检查 Worker 的 `OPENAI_API_KEY`。
- `provider_http_403` / `provider_http_404`：检查账户模型访问权限与 API 模型名称。
- `provider_http_429`：检查 API 配额与限流。
- `provider_http_400`：检查所选模型对 reasoning effort 和输出预算参数的支持。
- `provider_response_incomplete`：未完整结束的响应不会作为正常回复发布；检查输出预算和 reasoning 设置。
- `provider_timeout`：模型请求超过 25 秒；该任务不会自行无限重复调用。

更正 Cloudflare 密钥后，可以在管理端点击重试。模型与参数已冻结到开始时的任务快照；更改模型参数需创建新的测试任务。

现有 SLP Worker 同时服务两端。如为整个 Worker 启用 Cloudflare Access 登录保护，会影响 GitHub Pages 的跨域 API 请求；研究者操作由 `ADMIN_SECRET` 验证。
