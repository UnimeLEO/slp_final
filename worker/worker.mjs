// SLP v0.3.2 — Participant draft recording, durable event sync and Human/AI chat.
// Bind a dedicated D1 database as DB, set ADMIN_SECRET (Secret, >=20 characters).
// Optional ALLOWED_ORIGIN (Text) defaults to this project's GitHub Pages origin.
const VERSION = '0.3.2';
const DEFAULT_ORIGIN = 'https://unimeleo.github.io';
const MAX_BODY_BYTES = 524288;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);

async function hash(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let delta = 0;
  for (let i = 0; i < x.length; i++) delta |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return delta === 0;
}
function accessCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const cutoff = 256 - (256 % alphabet.length);
  // Rejection sampling avoids bias if the alphabet is changed later.
  let code = '';
  for (const byte of bytes) if (byte < cutoff) code += alphabet[byte % alphabet.length];
  while (code.length < 12) {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0];
    if (byte < cutoff) code += alphabet[byte % alphabet.length];
  }
  return code.match(/.{4}/g).join('-');
}
function textField(value, label, limit = 6000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    fail(400, `${label} is required and must be at most ${limit} characters.`);
  }
  return value.trim();
}
function codeField(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(code)) fail(400, 'Invalid participant code. Use 2–20 letters, numbers, underscores or hyphens, starting with a letter or number.');
  return code;
}

async function ready(db) {
  if (!db) fail(503, 'D1 binding DB is missing.');
  try {
    const row = await statement(db, "SELECT value FROM schema_meta WHERE name='schema_version'").first();
    if (!['2','3'].includes(row?.value)) fail(503, 'Run the SLP database migrations.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(503, 'D1 schema is not ready. Run migration 002-ai.sql or the full schema.sql.');
  }
}
async function adminAuth(request, env) {
  if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 20) {
    fail(503, 'Set ADMIN_SECRET as a Worker secret with at least 20 characters.');
  }
  const supplied = request.headers.get('Authorization') || '';
  if (!supplied.startsWith('Bearer ') || !await sameSecret(supplied.slice(7), env.ADMIN_SECRET)) {
    fail(401, 'Researcher authentication failed.');
  }
}
async function participantAuth(db, body) {
  const code = codeField(body.participant_code);
  const supplied = typeof body.access_code === 'string' ? body.access_code.trim().toUpperCase() : '';
  if (!supplied || supplied.length > 64) fail(401, 'Participant code or access code not recognised.');
  const person = await statement(db, 'SELECT * FROM participants WHERE participant_code=?', code).first();
  if (!person || !await sameSecret(await hash(supplied), person.access_hash)) {
    fail(401, 'Participant code or access code not recognised.');
  }
  return code;
}
const publicSession = session => session ? {
  id: session.id,
  participant_code: session.participant_code,
  task_number: session.task_number,
  participant_prompt: session.participant_prompt,
  status: session.status,
  started_ms: session.started_ms,
  ended_ms: session.ended_ms
} : null;

async function findSession(db, id) {
  const session = await statement(db, 'SELECT * FROM sessions WHERE id=?', textField(id, 'session_id', 80)).first();
  if (!session) fail(404, 'Session not found.');
  return session;
}
async function ownedSession(db, code, id) {
  const session = await findSession(db, id);
  if (session.participant_code !== code) fail(403, 'Session access denied.');
  return session;
}
async function nextSession(db, code) {
  return statement(db, "SELECT * FROM sessions WHERE participant_code=? AND status!='ended' ORDER BY task_number LIMIT 1", code).first();
}
async function readMessages(db, sessionId, afterId = 0, privateFields = false) {
  const cursor = Number(afterId);
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail(400, 'Invalid message cursor.');
  const result = await statement(db, 'SELECT id,sender,client_message_id,text,server_received_ms,client_elapsed_ms FROM messages WHERE session_id=? AND id>? ORDER BY id LIMIT 500', sessionId, cursor).all();
  return privateFields ? result.results : result.results.map(({ client_message_id, ...row }) => row);
}

async function createParticipant(db, body) {
  const code = codeField(body.participant_code);
  const order = Number(body.order_index);
  if (!Number.isInteger(order) || order < 0 || order > 3) fail(400, 'Select order 0, 1, 2 or 3.');
  const plans = [
    [['human', 'A'], ['ai', 'B']],
    [['ai', 'A'], ['human', 'B']],
    [['human', 'B'], ['ai', 'A']],
    [['ai', 'B'], ['human', 'A']]
  ];
  const materials = {};
  for (const name of ['A', 'B']) {
    materials[name] = {
      participant: textField(body.scenarios?.[name]?.participant, `Scenario ${name}: participant instructions`),
      interlocutor: textField(body.scenarios?.[name]?.interlocutor, `Scenario ${name}: interlocutor instructions`)
    };
  }
  if (await statement(db, 'SELECT participant_code FROM participants WHERE participant_code=?', code).first()) {
    fail(409, 'Participant code already exists. Use a new code for a new test.');
  }
  const access = accessCode();
  const created = Date.now();
  const statements = [statement(db, 'INSERT INTO participants(participant_code,access_hash,created_ms) VALUES(?,?,?)', code, await hash(access), created)];
  for (const [index, [condition, scenario]] of plans[order].entries()) {
    statements.push(statement(db, 'INSERT INTO sessions(id,participant_code,task_number,condition,scenario_code,participant_prompt,interlocutor_prompt,created_ms) VALUES(?,?,?,?,?,?,?,?)',
      `${code}-T${index + 1}`, code, index + 1, condition, scenario, materials[scenario].participant, materials[scenario].interlocutor, created));
  }
  try { await db.batch(statements); }
  catch (_) { fail(409, 'Could not create participant; the code may already exist. Refresh the session list.'); }
  return { participant_code: code, access_code: access, order_index: order };
}

