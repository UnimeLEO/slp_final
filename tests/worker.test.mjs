import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/worker.mjs';

// Run the real SQL and Worker handler against SQLite. No Cloudflare credentials.
class D1Adapter {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const db = this.db;
    return { bind(...args) { return {
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: result }; }
    }; } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT'); return results;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
function setup() {
  const env = { DB: new D1Adapter(), ADMIN_SECRET: 'test-only-researcher-secret-123456789' };
  async function request(body, { admin = false, origin = 'https://unimeleo.github.io', auth, path = '/api', method = 'POST' } = {}) {
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    if (admin || auth) headers.Authorization = 'Bearer ' + (auth || env.ADMIN_SECRET);
    const response = await worker.fetch(new Request('https://worker.test' + path, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {})
    }), env);
    const data = response.status === 204 ? null : await response.json();
    return { response, data };
  }
  const scenarios = { A: { participant: 'Participant A', interlocutor: 'Hidden role A' }, B: { participant: 'Participant B', interlocutor: 'Hidden role B' } };
  async function create(code = 'TEST01', order = 0) {
    const result = await request({ action: 'admin_create', participant_code: code, order_index: order, scenarios }, { admin: true });
    assert.equal(result.response.status, 200);
    const credentials = { participant_code: code, access_code: result.data.access_code };
    return { credentials, participant: body => request({ ...credentials, ...body }), admin: body => request(body, { admin: true }) };
  }
  return { env, request, create };
}

