// The maintenance job against a stub pool: which tables it prunes, with which
// limits, that it records each task, and that one failure does not stop the rest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMaintenance, TASKS } from '../app/services/maintenance.js';

const config = {
  search: { logRetentionDays: 90 },
  retention: { auditDays: 365 },
  worker: { jobRetentionDays: 30 },
};

function stubPool({ failOn = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (failOn && sql.includes(failOn)) throw Object.assign(new Error('boom'), { code: 'ER_LOCK_DEADLOCK' });
      if (/^\s*DELETE FROM (search_log|audit_log|jobs)/i.test(sql)) return [{ affectedRows: 7 }];
      return [{ affectedRows: 0 }];
    },
  };
}

test('prunes the search log, audit log and finished jobs with the configured limits', async () => {
  const pool = stubPool();
  const { busy, results } = await runMaintenance(pool, config, { trigger: 'manual' });
  assert.equal(busy, false);
  assert.deepEqual(results.map((r) => [r.key, r.status, r.pruned]), [['search-log', 'ok', 7], ['audit', 'ok', 7], ['jobs', 'ok', 7]]);

  const deletes = pool.queries.filter((q) => /^DELETE FROM (search_log|audit_log|jobs)/.test(q.sql));
  assert.deepEqual(deletes.map((q) => q.params), [[90], [365], [30]]);
  assert.ok(!pool.queries.some((q) => /search_daily/.test(q.sql)), 'the daily totals are never touched');
  assert.ok(deletes.find((q) => q.sql.startsWith('DELETE FROM jobs')).sql.includes("status = 'done'"), 'failed jobs stay');
});

test('each task is recorded with its trigger and count', async () => {
  const pool = stubPool();
  await runMaintenance(pool, config, { trigger: 'manual' });
  const inserts = pool.queries.filter((q) => q.sql.startsWith('INSERT INTO maintenance_runs'));
  assert.equal(inserts.length, TASKS.length);
  assert.deepEqual(inserts[0].params.slice(0, 4), ['search-log', 'manual', 'ok', 7]);
});

test('a failing task is recorded as failed and the others still run', async () => {
  const pool = stubPool({ failOn: 'DELETE FROM audit_log' });
  const { results } = await runMaintenance(pool, config, { trigger: 'schedule' });
  assert.deepEqual(results.map((r) => r.status), ['ok', 'failed', 'ok']);
  assert.match(results[1].message, /ER_LOCK_DEADLOCK/);
  assert.doesNotMatch(results[1].message, /boom/, 'driver messages stay in the log');
});

test('a second run while one is going is refused, not queued', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pool = {
    async query(sql) {
      if (sql.startsWith('DELETE FROM search_log')) await gate;
      return [{ affectedRows: 0 }];
    },
  };
  const first = runMaintenance(pool, config, { trigger: 'manual' });
  const second = await runMaintenance(pool, config, { trigger: 'manual' });
  assert.equal(second.busy, true);
  release();
  assert.equal((await first).busy, false);
});