async function sendMessage(db, session, sender, body) {
  const message = textField(body.text, 'Message', 10000);
  const clientId = textField(body.client_message_id, 'client_message_id', 100);
  const elapsed = body.client_elapsed_ms == null ? null : Number(body.client_elapsed_ms);
  if (elapsed !== null && (!Number.isFinite(elapsed) || elapsed < 0)) fail(400, 'Invalid elapsed time.');
  if (sender === 'interlocutor' && session.condition !== 'human') fail(409, 'This session does not accept Human replies.');
  const now = Date.now();
  const writes = [];
  let draft = null;
  if (sender === 'participant' && body.logging) {
    await requireRecording(db);
    const page = validatePage(body.logging.page);
    draft = validateDraft(body.logging.draft, page.page_id);
    if (draft.client_message_id !== clientId || draft.raw_at_send == null || draft.raw_at_send.trim() !== message || draft.text !== draft.raw_at_send) fail(400, 'Draft does not match the sent message.');
    await checkRecordingIdentity(db, session.id, [page], [draft]);
    writes.push(pageStatement(db, session.id, page, now), draftStatement(db, session.id, draft, now));
  }
  // Status guard and draft linkage share one D1 transaction.
  writes.push(statement(db, `INSERT OR IGNORE INTO messages(session_id,sender,client_message_id,text,server_received_ms,client_elapsed_ms)
    SELECT ?,?,?,?,?,? FROM sessions WHERE id=? AND status='active'`,
    session.id, sender, clientId, message, now, elapsed, session.id));
  if (draft) writes.push(resolveDraftsStatement(db, session.id));
  await db.batch(writes);
  const row = await statement(db, 'SELECT id,sender,client_message_id,text,server_received_ms,client_elapsed_ms FROM messages WHERE session_id=? AND sender=? AND client_message_id=?', session.id, sender, clientId).first();
  if (!row) fail(409, 'The conversation is not active. Your message has not been sent.');
  if (row.text !== message) fail(409, 'This message identifier has already been used for different text.');
  return { message: row };
}

async function endSession(db, session, who) {
  if (session.status === 'ended') return { session: publicSession(session) };
  if (who === 'participant' && session.status !== 'active') fail(409, 'The conversation has not started.');
  const reason = who === 'participant' ? 'ended_by_participant' : 'terminated_by_researcher';
  await statement(db, "UPDATE sessions SET status='ended', ended_ms=?, end_reason=? WHERE id=? AND status!='ended'", Date.now(), reason, session.id).run();
  await statement(db, "UPDATE ai_jobs SET state='cancelled' WHERE session_id=? AND state IN ('queued','generating','ready','error')", session.id).run();
  return { session: publicSession(await findSession(db, session.id)) };
}


