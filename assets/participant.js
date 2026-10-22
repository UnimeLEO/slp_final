'use strict';
(() => {
  const { $, api, status } = SLP;
  const query = new URLSearchParams(location.search);
  let base = '', credentials = null, session = null, pollTimer = null, polling = false;
  let pending = null, sending = false, controlBusy = false;
  let recorder = null, recordingFinishing = null, initialSync = true;
  const interlocutorName = window.SLP_CONFIG.INTERLOCUTOR_NAME || 'Jimmy';
  $('interlocutor-name').textContent = interlocutorName;
  const view = SLP.chatView($('messages'), 'participant', { otherLabel: interlocutorName, showSeconds: false,
    onAppend: (row,element) => recorder?.observeMessage(row,element,{initialSync}) });
  try { base = SLP.serverUrl(query.get('server') || window.SLP_CONFIG.API_BASE); }
  catch (_) {
    $('entry-fields').disabled = true;
    status('entry-status', 'Please use the session link supplied by the researcher.');
  }
  if (query.get('participant')) $('participant-code').value = query.get('participant');
  const accessFields = [1, 2, 3].map(number => $('access-code-' + number));
  const updateEntry = () => { $('join-button').disabled = !base || !$('entry-form').checkValidity(); };
  $('participant-code').addEventListener('input', updateEntry);
  accessFields.forEach((field, index) => {
    field.addEventListener('input', () => {
      field.value = field.value.toUpperCase();
      if (/^[A-Z0-9]{4}$/.test(field.value)) accessFields[index + 1]?.focus();
      updateEntry();
    });
    field.addEventListener('paste', event => {
      const text = event.clipboardData.getData('text').trim().replace(/[\s\-–—]/g, '').toUpperCase();
      if (!/^[A-Z0-9]{12}$/.test(text)) return;
      event.preventDefault();
      accessFields.forEach((part, partIndex) => { part.value = text.slice(partIndex * 4, partIndex * 4 + 4); });
      accessFields[2].focus(); updateEntry();
    });
    field.addEventListener('keydown', event => {
      if (event.key === 'Backspace' && !field.value && index > 0) accessFields[index - 1].focus();
    });
  });
  updateEntry();
  const call = body => api(base, { ...credentials, ...body });
  const showError = (id, error) => status(id, error.message || String(error), true);
  function recordingStatus(message,error) {
    status('recording-status',message,error);
    $('save-local-backup').hidden = !error;
    if (session) apply(session);
  }
  async function ensureRecorder() {
    if (recorder || session?.status !== 'active') return;
    recorder = await SLPLogging.create({ base,participantId:credentials.participant_code,sessionId:session.id,textarea:$('message-draft'),messageContainer:$('messages'),call,
      onStatus:recordingStatus,onFatal:()=>{ if(session) apply(session); } });
    pending = recorder.pending;
    $('send-message').textContent = pending ? 'Retry send' : 'Send';
    apply(session);
  }
  async function finishRecording(reason) {
    if (!recorder) return;
    if (recordingFinishing) return recordingFinishing;
    recordingFinishing=recorder.stop(reason);
    apply(session);
    try { await recordingFinishing; pending=null; }
    finally { recordingFinishing=null;apply(session); }
  }
  function apply(next) {
    session = next;
    const active = session.status === 'active';
    $('session-status').textContent = { ready: 'Ready', active: 'In progress', ended: 'Ended' }[session.status];
    $('start-task').hidden = session.status !== 'ready';
    $('end-task').hidden = !active;
    $('next-task').hidden = session.status !== 'ended';
    $('message-draft').disabled = !active || !recorder;
    $('message-draft').readOnly = !recorder?.canEdit || sending || controlBusy;
    $('send-message').disabled = !active || sending || controlBusy || !recorder || !!recorder.failure || recorder.closed;
    $('next-task').disabled = !!recordingFinishing || controlBusy || !!(recorder && recorder.queue.length);
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
      initialSync=false;
      if (data.session.status === 'ended' && recorder) await finishRecording('server_ended');
      if (!pending) status('chat-status', data.service_notice || (data.session.status === 'ended' ? 'This conversation has ended.' : ''), !!data.service_notice);
    } catch (error) { showError('chat-status', error); }
    finally {
      polling = false;
      clearTimeout(pollTimer);
      if (session?.status !== 'ended') pollTimer = setTimeout(poll, document.hidden ? 5000 : 1500);
    }
  }
  async function openNext() {
    const data = await call({ action: 'participant_join' });
    if (data.recording_enabled !== true) throw new Error('Typing recording is not ready. Please contact the researcher.');
    await SLPLogging.recover({base,participantId:credentials.participant_code,excludeSession:data.session?.id,call});
    if (data.complete) {
      $('entry-page').hidden = true;
      session = null; clearTimeout(pollTimer);
      $('conversation-page').hidden = true; $('complete-page').hidden = false;
      return;
    }
    $('task-heading').textContent = 'Task ' + data.session.task_number + '/2';
    $('task-prompt').textContent = data.session.participant_prompt;
    pending = null; $('message-draft').value = '';
    $('send-message').textContent = 'Send';$('end-task').textContent='End conversation';view.reset(); initialSync=true;apply(data.session);
    await ensureRecorder();
    $('entry-page').hidden = true;$('conversation-page').hidden = false;
    await poll();
  }
  $('entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!base) return;
    $('entry-fields').disabled = true;
    credentials = { participant_code: $('participant-code').value.trim().toUpperCase(), access_code: accessFields.map(field => field.value.trim().toUpperCase()).join('-') };
    try { await openNext(); accessFields.forEach(field => { field.value = ''; }); }
    catch (error) { credentials = null; showError('entry-status', error); }
    finally { $('entry-fields').disabled = false; updateEntry(); }
  });
  $('start-task').addEventListener('click', async () => {
    if (controlBusy || !session) return;
    controlBusy = true; $('start-task').disabled = true;
    try {
      const data = await call({ action: 'participant_start', session_id: session.id });
      apply(data.session); await ensureRecorder();await poll(); $('message-draft').focus();
    } catch (error) { showError('chat-status', error); }
    finally { controlBusy = false; $('start-task').disabled = false;if(session) apply(session); }
  });
  $('message-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || controlBusy || session?.status !== 'active' || !recorder || recorder.closed) return;
    if (!event.submitter && recorder.compositionEndedAt != null && performance.now()-recorder.compositionEndedAt<50) return;
    let payload;
    try { payload=recorder.prepareSend();if(!payload) return;pending=recorder.pending; }
    catch(error) { showError('chat-status',error);return; }
    sending = true; $('send-message').disabled = true; $('message-draft').readOnly = true;
    try {
      await recorder.persist();
      const data=await call({ action: 'participant_send', session_id: session.id, ...payload });
      // Show the confirmed message without waiting for a poll/model generation.
      // Only poll responses may advance the cursor: older unseen replies can still exist.
      view.append([data.message], { advanceCursor: false });
      await recorder.acknowledge(data.message);
      pending = null;$('send-message').textContent = 'Send';
      status('chat-status', 'Message sent.'); void poll();
    } catch (error) { recorder.sendFailed(error);$('send-message').textContent = 'Retry send'; showError('chat-status', error); }
    finally {
      sending = false;apply(session);
      if (!pending) $('message-draft').focus();
    }
  });
  $('end-task').addEventListener('click', async () => {
    if (controlBusy || sending || !session) return;
    if (!confirm('End this conversation? Any unsent text will not be sent.')) return;
    controlBusy = true; $('end-task').disabled = true;
    try {
      $('message-draft').readOnly=true;
      await finishRecording('ended_by_participant');
      const data = await call({ action: 'participant_end', session_id: session.id });
      apply(data.session); await poll();
    } catch (error) { $('end-task').textContent='Retry end';showError('chat-status', error); }
    finally { controlBusy = false; $('end-task').disabled = false;apply(session); }
  });
  $('next-task').addEventListener('click', async () => {
    if (controlBusy) return;
    controlBusy = true; $('next-task').disabled = true;
    try { await finishRecording('continue');recorder?.dispose();recorder=null;await openNext(); }
    catch (error) { showError('chat-status', error); }
    finally { controlBusy = false; $('next-task').disabled = false;if(session) apply(session); }
  });
  SLP.enterToSend($('message-draft'), $('message-form'));
  $('save-local-backup').addEventListener('click',()=>{
    if (!recorder) return;
    SLP.download(JSON.stringify(recorder.backup(),null,2),credentials.participant_code+'_'+session.id+'_recording_backup.json','application/json');
  });
  window.addEventListener('beforeunload', event => {
    if (session?.status !== 'active' && !recorder?.queue.length) return;
    event.preventDefault(); event.returnValue = '';
  });
})();
