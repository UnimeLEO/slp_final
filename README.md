# SLP Experimental Interaction Platform

用于 Second Language Pragmatics 期末实证研究的轻量级文字互动平台。

## 0.1.0 — 真人双向聊天测试版

本版可运行真人聊天：参与者在自己的电脑操作，你在研究者工作台回复。一个 Cloudflare Worker 同时提供参与者与管理员 API；管理操作均需服务端验证研究者口令。

已经实现：

- 参与者编号与随机访问码验证，刷新后可重新验证并恢复当前会话。
- 每人两个任务与四种交叉平衡顺序，创建时保存角色材料快照。
- 统一的文字消息接口、轮询收取消息、发送重试去重。
- 参与者主动结束与研究者手动终止，服务器阻止结束后的新消息。
- 管理端查看双方已发送消息，按参与者导出 JSON / CSV / TXT。
- 身份信息仅在管理端返回，参与者接口不返回 Human / AI 条件及 interlocutor 角色说明。

**尚未实现：AI 回复、目标延迟、草稿击键记录、正式知情同意 / 背景问卷 / 身份判断。AI 任务目前不能启动，也不会伪装成已完成。请仅使用测试内容，尚不能作为正式采集版本。**

原定规模：4 名参与者 × 2 次互动 = 8 次。TEST01 等测试记录与正式编号区分。

## 文件

| 文件 | 用途 |
| --- | --- |
| `index.html` | 英文参与者入口与文字会话 |
| `researcher.html` | 中文研究者工作台，含 Human 回复 |
| `assets/config.js` | 公共 API 地址配置，不存密钥 |
| `assets/common.js` | 通用请求、消息显示与下载 |
| `assets/participant.js` | 参与者流程 |
| `assets/researcher.js` | 研究者管理与回复 |
| `worker/worker.mjs` | 完整 Cloudflare Worker 模块，无外部依赖 |
| `worker/schema.sql` | 独立 SLP D1 数据库表结构 |
| `worker/DEPLOY.md` | Cloudflare 控制台部署步骤 |
| `tests/worker.test.mjs` | Worker 与真实 SQLite 查询的本地集成检查 |

## 立即部署

前端使用 GitHub Pages：`main` 分支，`/(root)`。

- 参与者：<https://unimeleo.github.io/slp_final/>
- 研究者：<https://unimeleo.github.io/slp_final/researcher.html>

后端部署至已有的 `slp-final-admin` Worker，详见 [部署说明](worker/DEPLOY.md)。

后台连通后，工作台会生成含 Worker 地址的参与者链接。**先用工作台生成的链接测试**，不必立刻修改公共配置。访问码与口令均不放入链接。

## 数据与时间

本版双方**已发送消息**、材料快照和任务状态保存在专用 SLP D1 数据库，便于两台电脑共享及恢复。`server_received_ms` 为服务器处理并接收消息时的 Unix 毫秒时间，不能直接用作参与者实际看到消息的时间。浏览器显示时间、跨端时钟关联和草稿轨迹将在记录阶段加入。

只记录 Participant 草稿的要求保留，但本版尚未启用草稿记录。Human 输入框没有击键或草稿监听。

研究者口令仅在当前页面内存中使用；刷新或锁定后重输。浏览器只保存 Worker URL。D1 仅保存参与者访问码的哈希。新访问码仅在创建响应中提供，请当时保存。

退出工作台会清除当前页的显示内容和未发送草稿；D1 中已发送的数据不会因此删除。

发送失败时保留原消息与客户端消息编号，使用“重试发送”可避免网络重试产生重复记录。服务器使用原子 SQL 状态检查，防止会话结束与消息写入之间的竞争。

## 测试

Node.js 24 环境：

```sh
node --test tests/worker.test.mjs
```

检查使用内存 SQLite 适配 D1 调用形状，执行真实 Worker 请求处理程序和 SQL。覆盖研究者认证、参与者隔离、条件隐藏、四种顺序、双向消息、发送与结束幂等、导出和无效输入。

此检查不能代替实际 Cloudflare 部署与两台电脑的浏览器测试。

## 版本

- **0.0.1**：首个前端框架与页面发布检查。
- **0.1.0**：D1 会话、认证、Human 聊天与聊天记录导出。
