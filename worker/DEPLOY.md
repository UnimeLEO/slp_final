# Cloudflare 控制台部署：slp-final-admin

## 1. 创建独立 D1 数据库

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

准备就绪时返回：

```json
{"ok":true,"service":"slp-final","version":"0.1.0","database":"ready","ai_enabled":false}
```

| 返回结果 | 检查 |
| --- | --- |
| D1 binding DB is missing | 大写绑定名是否为 `DB`，是否已部署 |
| D1 schema is not ready | 是否在绑定的那个数据库执行了 `schema.sql` |
| Set ADMIN_SECRET… | Secret 是否叫 `ADMIN_SECRET` 且至少 20 字符 |
| Researcher authentication failed | 登录口令是否与 Secret 完全相同 |
| 浏览器无法连接 | Worker 地址是否正确；是否已部署；ALLOWED_ORIGIN 是否误填路径 |

健康检查不验证研究者口令；管理端解锁时会验证。

## 6. 两端聊天测试

1. 等待 GitHub Pages 更新至 0.1.0。刷新工作台，页头应显示“开发版 0.1.0”。
2. 输入实际 Worker 地址、研究者口令，点击“连接并解锁”。
3. 创建 `TEST01`，保持顺序 1：Human A → AI B。先保存新访问码。
4. 复制工作台中的“参与者链接”，在另一台电脑或另一浏览器打开。链接包含非敏感服务器地址，不含口令或访问码。
5. 输入 TEST01 及访问码，点击 Continue，再点击 Start conversation。
6. 工作台打开 `TEST01-T1`，双方互发消息。
7. 参与者结束后，工作台应显示已结束；也可以用新的测试编号测试研究者终止。
8. 导出 JSON / CSV / TXT，核对消息与结束原因。
9. Task 2 的 AI 通道尚待下一步接入，暂时不能启动。不要将此状态当作正式研究完成。

测试创建更多记录时用 TEST02、TEST03 等编号。重复编号不会覆盖原记录。

## 已知边界

- 0.1.0 是真人聊天检查点，尚无 AI、草稿记录、正式问卷。
- 消息通过轮询传递，前台约 1.5 秒一次，隐藏页约 5 秒一次；两种角色使用同一个服务。
- 每次读取最多 500 条新消息，后续轮询继续读取，避免单次返回无限增长。
- 参与者刷新后需重新输入编号与访问码，服务端恢复当前任务和已发送消息；尚未发送的草稿不能恢复。
- 后续完整记录阶段会增加参与者实际显示时间、草稿与消息的关联和完整性检查。
