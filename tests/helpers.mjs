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
export function setup() {
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

