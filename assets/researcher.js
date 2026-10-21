'use strict';
(() => {
  const { $, api, status } = SLP;
  const storageKey = 'slp_final_worker_url_v1';
  let base = '', secret = '', selected = null, pending = null, sending = false;
  let timer = null, busy = false, epoch = 0, lastList = 0, aiLoaded = false, selectVersion = 0;
  const view = SLP.chatView($('human-messages'), 'interlocutor');
  try { $('worker-url').value = localStorage.getItem(storageKey) || window.SLP_CONFIG.API_BASE; } catch (_) { /* optional local setting */ }
  const call = body => api(base, body, secret);
  const errorAt = (id, error) => status(id, error.message || String(error), true);
  function lock() {
    epoch++; selectVersion++; aiLoaded = false; clearTimeout(timer); secret = ''; selected = null; pending = null; sending = false;
    view.reset(); $('human-draft').value = ''; $('human-draft').readOnly = false;
    $('created-credentials').textContent = ''; $('credentials-receipt').hidden = true;
    $('session-rows').replaceChildren(); $('human-role').textContent = ''; $('human-participant-prompt').textContent = '';
    $('admin-workspace').hidden = true; $('human-panel').hidden = true;
    $('login-panel').hidden = false; $('logout').hidden = true;
    status('human-status', ''); status('admin-status', '工作台已锁定。');
  }
  function sessionState(session) {
    selected = session;
    $('human-session-status').textContent = { ready: '等待参与者开始', active: '进行中', ended: '已结束' }[session.status];
    const writable = session.status === 'active' && session.condition === 'human';
    $('human-draft').disabled = !writable;
    $('human-send').disabled = !writable || sending;
    $('terminate-session').disabled = session.status === 'ended';
    if (session.status === 'ended' && pending) status('human-status', '互动已结束；未发送文本保留在输入框中。', true);
  }
  async function refreshList() {
    const stamp = epoch;
    const data = await call({ action: 'admin_state' });
    if (stamp !== epoch || !secret) return;
    updateAiStatus(data);
    if (!aiLoaded) { fillAiForm(data.ai_config); aiLoaded = true; }
    const fragment = document.createDocumentFragment();
    if (!data.sessions.length) {
      const tr = document.createElement('tr'), td = document.createElement('td');
      td.colSpan = 5; td.textContent = '暂无会话。先创建 TEST01。'; tr.append(td); fragment.append(tr);
    }
    for (const session of data.sessions) {
      const tr = document.createElement('tr');
      for (const value of [session.id, session.condition === 'human' ? 'Human' : 'AI', session.scenario_code, { ready: '待开始', active: '进行中', ended: '已结束' }[session.status]]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      const td = document.createElement('td'), button = document.createElement('button');
      button.className = 'secondary compact'; button.textContent = selected?.id === session.id ? '当前会话' : '打开';
      button.addEventListener('click', () => openSession(session.id)); td.append(button); tr.append(td); fragment.append(tr);
    }
    $('session-rows').replaceChildren(fragment); lastList = performance.now();
  }
  async function readSelected() {
    if (!selected) return;
    const id = selected.id, stamp = epoch;
    const data = await call({ action: 'admin_session', session_id: id, after_id: view.cursor });
    if (stamp !== epoch || selected?.id !== id || !secret) return;
    view.append(data.messages); sessionState(data.session); showAiJobs(data);
  }
  async function poll() {
    if (busy || !secret) return;
    busy = true;
    const stamp = epoch;
    try {
      if (performance.now() - lastList > 6000) await refreshList();
      await readSelected();
    } catch (error) {
      if (stamp !== epoch) return;
      if (error.status === 401) { lock(); status('admin-status', '验证已失效，请重新连接。', true); }
      else errorAt('admin-status', error);
    } finally {
      busy = false; clearTimeout(timer);
      if (secret) timer = setTimeout(poll, document.hidden ? 5000 : 1500);
    }
  }
  async function openSession(id) {
    if (selected?.id === id) return;
    if (sending || (pending && !confirm('当前回复尚未确认发送。切换后请核对聊天记录，避免重复发送。继续切换？'))) return;
    if ($('human-draft').value.trim() && !pending && !confirm('当前输入框有未发送内容。切换会话并清除草稿？')) return;
    const stamp = epoch, selection = ++selectVersion;
    try {
      const data = await call({ action: 'admin_session', session_id: id, after_id: 0 });
      if (stamp !== epoch || selection !== selectVersion || !secret) return;
      pending = null; $('human-draft').value = ''; $('human-draft').readOnly = false;
      $('human-send').textContent = '发送回复';
      view.reset(); view.append(data.messages); sessionState(data.session); showAiJobs(data);
      $('human-title').textContent = data.session.id + ' · ' + (data.session.condition === 'human' ? 'Human 对话' : 'AI 任务监控');
      $('human-role').textContent = data.session.interlocutor_prompt;
      $('human-participant-prompt').textContent = data.session.participant_prompt;
      $('human-panel').hidden = false; status('human-status', '会话已载入。');
    } catch (error) { errorAt('admin-status', error); }
  }
  $('connection-form').addEventListener('submit', async event => {
    event.preventDefault(); $('connect-button').disabled = true;
    try {
      base = SLP.serverUrl($('worker-url').value.trim()); secret = $('admin-secret').value;
      await refreshList();
      try { localStorage.setItem(storageKey, base); } catch (_) { /* optional setting */ }
      $('admin-secret').value = '';
      $('login-panel').hidden = true; $('admin-workspace').hidden = false; $('logout').hidden = false;
      const link = new URL('./index.html', location.href); link.searchParams.set('server', base);
      $('participant-link').value = link.href;
      status('admin-status', '已连接。可创建测试会话；聊天消息将保存在 SLP 数据库。');
      poll();
    } catch (error) { secret = ''; errorAt('admin-status', error); }
    finally { $('connect-button').disabled = false; }
  });
  $('logout').addEventListener('click', () => {
    if ((sending || pending || $('human-draft').value.trim()) && !confirm('锁定将清除本页未发送草稿。已发送消息仍在数据库中。继续？')) return;
    lock();
  });
  $('copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('participant-link').value); status('admin-status', '参与者链接已复制。'); }
    catch (_) { $('participant-link').select(); status('admin-status', '请手动复制选中的参与者链接。'); }
  });
  $('refresh-sessions').addEventListener('click', () => refreshList().catch(error => errorAt('admin-status', error)));
  $('create-form').addEventListener('submit', async event => {
    event.preventDefault(); const stamp = epoch;
    $('create-fields').disabled = true;
    try {
      const scenarios = {};
      for (const code of ['A', 'B']) scenarios[code] = {
        participant: $('scenario-' + code.toLowerCase() + '-participant').value,
        interlocutor: $('scenario-' + code.toLowerCase() + '-interlocutor').value
      };
      const data = await call({ action: 'admin_create', participant_code: $('new-code').value, order_index: Number($('task-order').value), scenarios });
      if (stamp !== epoch || !secret) return;
      $('created-credentials').textContent = 'Participant: ' + data.participant_code + '\nAccess code: ' + data.access_code;
      $('credentials-receipt').hidden = false;
      status('admin-status', '两任务已创建。请保存新访问码，再进行测试。');
      await refreshList();
    } catch (error) { if (stamp === epoch) errorAt('admin-status', error); }
    finally { $('create-fields').disabled = false; }
  });
  $('human-message-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || selected?.status !== 'active' || selected.condition !== 'human') return;
    if (!pending) { const text = $('human-draft').value.trim(); if (!text) return; pending = { text, client_message_id: crypto.randomUUID() }; }
    const stamp = epoch, id = selected.id;
    sending = true; $('human-send').disabled = true; $('human-draft').readOnly = true;
    try {
      await call({ action: 'admin_send', session_id: id, ...pending });
      if (stamp !== epoch || selected?.id !== id) return;
      pending = null; $('human-draft').value = ''; $('human-send').textContent = '发送回复';
      status('human-status', '回复已发送。'); await readSelected();
    } catch (error) { if (stamp === epoch && selected?.id === id) { $('human-send').textContent = '重试发送'; errorAt('human-status', error); } }
    finally {
      if (stamp === epoch && selected?.id === id) {
        sending = false; $('human-draft').readOnly = !!pending;
        $('human-send').disabled = selected.status !== 'active' || selected.condition !== 'human';
        if (!pending) $('human-draft').focus();
      }
    }
  });
  $('terminate-session').addEventListener('click', async () => {
    if (!selected || sending || !confirm('终止当前互动？此操作会结束该任务。')) return;
    const stamp = epoch, id = selected.id;
    $('terminate-session').disabled = true;
    try {
      const data = await call({ action: 'admin_end', session_id: id });
      if (stamp !== epoch || selected?.id !== id) return;
      sessionState({ ...selected, ...data.session }); await readSelected(); await refreshList();
    } catch (error) { if (stamp === epoch) { errorAt('human-status', error); $('terminate-session').disabled = selected?.status === 'ended'; } }
  });
  for (const button of document.querySelectorAll('[data-export]')) button.addEventListener('click', async () => {
    if (!selected) return;
    const stamp = epoch, code = selected.participant_code;
    button.disabled = true;
    try {
      const data = await call({ action: 'admin_export', participant_code: code });
      if (stamp !== epoch || !secret) return;
      const format = button.dataset.export;
      const filename = code + '_chat_' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + format;
      if (format === 'json') SLP.download(JSON.stringify(data, null, 2), filename, 'application/json');
      if (format === 'csv') {
        const headers = ['session_id', 'id', 'sender', 'text', 'server_received_ms', 'client_message_id'];
        const quote = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
        const rows = data.messages.map(row => headers.map(key => quote(row[key])).join(','));
        SLP.download('\uFEFF' + headers.join(',') + '\r\n' + rows.join('\r\n'), filename, 'text/csv;charset=utf-8');
      }
      if (format === 'txt') {
        const lines = ['SLP ' + code, 'Development test; draft events are not included.'];
        for (const session of data.sessions) {
          lines.push('', '=== ' + session.id + ' | ' + session.condition + ' | ' + session.status + ' ===');
          for (const message of data.messages.filter(m => m.session_id === session.id)) lines.push(new Date(message.server_received_ms).toISOString() + ' ' + message.sender + ': ' + message.text);
        }
        SLP.download(lines.join('\n'), filename, 'text/plain;charset=utf-8');
      }
      status('human-status', '已触发 ' + format.toUpperCase() + ' 下载。');
    } catch (error) { if (stamp === epoch) errorAt('human-status', error); }
    finally { button.disabled = false; }
  });
  function fillAiForm(config) {
    if (!config) return;
    for (const [id, key] of [['ai-model','model'],['ai-delay-k','ms_per_character'],['ai-delay-min','random_min_ms'],['ai-delay-max','random_max_ms'],['ai-output-budget','max_output_tokens'],['ai-reasoning','reasoning_effort'],['ai-base-prompt','base_prompt']]) $(id).value = config[key];
  }
  function updateAiStatus(data) {
    $('ai-config-state').textContent = data.ai_enabled ? '已配置 · 需实际测试' : (data.api_key_configured ? '请配置模型' : '未设置 OPENAI_API_KEY');
    $('ai-config-state').className = 'badge' + (data.ai_enabled ? ' connected' : '');
  }
  function showAiJobs(data) {
    $('ai-monitor').hidden = data.session.condition !== 'ai';
    const labels = { queued:'排队', generating:'生成中', ready:'等待目标时间', delivered:'已送入聊天', error:'失败', cancelled:'已取消', superseded:'已合并' };
    $('ai-job-status').textContent = (data.ai_jobs || []).map(job => '#' + job.trigger_message_id + ' ' + labels[job.state] + (job.error_code ? ' (' + job.error_code + ')' : '')).join(' · ') || '等待参与者消息。';
    $('retry-ai').disabled = data.session.status !== 'active' || !(data.ai_jobs || []).some(job => job.state === 'error' || (job.state === 'generating' && job.generation_started_ms < Date.now() - 60000));
  }
  $('ai-config-form').addEventListener('submit', async event => {
    event.preventDefault(); const stamp = epoch;
    $('ai-config-fields').disabled = true;
    try {
      const config = {
        model: $('ai-model').value.trim(), base_prompt: $('ai-base-prompt').value,
        ms_per_character: Number($('ai-delay-k').value), random_min_ms: Number($('ai-delay-min').value), random_max_ms: Number($('ai-delay-max').value),
        max_output_tokens: Number($('ai-output-budget').value), reasoning_effort: $('ai-reasoning').value
      };
      const data = await call({ action:'admin_save_ai', config });
      if (stamp !== epoch || !secret) return;
      updateAiStatus(data); fillAiForm(data.ai_config); status('admin-status','AI 配置已保存。已开始的 AI 任务继续使用原快照。');
    } catch (error) { if (stamp === epoch) errorAt('admin-status',error); }
    finally { $('ai-config-fields').disabled = false; }
  });
  $('retry-ai').addEventListener('click', async () => {
    if (!selected || !confirm('重试将重新调用 API 生成尚未成功的回复。继续？')) return;
    const id = selected.id, stamp = epoch;
    $('retry-ai').disabled = true;
    try {
      await call({ action:'admin_retry_ai', session_id:id });
      if (stamp !== epoch || selected?.id !== id) return;
      await readSelected(); status('human-status','已重新排队；参与者页面继续连接时会处理。');
    } catch (error) { if (stamp === epoch) errorAt('human-status',error); }
  });
  SLP.enterToSend($('human-draft'), $('human-message-form'));
})();
