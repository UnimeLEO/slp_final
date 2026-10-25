import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/worker.mjs';

import { setup } from './helpers.mjs';

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
  assert.match(joined.data.session.participant_prompt, /make-up exam/);
  for (const field of ['condition', 'scenario_code', 'interlocutor_prompt', 'access_hash', 'access_code']) assert.equal(field in joined.data.session, false);
  assert.equal((await request({ action: 'participant_join', participant_code: 'TEST01', access_code: 'wrong' })).response.status, 401);
  assert.equal((await first.participant({ action: 'participant_session', session_id: 'TEST02-T1' })).response.status, 403);
});
test('numeric codes retain leading zeros through creation, login, chat, export and ending', async () => {
  const { create, request } = setup();
  const { participant, admin } = await create('01');
  const other = await create('02');
  await create('TEST01'); // Existing alphanumeric codes remain valid.
  const joined = await participant({ action: 'participant_join' });
  assert.equal(joined.data.participant_code, '01');
  assert.equal(joined.data.session.id, '01-T1');
  assert.equal((await other.participant({ action: 'participant_session', session_id: '01-T1' })).response.status, 403);
  await participant({ action: 'participant_start', session_id: '01-T1' });
  await participant({ action: 'participant_send', session_id: '01-T1', client_message_id: 'numeric-chat', text: 'Hi!' });
  await admin({ action: 'admin_send', session_id: '01-T1', client_message_id: 'reply', text: 'Hello!' });
  const exported = await admin({ action: 'admin_export', participant_code: '01' });
  assert.equal(exported.data.participant_code, '01');
  assert.deepEqual(exported.data.sessions.map(session => session.id), ['01-T1', '01-T2']);
  assert.equal(exported.data.messages.length, 2);
  assert.equal((await participant({ action: 'participant_end', session_id: '01-T1' })).data.session.status, 'ended');
  assert.equal((await participant({ action: 'participant_join' })).data.session.id, '01-T2');
  for (const code of ['1', '-01', '_01', '0 1', '<01>']) {
    assert.equal((await request({ action: 'participant_join', participant_code: code, access_code: 'wrong' })).response.status, 400);
  }
});
test('four formal-task orders are persisted correctly and creation is atomic', async () => {
  const { create, request, env } = setup();
  const expected = [['humanA', 'aiB'], ['aiA', 'humanB'], ['humanB', 'aiA'], ['aiB', 'humanA']];
  for (let i = 0; i < 4; i++) await create('P0' + (i + 1), i);
  const rows = (await request({ action: 'admin_state' }, { admin: true })).data.sessions;
  for (let i = 0; i < 4; i++) assert.deepEqual(rows.filter(s => s.participant_code === 'P0' + (i + 1)).sort((a, b) => a.task_number - b.task_number).map(s => s.condition + s.scenario_code), expected[i]);
  const duplicate = await request({ action: 'admin_create', participant_code: 'P01', order_index: 0 }, { admin: true });
  assert.equal(duplicate.response.status, 409);
  const invalid = await request({ action: 'admin_create', participant_code: 'P05', order_index: 9 }, { admin: true });
  assert.equal(invalid.response.status, 400);
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

test('AI settings require researcher auth and reject invalid delay ranges', async () => {
  const { request, env } = setup();
  assert.equal((await request({ action: 'admin_save_ai', config: {} })).response.status, 401);
  assert.equal((await request({ action: 'admin_save_ai', config: { random_min_ms: 100, random_max_ms: 10 } }, { admin: true })).response.status, 400);
  env.OPENAI_API_KEY = 'test-provider-key-not-a-real-key';
  env.OPENAI_MODEL = 'test-model';
  const saved = await request({ action: 'admin_save_ai', config: { model: 'test-model', ms_per_character: 0, random_min_ms: 0, random_max_ms: 0, api_key: 'must-not-save' } }, { admin: true });
  assert.equal(saved.data.ai_enabled, true);
  assert.equal('api_key' in saved.data.ai_config, false);
  const health = await request(null, { method: 'GET', path: '/health' });
  assert.equal(health.data.ai_enabled, true);
  assert.equal(JSON.stringify(health.data).includes(env.OPENAI_API_KEY), false);
});

function completion(text = 'Could we find another arrangement?') {
  return new Response(JSON.stringify({
    id: 'test-response-id', status: 'completed', model: 'test-model-snapshot',
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
async function aiSetup({ delay = 0, code = 'AI01' } = {}) {
  const fixture = setup();
  fixture.env.OPENAI_API_KEY = 'test-provider-key-not-a-real-key';
  fixture.env.OPENAI_MODEL = 'test-model';
  await fixture.request({ action: 'admin_save_ai', config: { model: 'test-model', ms_per_character: 0, random_min_ms: delay, random_max_ms: delay } }, { admin: true });
  const clients = await fixture.create(code, 1);
  const session_id = code + '-T1';
  assert.equal((await clients.participant({ action: 'participant_start', session_id })).data.session.status, 'active');
  return { ...fixture, ...clients, session_id };
}

test('AI generation preserves role input, configuration snapshots, usage and hidden identity', async t => {
  const fixture = await aiSetup();
  const { participant, admin, request, session_id, env } = fixture;
  let calls = 0, payload;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer ' + env.OPENAI_API_KEY);
    payload = JSON.parse(init.body); return completion();
  });
  // Updating global settings after Start must not change this task's snapshot.
  await request({ action: 'admin_save_ai', config: { model: 'different-model', ms_per_character: 0, random_min_ms: 0, random_max_ms: 0 } }, { admin: true });
  const send = { action: 'participant_send', session_id, client_message_id: 'ai-input-1', text: 'Can we change the arrangement?' };
  await participant(send); await participant(send);
  const result = await participant({ action: 'participant_session', session_id });
  assert.equal(calls, 1);
  assert.equal(payload.model, 'test-model');
  assert.equal(payload.store, false);
  assert.match(payload.instructions, /non-refundable deposit/);
  assert.doesNotMatch(payload.instructions, /make-up exam/); // Robin's private task card is not disclosed to Jimmy.
  const monitored = await admin({ action: 'admin_session', session_id });
  assert.equal(payload.instructions, monitored.data.session.interlocutor_prompt);
  assert.deepEqual(payload.input, [{ role: 'user', content: send.text }]);
  assert.deepEqual(result.data.messages.map(m => m.sender), ['participant', 'interlocutor']);
  assert.equal(result.data.messages.at(-1).text, 'Could we find another arrangement?');
  assert.equal('condition' in result.data.session, false);
  for (const message of result.data.messages) assert.equal('client_message_id' in message, false);
  await participant({ action: 'participant_session', session_id });
  assert.equal(calls, 1);
  const exported = await admin({ action: 'admin_export', participant_code: 'AI01' });
  assert.equal(exported.data.ai_jobs.length, 1);
  assert.equal(exported.data.ai_jobs[0].actual_model, 'test-model-snapshot');
  assert.equal(exported.data.ai_jobs[0].state, 'delivered');
  assert.equal(JSON.parse(exported.data.ai_jobs[0].usage_json).total_tokens, 30);
  assert.equal(JSON.stringify(exported.data).includes(env.OPENAI_API_KEY), false);
});

test('target delay is persisted, releases only at deadline, and does not regenerate', async t => {
  let clock = 1000000;
  t.mock.method(Date, 'now', () => clock);
  const { participant, admin, session_id } = await aiSetup({ delay: 5000 });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; clock += 2000; return completion('Not at that time.'); });
  await participant({ action: 'participant_send', session_id, client_message_id: 'delayed', text: 'Could we meet later?' });
  const first = await participant({ action: 'participant_session', session_id });
  assert.equal(first.data.messages.length, 1);
  let snapshot = await admin({ action: 'admin_export', participant_code: 'AI01' });
  assert.equal(snapshot.data.ai_jobs[0].state, 'ready');
  assert.equal(snapshot.data.ai_jobs[0].ready_after_ms, 1005000);
  assert.equal(snapshot.data.ai_jobs[0].generation_completed_ms, 1002000);
  clock = 1004999;
  assert.equal((await participant({ action: 'participant_session', session_id })).data.messages.length, 1);
  clock = 1005000;
  assert.equal((await participant({ action: 'participant_session', session_id })).data.messages.length, 2);
  assert.equal(calls, 1);
  snapshot = await admin({ action: 'admin_export', participant_code: 'AI01' });
  assert.equal(snapshot.data.ai_jobs[0].delivered_ms, 1005000);
});

test('generation slower than target does not add the target wait again', async t => {
  let clock = 2000000;
  t.mock.method(Date, 'now', () => clock);
  const { participant, admin, session_id } = await aiSetup({ delay: 5000 });
  t.mock.method(globalThis, 'fetch', async () => { clock += 7000; return completion(); });
  await participant({ action: 'participant_send', session_id, client_message_id: 'slow-model', text: 'Could we discuss this?' });
  const data = await participant({ action: 'participant_session', session_id });
  assert.equal(data.data.messages.length, 2);
  const exported = await admin({ action: 'admin_export', participant_code: 'AI01' });
  assert.equal(exported.data.ai_jobs[0].ready_after_ms, 2007000);
  assert.equal(exported.data.ai_jobs[0].delivered_ms, 2007000);
});

test('queued participant messages are coalesced without duplicate AI calls', async t => {
  const { participant, admin, session_id } = await aiSetup();
  let calls = 0, input;
  t.mock.method(globalThis, 'fetch', async (_, init) => { calls++; input = JSON.parse(init.body).input; return completion(); });
  await participant({ action: 'participant_send', session_id, client_message_id: 'a', text: 'Hi.' });
  await participant({ action: 'participant_send', session_id, client_message_id: 'b', text: 'Can we discuss the presentation?' });
  const result = await participant({ action: 'participant_session', session_id });
  assert.equal(calls, 1); assert.equal(input.length, 2);
  assert.equal(result.data.messages.length, 3);
  const exported = await admin({ action: 'admin_export', participant_code: 'AI01' });
  assert.deepEqual(exported.data.ai_jobs.map(j => j.state), ['superseded', 'delivered']);
});

test('concurrent polls share a lease and ending cancels an in-flight reply', async t => {
  const { participant, admin, session_id } = await aiSetup();
  let release, started, calls = 0;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { calls++; started(); await gate; return completion('Should not be displayed.'); });
  await participant({ action: 'participant_send', session_id, client_message_id: 'in-flight', text: 'Hello.' });
  const firstPoll = participant({ action: 'participant_session', session_id });
  await providerStarted;
  const otherPoll = await participant({ action: 'participant_session', session_id });
  assert.equal(calls, 1); assert.equal(otherPoll.data.messages.length, 1);
  await admin({ action: 'admin_end', session_id });
  release();
  const ended = await firstPoll;
  assert.equal(ended.data.session.status, 'ended');
  assert.equal(ended.data.messages.length, 1);
  const exported = await admin({ action: 'admin_export', participant_code: 'AI01' });
  assert.equal(exported.data.ai_jobs[0].state, 'cancelled');
});

test('provider errors stay private and require an explicit researcher retry', async t => {
  const { participant, admin, session_id } = await aiSetup();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? new Response('provider error details', { status: 401 }) : completion('Could we try an online meeting?');
  });
  await participant({ action: 'participant_send', session_id, client_message_id: 'fail-once', text: 'Could we find another time?' });
  const first = await participant({ action: 'participant_session', session_id });
  assert.match(first.data.service_notice, /delivery is delayed/);
  assert.equal(/AI|provider|401|model/i.test(first.data.service_notice), false);
  await participant({ action: 'participant_session', session_id });
  assert.equal(calls, 1);
  const monitor = await admin({ action: 'admin_session', session_id });
  assert.equal(monitor.data.ai_jobs[0].error_code, 'provider_http_401');
  await admin({ action: 'admin_retry_ai', session_id });
  const result = await participant({ action: 'participant_session', session_id });
  assert.equal(calls, 2); assert.equal(result.data.messages.length, 2);
});