test('health and CORS: correct origin only; missing DB fails clearly', async () => {
  const { env, request } = setup();
  const good = await request(null, { method: 'GET', path: '/health' });
  assert.equal(good.data.database, 'ready');
  assert.equal(good.response.headers.get('access-control-allow-origin'), 'https://unimeleo.github.io');
  const rejected = await request(null, { method: 'GET', path: '/health', origin: 'https://untrusted.example' });
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.response.headers.get('access-control-allow-origin'), null);
  const preflight = await request(null, { method: 'OPTIONS' });
  assert.equal(preflight.response.status, 204);
  const response = await worker.fetch(new Request('https://worker.test/health'), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
  env.DB.db.close();
});
test('researcher authentication is enforced for reads and writes', async () => {
  const { request } = setup();
  for (const action of ['admin_state', 'admin_create', 'admin_session', 'admin_export', 'admin_end', 'admin_send']) {
    assert.equal((await request({ action })).response.status, 401);
  }
  assert.equal((await request({ action: 'admin_state' }, { auth: 'wrong' })).response.status, 401);
});
test('participant access, hidden identity, owned session isolation', async () => {
  const { create, request } = setup();
  const first = await create();
  await create('TEST02');
  const joined = await first.participant({ action: 'participant_join' });
  assert.equal(joined.data.session.id, 'TEST01-T1');
  assert.equal(joined.data.session.participant_prompt, 'Participant A');
  for (const field of ['condition', 'scenario_code', 'interlocutor_prompt', 'access_hash', 'access_code']) assert.equal(field in joined.data.session, false);
  assert.equal((await request({ action: 'participant_join', participant_code: 'TEST01', access_code: 'wrong' })).response.status, 401);
  assert.equal((await first.participant({ action: 'participant_session', session_id: 'TEST02-T1' })).response.status, 403);
});
test('four orders are persisted correctly and creation is atomic', async () => {
  const { create, request, env } = setup();
  const expected = [['humanA', 'aiB'], ['aiA', 'humanB'], ['humanB', 'aiA'], ['aiB', 'humanA']];
  for (let i = 0; i < 4; i++) await create('P0' + (i + 1), i);
  const rows = (await request({ action: 'admin_state' }, { admin: true })).data.sessions;
  for (let i = 0; i < 4; i++) assert.deepEqual(rows.filter(s => s.participant_code === 'P0' + (i + 1)).sort((a, b) => a.task_number - b.task_number).map(s => s.condition + s.scenario_code), expected[i]);
  const duplicate = await request({ action: 'admin_create', participant_code: 'P01', order_index: 0 }, { admin: true });
  assert.equal(duplicate.response.status, 400); // missing materials cannot create partial records
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM participants').get().n, 4);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 8);
});
test('Human round trip, retries, multiline export and participant ending', async () => {
  const { create } = setup();
  const { participant, admin } = await create();
  assert.equal((await admin({ action: 'admin_send', session_id: 'TEST01-T1', client_message_id: 'early', text: 'before start' })).response.status, 409);
  const start = await participant({ action: 'participant_start', session_id: 'TEST01-T1' });
  const originalStart = start.data.session.started_ms;
  assert.equal((await participant({ action: 'participant_start', session_id: 'TEST01-T1' })).data.session.started_ms, originalStart);
  const payload = { action: 'participant_send', session_id: 'TEST01-T1', client_message_id: 'message-1', text: 'Could we talk?\nA, "quoted" line.' };
  const sent = await participant(payload);
  const retry = await participant(payload);
  assert.equal(sent.data.message.id, retry.data.message.id);
  assert.equal((await participant({ ...payload, text: 'different' })).response.status, 409);
  await admin({ action: 'admin_send', session_id: 'TEST01-T1', client_message_id: 'reply-1', text: 'Sure.' });
  const transcript = await participant({ action: 'participant_session', session_id: 'TEST01-T1' });
  assert.deepEqual(transcript.data.messages.map(m => m.sender), ['participant', 'interlocutor']);
  const last = transcript.data.messages.at(-1).id;
  assert.equal((await participant({ action: 'participant_session', session_id: 'TEST01-T1', after_id: last })).data.messages.length, 0);
  const ended = await participant({ action: 'participant_end', session_id: 'TEST01-T1' });
  assert.equal(ended.data.session.status, 'ended');
  assert.equal((await participant({ ...payload, client_message_id: 'new-after-end' })).response.status, 409);
  assert.equal((await participant(payload)).data.message.id, sent.data.message.id); // delivered retry remains idempotent after ending
  const exported = await admin({ action: 'admin_export', participant_code: 'TEST01' });
  assert.equal(exported.data.messages.length, 2);
  assert.equal(exported.data.messages[0].text, payload.text);
  assert.equal(exported.data.sessions[0].end_reason, 'ended_by_participant');
  assert.equal(JSON.stringify(exported.data).includes('access_hash'), false);
  assert.equal(JSON.stringify(exported.data).includes('access_code'), false);
});
test('researcher termination survives retries and task sequence cannot be skipped', async () => {
  const { create } = setup();
  const { participant, admin } = await create();
  assert.equal((await participant({ action: 'participant_start', session_id: 'TEST01-T2' })).response.status, 409);
  await participant({ action: 'participant_start', session_id: 'TEST01-T1' });
  const first = await admin({ action: 'admin_end', session_id: 'TEST01-T1' });
  const second = await admin({ action: 'admin_end', session_id: 'TEST01-T1' });
  assert.equal(first.data.session.ended_ms, second.data.session.ended_ms);
  const joined = await participant({ action: 'participant_join' });
  assert.equal(joined.data.session.id, 'TEST01-T2');
  const notYet = await participant({ action: 'participant_start', session_id: 'TEST01-T2' });
  assert.equal(notYet.response.status, 503);
  assert.equal(/\bAI\b|human|model/i.test(notYet.data.error), false);
  await admin({ action: 'admin_end', session_id: 'TEST01-T2' });
  assert.equal((await participant({ action: 'participant_join' })).data.complete, true);
});
test('invalid messages, cursors, malformed JSON and oversized requests are rejected', async () => {
  const { request, create, env } = setup();
  const { participant } = await create();
  await participant({ action: 'participant_start', session_id: 'TEST01-T1' });
  for (const text of ['', '   ', 'x'.repeat(10001)]) assert.equal((await participant({ action: 'participant_send', session_id: 'TEST01-T1', client_message_id: 'bad', text })).response.status, 400);
  assert.equal((await participant({ action: 'participant_session', session_id: 'TEST01-T1', after_id: -1 })).response.status, 400);
  const malformed = await worker.fetch(new Request('https://worker.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), env);
  assert.equal(malformed.status, 400);
  assert.equal((await request({ action: 'admin_state', padding: 'x'.repeat(65000) }, { admin: true })).response.status, 413);
});