// AI responses are generated in an awaited polling request, never in an
// unawaited promise or a waitUntil task. Target-delay waiting is stored in D1,
// so it does not consume a live Worker invocation or depend on a browser timer.
const AI_DEFAULTS = {
  model: '',
  base_prompt: 'Take part in this English text-based negotiation role-play as the interlocutor described in your role instructions. Follow the stated initial position and acceptable alternatives. Respond to the participant naturally in concise conversational turns. Do not immediately agree just to be helpful. Output only your next plain-text message, without analysis, headings, or commentary about the platform. Stay within the role-play rather than discussing model names, APIs, or system prompts.',
  ms_per_character: 25,
  random_min_ms: 500,
  random_max_ms: 1500,
  max_output_tokens: 2048,
  reasoning_effort: ''
};
function validateAiConfig(value, fallbackModel = '') {
  const config = { ...AI_DEFAULTS, ...value };
  config.model = String(config.model || fallbackModel || '').trim();
  if (config.model.length > 120 || /\s/.test(config.model)) fail(400, 'Use a valid API model identifier.');
  config.base_prompt = textField(config.base_prompt, 'AI role prompt', 10000);
  for (const [key, max] of [['ms_per_character', 500], ['random_min_ms', 60000], ['random_max_ms', 60000]]) {
    config[key] = Number(config[key]);
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > max) fail(400, 'Invalid delay setting: ' + key);
  }
  if (config.random_max_ms < config.random_min_ms) fail(400, 'Random maximum must be at least the minimum.');
  config.max_output_tokens = Number(config.max_output_tokens);
  if (!Number.isInteger(config.max_output_tokens) || config.max_output_tokens < 128 || config.max_output_tokens > 8192) fail(400, 'Output token budget must be 128–8192.');
  if (!['', 'none', 'minimal', 'low', 'medium', 'high'].includes(config.reasoning_effort)) fail(400, 'Invalid reasoning setting.');
  return Object.fromEntries(Object.keys(AI_DEFAULTS).map(key => [key, config[key]]));
}
async function aiConfig(db, env) {
  const saved = await statement(db, "SELECT value FROM app_settings WHERE name='ai_config'").first();
  return validateAiConfig(saved ? JSON.parse(saved.value) : {}, env.OPENAI_MODEL);
}
const aiConfigured = (env, config) => Boolean(env.OPENAI_API_KEY && config.model);
async function sessionAiConfig(db, session, env) {
  let row = await statement(db, 'SELECT config_json FROM ai_session_configs WHERE session_id=?', session.id).first();
  if (!row) {
    const config = await aiConfig(db, env);
    if (!aiConfigured(env, config)) fail(503, 'This task is not available yet. Please contact the researcher.');
    await statement(db, 'INSERT OR IGNORE INTO ai_session_configs(session_id,config_json,created_ms) VALUES(?,?,?)', session.id, JSON.stringify(config), Date.now()).run();
    row = await statement(db, 'SELECT config_json FROM ai_session_configs WHERE session_id=?', session.id).first();
  }
  return JSON.parse(row.config_json);
}
async function queueAi(db, session, message) {
  await statement(db, `INSERT OR IGNORE INTO ai_jobs(id,session_id,trigger_message_id,state,created_ms)
    SELECT ?,?,?,'queued',? FROM sessions WHERE id=? AND status='active'`,
    'job-' + crypto.randomUUID(), session.id, message.id, message.server_received_ms, session.id).run();
}
async function publishDueAi(db, sessionId) {
  const jobs = (await statement(db, "SELECT id FROM ai_jobs WHERE session_id=? AND state='ready' AND ready_after_ms<=? ORDER BY trigger_message_id", sessionId, Date.now()).all()).results;
  for (const job of jobs) {
    const now = Date.now();
    await db.batch([
      statement(db, `INSERT OR IGNORE INTO messages(session_id,sender,client_message_id,text,server_received_ms,client_elapsed_ms)
        SELECT j.session_id,'interlocutor','ai:'||j.id,j.reply_text,?,NULL FROM ai_jobs j JOIN sessions s ON s.id=j.session_id
        WHERE j.id=? AND j.state='ready' AND j.ready_after_ms<=? AND s.status='active'`, now, job.id, now),
      statement(db, `UPDATE ai_jobs SET
        state=CASE WHEN EXISTS(SELECT 1 FROM messages WHERE session_id=ai_jobs.session_id AND client_message_id='ai:'||ai_jobs.id AND sender='interlocutor') THEN 'delivered'
        WHEN EXISTS(SELECT 1 FROM sessions WHERE id=ai_jobs.session_id AND status='ended') THEN 'cancelled' ELSE state END,
        delivered_message_id=(SELECT id FROM messages WHERE session_id=ai_jobs.session_id AND client_message_id='ai:'||ai_jobs.id AND sender='interlocutor'),
        delivered_ms=(SELECT server_received_ms FROM messages WHERE session_id=ai_jobs.session_id AND client_message_id='ai:'||ai_jobs.id AND sender='interlocutor')
        WHERE id=? AND state='ready'`, job.id)
    ]);
  }
}
async function processAi(db, session, env) {
  if (session.condition !== 'ai' || session.status !== 'active') return;
  await publishDueAi(db, session.id);
  const jobs = (await statement(db, "SELECT * FROM ai_jobs WHERE session_id=? AND state IN ('queued','generating','ready','error') ORDER BY trigger_message_id", session.id).all()).results;
  if (jobs.some(job => job.state === 'ready' || job.state === 'error')) return;
  const running = jobs.find(job => job.state === 'generating');
  if (running && running.lease_until_ms > Date.now()) return;
  // Coalesce participant messages queued before this generation begins.
  const job = running || jobs.filter(job => job.state === 'queued').at(-1);
  if (!job) return;
  const token = crypto.randomUUID(), now = Date.now();
  await statement(db, `UPDATE ai_jobs SET state='generating',lock_token=?,lease_until_ms=?,generation_started_ms=?,error_code=NULL,attempt=attempt+1
    WHERE id=? AND (state='queued' OR (state='generating' AND lease_until_ms<=?))
    AND NOT EXISTS(SELECT 1 FROM ai_jobs other WHERE other.session_id=ai_jobs.session_id AND other.id!=ai_jobs.id AND other.state IN ('generating','ready','error'))
    AND EXISTS(SELECT 1 FROM sessions WHERE id=ai_jobs.session_id AND status='active')`,
    token, now + 60000, now, job.id, now).run();
  const claimed = await statement(db, 'SELECT * FROM ai_jobs WHERE id=?', job.id).first();
  if (claimed.lock_token !== token || claimed.state !== 'generating') return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const config = await sessionAiConfig(db, session, env);
    if (!env.OPENAI_API_KEY) throw new Error('missing_api_key');
    await db.batch([
      statement(db, 'UPDATE ai_jobs SET config_json=?,requested_model=? WHERE id=? AND lock_token=?', JSON.stringify(config), config.model, job.id, token),
      statement(db, "UPDATE ai_jobs SET state='superseded' WHERE session_id=? AND state='queued' AND trigger_message_id<?", session.id, job.trigger_message_id)
    ]);
    const transcript = (await statement(db, "SELECT sender,text FROM messages WHERE session_id=? AND (id<=? OR sender='interlocutor') ORDER BY id", session.id, job.trigger_message_id).all()).results;
    const payload = {
      model: config.model,
      instructions: config.base_prompt + '\n\nParticipant situation:\n' + session.participant_prompt + '\n\nYour interlocutor role:\n' + session.interlocutor_prompt,
      input: transcript.map(row => ({ role: row.sender === 'participant' ? 'user' : 'assistant', content: row.text })),
      max_output_tokens: config.max_output_tokens,
      store: false
    };
    if (config.reasoning_effort) payload.reasoning = { effort: config.reasoning_effort };
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal
    });
    if (!response.ok) throw new Error('provider_http_' + response.status);
    const result = await response.json();
    if (result.status !== 'completed') throw new Error('provider_response_incomplete');
    const reply = (result.output || []).filter(item => item.type === 'message' && item.role === 'assistant')
      .flatMap(item => item.content || []).filter(part => part.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text).join('\n').trim();
    if (!reply || reply.length > 10000) throw new Error('provider_text_missing_or_too_long');
    const completed = Date.now();
    const randomUnit = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    const target = config.ms_per_character * Array.from(reply).length + config.random_min_ms + randomUnit * (config.random_max_ms - config.random_min_ms);
    const due = Math.max(completed, Math.ceil(job.created_ms + target));
    await statement(db, `UPDATE ai_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM sessions WHERE id=ai_jobs.session_id AND status='active') THEN 'ready' ELSE 'cancelled' END,
      generation_completed_ms=?,ready_after_ms=?,target_latency_ms=?,reply_text=?,actual_model=?,response_id=?,usage_json=?,lease_until_ms=NULL
      WHERE id=? AND state='generating' AND lock_token=?`, completed, due, target, reply, result.model || config.model,
      result.id || null, JSON.stringify(result.usage || null), job.id, token).run();
  } catch (error) {
    const code = error.name === 'AbortError' ? 'provider_timeout' : (/^(provider_|missing_api_key)/.test(error.message) ? error.message : 'generation_or_storage_failed');
    await statement(db, "UPDATE ai_jobs SET state='error',error_code=?,lease_until_ms=NULL WHERE id=? AND state='generating' AND lock_token=?", code, job.id, token).run();
  } finally { clearTimeout(timeout); }
  await publishDueAi(db, session.id);
}
async function aiServiceNotice(db, sessionId) {
  const error = await statement(db, "SELECT id FROM ai_jobs WHERE session_id=? AND state='error' LIMIT 1", sessionId).first();
  return error ? 'Message delivery is delayed. Please contact the researcher.' : null;
}

