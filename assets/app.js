"use strict";

// v0.0.1 is a frontend foundation. It deliberately cannot start a study session.
// The only request made here is an explicit researcher-triggered health check.
(() => {
  const entry = document.getElementById("entry-form");
  if (entry) entry.addEventListener("submit", event => event.preventDefault());
  const form = document.getElementById("connection-form");
  if (!form) return;

  const key = "slp_final_worker_url_v1";
  const input = document.getElementById("worker-url");
  const badge = document.getElementById("connection-badge");
  const status = document.getElementById("connection-status");
  const check = document.getElementById("check-connection");
  const clear = document.getElementById("clear-connection");

  function show(message, state = "") {
    status.textContent = message;
    status.className = "status-text " + state;
  }

  try {
    input.value = localStorage.getItem(key) || "";
  } catch (_) { /* A browser may disallow storage. The health check still works. */ }
  if (input.value) {
    badge.textContent = "待检查";
    show("已载入当前浏览器保存的地址；尚未验证连接。");
  }

  clear.addEventListener("click", () => {
    try { localStorage.removeItem(key); } catch (_) { /* optional browser setting */ }
    input.value = "";
    badge.textContent = "未配置";
    badge.className = "badge";
    show("已清除当前浏览器保存的地址。");
  });

  input.addEventListener("input", () => {
    badge.textContent = input.value.trim() ? "待检查" : "未配置";
    badge.className = "badge";
    show("地址已更改，请保存并检查。");
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    let endpoint;
    try {
      endpoint = new URL(input.value.trim());
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error("请填写不含账号、查询参数或片段的 HTTPS Worker 地址。");
      }
      endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + "/health";
    } catch (error) {
      show(error.message || "请输入有效的 HTTPS 地址。", "error");
      return;
    }

    const base = input.value.trim().replace(/\/+$/, "");
    let saved = true;
    try { localStorage.setItem(key, base); } catch (_) { saved = false; }
    check.disabled = true;
    clear.disabled = true;
    input.disabled = true;
    badge.className = "badge";
    badge.textContent = "检查中";
    show("正在检查后端服务……");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(endpoint.href, {
        method: "GET", cache: "no-store", credentials: "omit", signal: controller.signal
      });
      if (!response.ok) throw new Error("服务返回 HTTP " + response.status + "。");
      const body = await response.json();
      if (body.ok !== true || body.service !== "slp-final") {
        throw new Error("该地址尚未提供匹配的 SLP 健康检查接口。");
      }
      badge.textContent = "可连接";
      badge.className = "badge connected";
      show("健康检查通过。会话功能仍待接入。" + (saved ? "" : " 当前浏览器无法保存地址。"), "success");
    } catch (error) {
      badge.textContent = "未连接";
      show(error.name === "AbortError"
        ? "连接超时，请检查 Worker 是否已经部署。"
        : "连接未成功：" + error.message + " 请检查部署地址及跨域配置。", "error");
    } finally {
      clearTimeout(timeout);
      check.disabled = false;
      clear.disabled = false;
      input.disabled = false;
    }
  });
})();