test('incomplete provider output is not delivered as a complete chat turn', async t => {
  const { participant, admin, session_id } = await aiSetup();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 'incomplete', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }] }), { status: 200 }));
  await participant({ action: 'participant_send', session_id, client_message_id: 'truncated', text: 'Hello.' });
  assert.equal((await participant({ action: 'participant_session', session_id })).data.messages.length, 1);
  assert.equal((await admin({ action: 'admin_session', session_id })).data.ai_jobs[0].error_code, 'provider_response_incomplete');
});

test('AI migration preserves existing v0.1.0 records and is safe to repeat', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const initial = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8').split('-- Additive migration')[0];
  db.exec(initial);
  db.exec("INSERT INTO participants VALUES('OLD01','existing-hash',1000)");
  db.exec("INSERT INTO sessions(id,participant_code,task_number,condition,scenario_code,participant_prompt,interlocutor_prompt,status,created_ms,started_ms) VALUES('OLD01-T1','OLD01',1,'human','A','Original participant instructions','Original role','active',1000,2000)");
  db.exec("INSERT INTO messages(session_id,sender,client_message_id,text,server_received_ms) VALUES('OLD01-T1','participant','old-message','Preserve this conversation.',3000)");
  const migration = readFileSync(new URL('../worker/migrations/002-ai.sql', import.meta.url), 'utf8');
  db.exec(migration); db.exec(migration);
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE name='schema_version'").get().value, '2');
  assert.equal(db.prepare('SELECT text FROM messages').get().text, 'Preserve this conversation.');
  assert.equal(db.prepare('SELECT participant_prompt FROM sessions').get().participant_prompt, 'Original participant instructions');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get().n, 0);
  db.close();
});
