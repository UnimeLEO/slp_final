'use strict';
window.SLP = (() => {
  const $ = id => document.getElementById(id);
  function serverUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Please use an HTTPS Worker URL without credentials or query parameters.');
    }
    return url.href.replace(/\/+$/, '');
  }
  async function api(base, body, secret = '') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (secret) headers.Authorization = 'Bearer ' + secret;
      const response = await fetch(base + '/api', {
        method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit',
        cache: 'no-store', signal: controller.signal
      });
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error('The server did not return JSON. Check the Worker deployment.'); }
      if (!response.ok || !data.ok) {
        const error = new Error(data.error || 'Request failed.');
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Connection timed out. You can retry safely.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function status(id, message, error = false) {
    const element = $(id);
    element.textContent = message;
    element.className = 'status-text' + (error ? ' error' : '');
  }
  function download(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function chatView(element, ownRole, { otherLabel, showSeconds = true, onAppend } = {}) {
    let cursor = 0;
    const seen = new Set();
    return {
      get cursor() { return cursor; },
      reset() { cursor = 0; seen.clear(); element.replaceChildren(); },
      append(rows) {
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        const appended = [];
        for (const row of [...rows].sort((a, b) => a.id - b.id)) {
          if (seen.has(row.id)) continue;
          if (!seen.size) element.replaceChildren();
          seen.add(row.id); cursor = Math.max(cursor, row.id);
          const item = document.createElement('div');
          item.className = 'chat-message ' + (row.sender === ownRole ? 'own' : 'other');
          const label = document.createElement('div'); label.className = 'message-label';
          label.textContent = row.sender === ownRole ? 'You' : (otherLabel || (ownRole === 'participant' ? 'Interlocutor X' : 'Participant'));
          const content = document.createElement('div'); content.className = 'message-text'; content.textContent = row.text;
          const time = document.createElement('time');
          time.dateTime = new Date(row.server_received_ms).toISOString();
          time.textContent = new Date(row.server_received_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, ...(showSeconds ? { second: '2-digit' } : {}) });
          item.append(label, content, time); element.append(item); appended.push([row,item]);
        }
        if (nearBottom) element.scrollTop = element.scrollHeight;
        for (const [row,item] of appended) onAppend?.(row,item);
      }
    };
  }
  function enterToSend(textarea, form) {
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); form.requestSubmit();
      }
    });
  }
  return { $, serverUrl, api, status, download, chatView, enterToSend };
})();
