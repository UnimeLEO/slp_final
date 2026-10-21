// SLP v0.1.0 — Human chat milestone. No external dependencies.
// Bind a dedicated D1 database as DB, set ADMIN_SECRET (Secret, >=20 characters).
// Optional ALLOWED_ORIGIN (Text) defaults to this project's GitHub Pages origin.
const VERSION = '0.1.0';
const DEFAULT_ORIGIN = 'https://unimeleo.github.io';
const MAX_BODY_BYTES = 64000;

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
  if (!/^[A-Z][A-Z0-9_-]{1,19}$/.test(code)) fail(400, 'Invalid participant code.');
  return code;
}

async function ready(db) {
  if (!db) fail(503, 'D1 binding DB is missing.');
  try {
    const row = await statement(db, "SELECT value FROM schema_meta WHERE name='schema_version'").first();
    if (row?.value !== '1') fail(503, 'Run the SLP schema.sql in the bound database.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(503, 'D1 schema is not ready. Run schema.sql in the bound database.');
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
async function readMessages(db, sessionId, afterId = 0) {
  const cursor = Number(afterId);
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail(400, 'Invalid message cursor.');
  const result = await statement(db, 'SELECT id,sender,client_message_id,text,server_received_ms,client_elapsed_ms FROM messages WHERE session_id=? AND id>? ORDER BY id LIMIT 500', sessionId, cursor).all();
  return result.results;
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
  // The SQL status guard makes sending versus ending safe under concurrent requests.
  await statement(db, `INSERT OR IGNORE INTO messages(session_id,sender,client_message_id,text,server_received_ms,client_elapsed_ms)
    SELECT ?,?,?,?,?,? FROM sessions WHERE id=? AND status='active'`,
    session.id, sender, clientId, message, Date.now(), elapsed, session.id).run();
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
  return { session: publicSession(await findSession(db, session.id)) };
}

async function api(request, env, body) {
  const db = env.DB;
  const action = typeof body.action === 'string' ? body.action : '';
  if (action.startsWith('admin_')) {
    await adminAuth(request, env);
    await ready(db);
    if (action === 'admin_state') {
      const result = await statement(db, 'SELECT id,participant_code,task_number,condition,scenario_code,status,created_ms,started_ms,ended_ms,end_reason FROM sessions ORDER BY created_ms DESC,participant_code,task_number').all();
      return { sessions: result.results, version: VERSION, ai_enabled: false };
    }
    if (action === 'admin_create') return createParticipant(db, body);
    if (action === 'admin_export') {
      const code = codeField(body.participant_code);
      const sessions = (await statement(db, 'SELECT * FROM sessions WHERE participant_code=? ORDER BY task_number', code).all()).results;
      if (!sessions.length) fail(404, 'Participant not found.');
      const messages = (await statement(db, 'SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.participant_code=? ORDER BY m.id', code).all()).results;
      return { format_version: 1, platform_version: VERSION, exported_ms: Date.now(), participant_code: code, sessions, messages, draft_events_implemented: false };
    }
    const session = await findSession(db, body.session_id);
    if (action === 'admin_session') return { session, messages: await readMessages(db, session.id, body.after_id ?? 0) };
    if (action === 'admin_send') return sendMessage(db, session, 'interlocutor', body);
    if (action === 'admin_end') return endSession(db, session, 'researcher');
    fail(400, 'Unknown researcher action.');
  }
  await ready(db);
  const code = await participantAuth(db, body);
  if (action === 'participant_join') {
    const session = await nextSession(db, code);
    return { participant_code: code, session: publicSession(session), complete: !session };
  }
  const session = await ownedSession(db, code, body.session_id);
  if (action === 'participant_session') return { session: publicSession(session), messages: await readMessages(db, session.id, body.after_id ?? 0) };
  if (action === 'participant_start') {
    const next = await nextSession(db, code);
    if (next?.id !== session.id) fail(409, 'Please complete the preceding task first.');
    // Do not reveal condition identity to the participant, even in errors.
    if (session.condition !== 'human') fail(503, 'This task is not available yet. Please contact the researcher.');
    await statement(db, "UPDATE sessions SET status='active',started_ms=? WHERE id=? AND status='ready'", Date.now(), session.id).run();
    return { session: publicSession(await findSession(db, session.id)) };
  }
  if (action === 'participant_send') return sendMessage(db, session, 'participant', body);
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
        return respond({ ok: true, service: 'slp-final', version: VERSION, database: 'ready', ai_enabled: false });
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
      return respond({ ok: true, ...await api(request, env, body) });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('SLP request failed:', error.message);
      return respond({ ok: false, error: status === 500 ? 'Server error. Please contact the researcher.' : error.message }, status);
    }
  }
};