// Recording is participant-authenticated and never included in interlocutor context.
const RECORDING_VERSION = 1;
const EVENT_TYPES = new Set(['page_start','page_resume','draft_start','draft_resume','keydown','beforeinput','input','selection','compositionstart','compositionupdate','compositionend','focus','blur','visibility','page_focus','page_blur','message_display','message_visible','send_attempt','send_ack','send_failed','programmatic_clear','draft_unsent','page_end','pagehide','resume_gap']);
const idField = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail(400, 'Invalid ' + label + '.');
  return value;
};
function numberField(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) fail(400, 'Invalid ' + label + '.');
  return value;
}
function rawText(value, label) {
  if (typeof value !== 'string' || value.length > 10000) fail(400, 'Invalid ' + label + '.');
  return value;
}
async function recordingEnabled(db) {
  return (await statement(db, "SELECT value FROM schema_meta WHERE name='schema_version'").first())?.value === '3';
}
async function requireRecording(db) {
  if (!await recordingEnabled(db)) fail(503, 'Typing recording is not ready. Please contact the researcher.');
}
function validatePage(page) {
  if (!page || typeof page !== 'object') fail(400, 'Missing recording page.');
  return {
    page_id: idField(page.page_id, 'page_id'),
    time_origin_ms: numberField(page.time_origin_ms, 'time_origin_ms'),
    started_wall_ms: numberField(page.started_wall_ms, 'started_wall_ms'),
    declared_seq: numberField(page.declared_seq, 'declared_seq', true),
    closed: page.closed === true
  };
}
function validateDraft(draft, pageId) {
  if (!draft || typeof draft !== 'object') fail(400, 'Invalid draft.');
  if (!['editing','pending','sent','unsent'].includes(draft.state)) fail(400, 'Invalid draft state.');
  return {
    draft_id: idField(draft.draft_id, 'draft_id'),
    client_message_id: idField(draft.client_message_id, 'client_message_id'),
    revision: numberField(draft.revision, 'revision', true),
    text: rawText(draft.text, 'draft text'), state: draft.state,
    raw_at_send: draft.raw_at_send == null ? null : rawText(draft.raw_at_send, 'raw_at_send'),
    last_page_id: idField(draft.last_page_id || pageId, 'last_page_id'),
    last_seq: numberField(draft.last_seq, 'last_seq', true)
  };
}
function pageStatement(db, sessionId, page, now) {
  return statement(db, `INSERT INTO recording_pages(session_id,page_id,time_origin_ms,started_wall_ms,declared_seq,closed,created_ms,updated_ms)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id,page_id) DO UPDATE SET
    declared_seq=MAX(recording_pages.declared_seq,excluded.declared_seq),closed=MAX(recording_pages.closed,excluded.closed),updated_ms=excluded.updated_ms`,
    sessionId, page.page_id, page.time_origin_ms, page.started_wall_ms, page.declared_seq, Number(page.closed), now, now);
}
function draftStatement(db, sessionId, draft, now) {
  return statement(db, `INSERT INTO drafts(session_id,draft_id,client_message_id,revision,text,state,raw_at_send,last_page_id,last_seq,created_ms,updated_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,draft_id) DO UPDATE SET
    revision=excluded.revision,text=excluded.text,
    state=CASE WHEN drafts.message_id IS NOT NULL THEN 'sent' ELSE excluded.state END,
    raw_at_send=COALESCE(drafts.raw_at_send,excluded.raw_at_send),last_page_id=excluded.last_page_id,last_seq=excluded.last_seq,updated_ms=excluded.updated_ms
    WHERE excluded.revision>drafts.revision AND drafts.client_message_id=excluded.client_message_id`,
    sessionId, draft.draft_id, draft.client_message_id, draft.revision, draft.text, draft.state,
    draft.raw_at_send, draft.last_page_id, draft.last_seq, now, now);
}
async function checkRecordingIdentity(db, sessionId, pages, drafts) {
  const oldPages = (await statement(db, 'SELECT * FROM recording_pages WHERE session_id=? AND page_id IN (SELECT value FROM json_each(?))', sessionId, JSON.stringify(pages.map(p => p.page_id))).all()).results;
  for (const old of oldPages) {
    const incoming = pages.find(page => page.page_id === old.page_id);
    if (old.time_origin_ms !== incoming.time_origin_ms || old.started_wall_ms !== incoming.started_wall_ms) fail(409, 'Recording page identifier conflict.');
  }
  if (!drafts.length) return;
  const existing = (await statement(db, 'SELECT * FROM drafts WHERE session_id=? AND (draft_id IN (SELECT value FROM json_each(?)) OR client_message_id IN (SELECT value FROM json_each(?)))',
    sessionId, JSON.stringify(drafts.map(d => d.draft_id)), JSON.stringify(drafts.map(d => d.client_message_id))).all()).results;
  for (const old of existing) {
    const incoming = drafts.find(draft => draft.draft_id === old.draft_id || draft.client_message_id === old.client_message_id);
    if (old.draft_id !== incoming.draft_id || old.client_message_id !== incoming.client_message_id) fail(409, 'Draft identifier conflict.');
    if (old.revision === incoming.revision && (old.text !== incoming.text || old.last_page_id !== incoming.last_page_id || old.last_seq !== incoming.last_seq)) fail(409, 'Draft revision conflict.');
  }
}
function resolveDraftsStatement(db, sessionId) {
  return statement(db, `UPDATE drafts SET message_id=(SELECT id FROM messages WHERE session_id=drafts.session_id AND sender='participant' AND client_message_id=drafts.client_message_id),
    raw_at_send=COALESCE(raw_at_send,(SELECT json_extract(payload_json,'$.payload.raw_text') FROM interaction_events WHERE session_id=drafts.session_id AND draft_id=drafts.draft_id AND event_type='send_attempt' ORDER BY rowid LIMIT 1)),
    state=CASE WHEN EXISTS(SELECT 1 FROM messages WHERE session_id=drafts.session_id AND sender='participant' AND client_message_id=drafts.client_message_id) THEN 'sent'
    WHEN EXISTS(SELECT 1 FROM sessions WHERE id=drafts.session_id AND status='ended') THEN 'unsent' ELSE state END WHERE session_id=? AND (message_id IS NULL OR raw_at_send IS NULL)`, sessionId);
}
async function ingestRecording(db, session, body) {
  await requireRecording(db);
  if (session.status === 'ready') fail(409, 'The conversation has not started.');
  if (body.recording_version !== RECORDING_VERSION) fail(400, 'Unsupported recording format.');
  const page = validatePage(body.page);
  if (!Array.isArray(body.events) || body.events.length > 25 || !Array.isArray(body.drafts) || body.drafts.length > 25) fail(400, 'Invalid recording batch.');
  const drafts = body.drafts.map(draft => validateDraft(draft, page.page_id));
  if (new Set(drafts.map(d => d.draft_id)).size !== drafts.length || new Set(drafts.map(d => d.client_message_id)).size !== drafts.length) fail(400, 'Duplicate draft in batch.');
  let previousSeq = 0;
  const events = body.events.map(event => {
    if (!event || !EVENT_TYPES.has(event.event_type)) fail(400, 'Invalid recording event.');
    const seq = numberField(event.seq, 'event sequence', true);
    if (seq <= previousSeq || seq > page.declared_seq) fail(400, 'Invalid recording sequence.');
    previousSeq = seq;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Invalid event payload.');
    for (const key of ['text_before','text_after','text','raw_text']) if (key in payload) rawText(payload[key], key);
    for (const key of ['selection_before','selection_after']) if (key in payload) {
      const range = payload[key];
      if (!Array.isArray(range) || range.length !== 2 || range.some(v => !Number.isSafeInteger(v) || v < 0 || v > 10000) || range[0] > range[1]) fail(400, 'Invalid selection range.');
    }
    return { seq, draft_id: event.draft_id == null ? null : idField(event.draft_id,'draft_id'), event_type: event.event_type,
      client_elapsed_ms: numberField(event.client_elapsed_ms,'client_elapsed_ms'), client_wall_ms: numberField(event.client_wall_ms,'client_wall_ms'), payload };
  });
  const referenced = [...new Set(events.map(e => e.draft_id).filter(Boolean))];
  const known = (await statement(db, 'SELECT draft_id FROM drafts WHERE session_id=? AND draft_id IN (SELECT value FROM json_each(?))', session.id, JSON.stringify(referenced)).all()).results;
  if (referenced.some(id => !drafts.some(d => d.draft_id === id) && !known.some(d => d.draft_id === id))) fail(400, 'Unknown draft in recording event.');
  const displayIds = [...new Set(events.filter(e => ['message_display','message_visible'].includes(e.event_type)).map(e => e.payload.message_id))];
  if (displayIds.some(id => !Number.isSafeInteger(id) || id < 1)) fail(400, 'Invalid displayed message.');
  if (displayIds.length) {
    const count = await statement(db, 'SELECT COUNT(*) AS n FROM messages WHERE session_id=? AND id IN (SELECT value FROM json_each(?))', session.id, JSON.stringify(displayIds)).first();
    if (count.n !== displayIds.length) fail(403, 'Displayed message does not belong to this session.');
  }
  await checkRecordingIdentity(db, session.id, [page], drafts);
  const encoded = JSON.stringify(events);
  const conflict = await statement(db, `SELECT e.seq FROM json_each(?) j CROSS JOIN interaction_events e ON e.seq=json_extract(j.value,'$.seq')
    WHERE e.session_id=? AND e.page_id=? AND e.payload_json!=json(j.value) LIMIT 1`, encoded, session.id, page.page_id).first();
  if (conflict) fail(409, 'Recording event identifier conflict.');
  const now = Date.now();
  await db.batch([
    pageStatement(db, session.id, page, now),
    ...drafts.map(draft => draftStatement(db, session.id, draft, now)),
    statement(db, `INSERT OR IGNORE INTO interaction_events(session_id,page_id,seq,draft_id,event_type,client_elapsed_ms,client_wall_ms,payload_json,received_ms,received_after_end)
      SELECT ?,?,json_extract(value,'$.seq'),json_extract(value,'$.draft_id'),json_extract(value,'$.event_type'),json_extract(value,'$.client_elapsed_ms'),json_extract(value,'$.client_wall_ms'),json(value),?,
      CASE WHEN EXISTS(SELECT 1 FROM sessions WHERE id=? AND status='ended') THEN 1 ELSE 0 END FROM json_each(?)`, session.id, page.page_id, now, session.id, encoded),
    resolveDraftsStatement(db, session.id)
  ]);
  const racedConflict = await statement(db, `SELECT e.seq FROM json_each(?) j CROSS JOIN interaction_events e ON e.seq=json_extract(j.value,'$.seq')
    WHERE e.session_id=? AND e.page_id=? AND e.payload_json!=json(j.value) LIMIT 1`, encoded, session.id, page.page_id).first();
  if (racedConflict) fail(409, 'Recording event identifier conflict.');
  return { accepted_sequences: events.map(event => event.seq), page_id: page.page_id, server_received_ms: now };
}
async function recordingSummary(db, sessionId) {
  if (!await recordingEnabled(db)) return { enabled:false, pages:[], event_count:0, drafts:0, messages_without_draft:0 };
  const pages = (await statement(db, `SELECT p.*,COUNT(e.seq) AS event_count,COALESCE(MAX(e.seq),0) AS received_max_seq
    FROM recording_pages p LEFT JOIN interaction_events e ON e.session_id=p.session_id AND e.page_id=p.page_id WHERE p.session_id=? GROUP BY p.session_id,p.page_id ORDER BY p.created_ms,p.page_id`, sessionId).all()).results;
  const drafts = await statement(db, 'SELECT COUNT(*) AS n FROM drafts WHERE session_id=?', sessionId).first();
  const unlinked = await statement(db, "SELECT COUNT(*) AS n FROM messages m WHERE session_id=? AND sender='participant' AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.message_id=m.id)", sessionId).first();
  return { enabled:true, pages:pages.map(page => ({...page, missing_events:Math.max(0,page.declared_seq-page.event_count), acknowledged_tail_complete:page.closed===1 && page.event_count===page.declared_seq })),
    event_count:pages.reduce((n,page)=>n+page.event_count,0),drafts:drafts.n,messages_without_draft:unlinked.n };
}

