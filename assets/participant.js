'use strict';
(() => {
  const { $, api, status } = SLP;
  const query = new URLSearchParams(location.search);
  let base = '', credentials = null, session = null, pollTimer = null, polling = false;
  let pending = null, sending = false, controlBusy = false;
  const view = SLP.chatView($('messages'), 'participant');
  try { base = SLP.serverUrl(query.get('server') || window.SLP_CONFIG.API_BASE); }
  catch (_) {
    $('entry-fields').disabled = true;
    status('entry-status', 'Please use the session link supplied by the researcher.');
  }
  if (query.get('participant')) $('participant-code').value = query.get('participant');
  const call = body => api(base, { ...credentials, ...body });
  const showError = (id, error) => status(id, error.message || String(error), true);
  function apply(next) {
    session = next;
    const active = session.status === 'active';
    $('session-status').textContent = { ready: 'Ready', active: 'In progress', ended: 'Ended' }[session.status];
    $('start-task').hidden = session.status !== 'ready';
    $('end-task').hidden = !active;
    $('next-task').hidden = session.status !== 'ended';
    $('message-draft').disabled = !active;
    $('send-message').disabled = !active || sending;
    if (!active && pending) {
      status('chat-status', 'This conversation has ended. The unsent text remains in the input box.', true);
    }
    if (session.status === 'ended') clearTimeout(pollTimer);
  }
  async function poll() {
    if (polling || !session) return;
    polling = true;
    const id = session.id;
    try {
      const data = await call({ action: 'participant_session', session_id: id, after_id: view.cursor });
      if (session?.id !== id) return;
      view.append(data.messages); apply(data.session);
      if (!pending) status('chat-status', data.service_notice || (data.session.status === 'ended' ? 'This conversation has ended.' : 'Connected.'), !!data.service_notice);
    } catch (error) { showError('chat-status', error); }
    finally {
      polling = false;
      clearTimeout(pollTimer);
      if (session?.status !== 'ended') pollTimer = setTimeout(poll, document.hidden ? 5000 : 1500);
    }
  }
  async function openNext() {
    const data = await call({ action: 'participant_join' });
    $('entry-page').hidden = true;
    if (data.complete) {
      session = null; clearTimeout(pollTimer);
      $('conversation-page').hidden = true; $('complete-page').hidden = false;
      return;
    }
    $('conversation-page').hidden = false;
    $('task-heading').textContent = 'Task ' + data.session.task_number;
    $('task-label').textContent = credentials.participant_code + ' · Task ' + data.session.task_number + ' of 2';
    $('task-prompt').textContent = data.session.participant_prompt;
    pending = null; $('message-draft').value = ''; $('message-draft').readOnly = false;
    $('send-message').textContent = 'Send'; view.reset(); apply(data.session);
    await poll();
  }
  $('entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!base) return;
    $('entry-fields').disabled = true;
    credentials = { participant_code: $('participant-code').value.trim().toUpperCase(), access_code: $('access-code').value.trim().toUpperCase() };
    try { await openNext(); $('access-code').value = ''; }
    catch (error) { credentials = null; showError('entry-status', error); }
    finally { $('entry-fields').disabled = false; }
  });
  $('start-task').addEventListener('click', async () => {
    if (controlBusy || !session) return;
    controlBusy = true; $('start-task').disabled = true;
    try {
      const data = await call({ action: 'participant_start', session_id: session.id });
      apply(data.session); await poll(); $('message-draft').focus();
    } catch (error) { showError('chat-status', error); }
    finally { controlBusy = false; $('start-task').disabled = false; }
  });
  $('message-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || session?.status !== 'active') return;
    if (!pending) {
      const text = $('message-draft').value.trim(); if (!text) return;
      pending = { text, client_message_id: crypto.randomUUID() };
    }
    sending = true; $('send-message').disabled = true; $('message-draft').readOnly = true;
    try {
      await call({ action: 'participant_send', session_id: session.id, ...pending });
      pending = null; $('message-draft').value = ''; $('send-message').textContent = 'Send';
      status('chat-status', 'Message sent.'); void poll();
    } catch (error) { $('send-message').textContent = 'Retry send'; showError('chat-status', error); }
    finally {
      sending = false; $('message-draft').readOnly = !!pending;
      $('send-message').disabled = session?.status !== 'active';
      if (!pending) $('message-draft').focus();
    }
  });
  $('end-task').addEventListener('click', async () => {
    if (controlBusy || sending || !session) return;
    if (!confirm('End this conversation? Any unsent text will not be sent.')) return;
    controlBusy = true; $('end-task').disabled = true;
    try {
      const data = await call({ action: 'participant_end', session_id: session.id });
      apply(data.session); await poll();
    } catch (error) { showError('chat-status', error); }
    finally { controlBusy = false; $('end-task').disabled = false; }
  });
  $('next-task').addEventListener('click', async () => {
    if (controlBusy) return;
    controlBusy = true; $('next-task').disabled = true;
    try { await openNext(); }
    catch (error) { showError('chat-status', error); }
    finally { controlBusy = false; $('next-task').disabled = false; }
  });
  SLP.enterToSend($('message-draft'), $('message-form'));
  window.addEventListener('beforeunload', event => {
    if (session?.status !== 'active') return;
    event.preventDefault(); event.returnValue = '';
  });
})();
