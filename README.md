# SLP Experimental Interaction Platform

用于 Second Language Pragmatics 期末实证研究的轻量级文字互动平台。

## 当前版本：0.0.1 — 前端框架

这是按步骤开发的第一个发布检查点，**尚不能收集实验数据或进行真实聊天**。

- `index.html`：英文参与者入口。入口明确标记尚未开放，表单禁用，不采集输入过程。
- `researcher.html`：中文研究者工作台，预留会话管理与 Human 回复区域。
- `assets/styles.css`：响应式样式，无外部字体或框架依赖。
- `assets/app.js`：研究者手动触发的连接检查；仅保存当前浏览器的 Worker 地址，不保存密钥。

本版没有模拟聊天或假实验数据。所有未接入功能明确标记且禁用。

## 发布到 GitHub Pages

1. 仓库 Settings → Pages。
2. Source 选择 **Deploy from a branch**。
3. Branch 选择 **main**，目录 **/(root)**，点击 Save。
4. 等待 GitHub 完成发布后，使用 Pages 设置页给出的地址。

预期入口：

- 参与者：`https://unimeleo.github.io/slp_final/`
- 研究者：`https://unimeleo.github.io/slp_final/researcher.html`

本版工作台是公开的空框架，不含研究数据；正式管理 API 后续必须做服务端身份验证。隐藏页面链接并不构成访问控制。

## 下一步

1. 部署独立的 Cloudflare Worker 与实验数据库，接入研究者验证与会话管理。
2. 打通参与者与研究者的双向文字消息。
3. 通过统一消息接口接入 AI，加入可配置的回复延迟。
4. 记录消息及只限 Participant 的草稿编辑事件，加入导出与完整性检查。
5. 接入两任务分配、正式材料及事后身份判断。

4 名参与者，每人 1 次 Human 与 1 次 AI 互动，共 8 次。任务材料待定，需保持可编辑。

## 预留的健康检查协议

部署后的 Worker 应支持 `GET /health`，返回：

```json
{"ok": true, "service": "slp-final"}
```

需要允许前端来源的跨域 GET。该检查仅确认服务可达，不解锁尚未实现的会话功能。

## 本地查看

无需构建工具。可直接打开 HTML，或从仓库目录运行：

```sh
python -m http.server 8000
```

然后访问 `http://localhost:8000/` 和 `http://localhost:8000/researcher.html`。

## 数据与配置

本版只保存研究者浏览器中的 Worker 地址。没有密钥、参与者凭证、聊天记录或草稿日志写入仓库。最终研究数据的持久化与备份方式留到后端阶段确定。