async function api(request, env, body) {
  const db = env.DB;
  const action = typeof body.action === 'string' ? body.action : '';
  if (action.startsWith('admin_')) {
    await adminAuth(request, env);
    await ready(db);
    if (action === 'admin_state') {
      const result = await statement(db, 'SELECT id,participant_code,task_number,condition,scenario_code,status,created_ms,started_ms,ended_ms,end_reason FROM sessions ORDER BY created_ms DESC,participant_code,task_number').all();
      const config = await aiConfig(db, env);
      return { recording_enabled: await recordingEnabled(db), sessions: result.results, version: VERSION, ai_enabled: aiConfigured(env, config), ai_config: config, api_key_configured: Boolean(env.OPENAI_API_KEY) };
    }
    if (action === 'admin_save_ai') {
      const config = validateAiConfig(body.config || {}, env.OPENAI_MODEL);
      await statement(db, "INSERT INTO app_settings(name,value) VALUES('ai_config',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", JSON.stringify(config)).run();
      return { ai_config: config, ai_enabled: aiConfigured(env, config), api_key_configured: Boolean(env.OPENAI_API_KEY) };
    }
    if (action === 'admin_create') return createParticipant(db, body);
    if (action === 'admin_recording_export') {
      await requireRecording(db);
      const code = codeField(body.participant_code);
      const cursor = numberField(body.after_event_row ?? 0, 'event cursor', true);
      const upper = numberField(body.through_event_row ?? Number.MAX_SAFE_INTEGER, 'event upper bound', true);
      const rows = (await statement(db, `SELECT e.rowid AS event_row,e.* FROM interaction_events e JOIN sessions s ON s.id=e.session_id
        WHERE s.participant_code=? AND e.rowid>? AND e.rowid<=? ORDER BY e.rowid LIMIT 101`, code,cursor,upper).all()).results;
      const events = rows.slice(0,100).map(({payload_json,...event}) => ({...event,...JSON.parse(payload_json)}));
      return { events, next_cursor: events.at(-1)?.event_row ?? cursor, has_more: rows.length>100 };
    }
    if (action === 'admin_export') {
      const code = codeField(body.participant_code);
      const sessions = (await statement(db, 'SELECT * FROM sessions WHERE participant_code=? ORDER BY task_number', code).all()).results;
      if (!sessions.length) fail(404, 'Participant not found.');
      const messages = (await statement(db, 'SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.participant_code=? ORDER BY m.id', code).all()).results;
      const ai_jobs = (await statement(db, 'SELECT j.* FROM ai_jobs j JOIN sessions s ON s.id=j.session_id WHERE s.participant_code=? ORDER BY j.trigger_message_id', code).all()).results;
      const ai_configs = (await statement(db, 'SELECT c.* FROM ai_session_configs c JOIN sessions s ON s.id=c.session_id WHERE s.participant_code=?', code).all()).results;
      let recording = { enabled:false, pages:[], drafts:[], summaries:[] };
      if (await recordingEnabled(db)) {
        const pages = (await statement(db,'SELECT p.* FROM recording_pages p JOIN sessions s ON s.id=p.session_id WHERE s.participant_code=? ORDER BY p.created_ms,p.page_id',code).all()).results;
        const drafts = (await statement(db,'SELECT d.* FROM drafts d JOIN sessions s ON s.id=d.session_id WHERE s.participant_code=? ORDER BY d.created_ms,d.draft_id',code).all()).results;
        const summaries = [];
        for (const session of sessions) summaries.push({session_id:session.id,...await recordingSummary(db,session.id)});
        const upper = await statement(db,'SELECT COALESCE(MAX(e.rowid),0) AS n FROM interaction_events e JOIN sessions s ON s.id=e.session_id WHERE s.participant_code=?',code).first();
        recording = {enabled:true,pages,drafts,summaries,events_upper_row:upper.n,exported_while_active:sessions.some(session=>session.status==='active')};
      }
      return { format_version: 3, platform_version: VERSION, exported_ms: Date.now(), participant_code: code, sessions, messages, ai_jobs, ai_configs, draft_events_implemented: recording.enabled, recording };
    }
    const session = await findSession(db, body.session_id);
    if (action === 'admin_session') {
      const ai_jobs = (await statement(db, 'SELECT id,state,trigger_message_id,error_code,attempt,generation_started_ms,generation_completed_ms,ready_after_ms,delivered_ms FROM ai_jobs WHERE session_id=? ORDER BY trigger_message_id', session.id).all()).results;
      return { session, messages: await readMessages(db, session.id, body.after_id ?? 0, true), ai_jobs, ...(body.include_recording === true ? {recording:await recordingSummary(db,session.id)} : {}) };
    }
    if (action === 'admin_retry_ai') {
      if (session.condition !== 'ai' || session.status !== 'active') fail(409, 'No active AI session selected.');
      await statement(db, "UPDATE ai_jobs SET state='queued',lock_token=NULL,lease_until_ms=NULL,error_code=NULL WHERE session_id=? AND (state='error' OR (state='generating' AND lease_until_ms<=?))", session.id, Date.now()).run();
      return { retried: true };
    }
    if (action === 'admin_send') return sendMessage(db, session, 'interlocutor', body);
    if (action === 'admin_end') return endSession(db, session, 'researcher');
    fail(400, 'Unknown researcher action.');
  }
  await ready(db);
  const code = await participantAuth(db, body);
  if (action === 'participant_join') {
    const session = await nextSession(db, code);
    return { participant_code: code, session: publicSession(session), complete: !session, recording_enabled:await recordingEnabled(db), recording_version:RECORDING_VERSION };
  }
  const session = await ownedSession(db, code, body.session_id);
  if (action === 'participant_events') return ingestRecording(db,session,body);
  if (action === 'participant_session') {
    await processAi(db, session, env);
    return { session: publicSession(await findSession(db, session.id)), messages: await readMessages(db, session.id, body.after_id ?? 0), service_notice: await aiServiceNotice(db, session.id) };
  }
  if (action === 'participant_start') {
    const next = await nextSession(db, code);
    if (next?.id !== session.id) fail(409, 'Please complete the preceding task first.');
    // Do not reveal condition identity to the participant, even in errors.
    if (session.condition === 'ai') {
      if (!env.OPENAI_API_KEY) fail(503, 'This task is not available yet. Please contact the researcher.');
      await sessionAiConfig(db, session, env);
    }
    await statement(db, "UPDATE sessions SET status='active',started_ms=? WHERE id=? AND status='ready'", Date.now(), session.id).run();
    return { session: publicSession(await findSession(db, session.id)) };
  }
  if (action === 'participant_send') {
    const result = await sendMessage(db, session, 'participant', body);
    if (session.condition === 'ai') await queueAi(db, session, result.message);
    const { client_message_id, ...message } = result.message;
    return { message };
  }
  if (action === 'participant_end') return endSession(db, session, 'participant');
  fail(400, 'Unknown participant action.');
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const origin = request.headers.get('Origin');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff'
    };
    if (origin === allowed) headers['Access-Control-Allow-Origin'] = origin;
    const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    try {
      if (origin && origin !== allowed) fail(403, 'Origin not allowed.');
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          ...headers, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600'
        } });
      }
      const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
      if (request.method === 'GET' && (path === '/health' || path === '/')) {
        await ready(env.DB);
        const config = await aiConfig(env.DB, env);
        return respond({ ok: true, service: 'slp-final', version: VERSION, database: 'ready', recording_enabled:await recordingEnabled(env.DB), ai_enabled: aiConfigured(env, config) });
      }
      if (path !== '/api' || request.method !== 'POST') fail(404, 'Endpoint not found.');
      if (!(request.headers.get('Content-Type') || '').includes('application/json')) fail(415, 'Use application/json.');
      const declared = Number(request.headers.get('Content-Length'));
      if (declared > MAX_BODY_BYTES) fail(413, 'Request body too large.');
      const reader = request.body?.getReader();
      if (!reader) fail(400, 'A JSON request body is required.');
      const chunks = []; let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) { await reader.cancel(); fail(413, 'Request body too large.'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); }
      catch (_) { fail(400, 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'A JSON object is required.');
      const limit = body.action === 'participant_events' || (body.action === 'participant_send' && body.logging) ? 262144 : 64000;
      if (length > limit) fail(413, 'Request body too large.');
      return respond({ ok: true, ...await api(request, env, body) });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('SLP request failed:', error.message);
      return respond({ ok: false, error: status === 500 ? 'Server error. Please contact the researcher.' : error.message }, status);
    }
  }
};
