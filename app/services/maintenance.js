// Maintenance jobs: the pruning
// that keeps the tables from growing for ever. Each task records one row in
// maintenance_runs, so the maintenance page can show when it last ran and how
// many rows it removed. The scheduler runs everything at start and every six
// hours; the page can run it by hand.
//
//   search log      rows older than SEARCH_LOG_RETENTION_DAYS; search_daily keeps the totals
//   audit log       entries older than AUDIT_RETENTION_DAYS (a year)
//   finished jobs   done jobs older than JOB_RETENTION_DAYS; failed jobs stay until dismissed

import { log, errorFields } from '../logger.js';
import { pruneAudit } from './audit.js';
import { pruneJobs } from './jobs.js';
import { pruneSearchLog } from './search-log.js';

const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RUN_HISTORY_DAYS = 365;

export const TASKS = [
  {
    key: 'search-log',
    label: 'Search log',
    rule: (config) => `Raw searches older than ${config.search.logRetentionDays} days. The daily totals stay.`,
    run: (pool, config) => pruneSearchLog(pool, config.search.logRetentionDays),
  },
  {
    key: 'audit',
    label: 'Audit log',
    rule: (config) => `Entries older than ${config.retention.auditDays} days.`,
    run: (pool, config) => pruneAudit(pool, config.retention.auditDays),
  },
  {
    key: 'jobs',
    label: 'Finished jobs',
    rule: (config) => `Done jobs older than ${config.worker.jobRetentionDays} days. Failed jobs stay until dismissed.`,
    run: (pool, config) => pruneJobs(pool, config.worker.jobRetentionDays),
  },
];

let inFlight = false;

async function recordRun(pool, { task, trigger, status, pruned, durationMs, message }) {
  try {
    await pool.query(
      `INSERT INTO maintenance_runs (task, trigger_source, status, rows_pruned, duration_ms, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [task, trigger, status, pruned, durationMs, message],
    );
  } catch (err) {
    log.error('maintenance run could not be recorded', { task, ...errorFields(err) });
  }
}

// Runs every task. trigger: 'schedule' or 'manual'. Never throws; a task that
// fails is recorded as failed and the others still run. Resolves to
// { busy: true } when a run is already going, else { busy: false, results }
// where results are { key, label, status, pruned, message }.
export async function runMaintenance(pool, config, { trigger }) {
  if (inFlight) return { busy: true, results: [] };
  inFlight = true;
  try {
    const results = [];
    for (const task of TASKS) {
      const started = Date.now();
      let outcome;
      try {
        const pruned = Number(await task.run(pool, config));
        outcome = { status: 'ok', pruned, message: null };
      } catch (err) {
        log.warn('maintenance task failed', { task: task.key, ...errorFields(err) });
        outcome = { status: 'failed', pruned: 0, message: `Failed${err.code ? ` (${err.code})` : ''}. See the server log.` };
      }
      await recordRun(pool, { task: task.key, trigger, durationMs: Date.now() - started, ...outcome });
      results.push({ key: task.key, label: task.label, ...outcome });
    }
    await pool
      .query('DELETE FROM maintenance_runs WHERE started_at < NOW() - INTERVAL ? DAY', [RUN_HISTORY_DAYS])
      .catch((err) => log.warn('maintenance history prune failed', errorFields(err)));
    return { busy: false, results };
  } finally {
    inFlight = false;
  }
}

// The latest run of each task: Map(task key -> { startedAt, status, pruned, trigger, message, durationMs }).
export async function lastRuns(pool) {
  const [rows] = await pool.query(
    `SELECT r.task, r.started_at, r.status, r.rows_pruned, r.trigger_source, r.message, r.duration_ms
       FROM maintenance_runs r
       JOIN (SELECT task, MAX(id) AS id FROM maintenance_runs GROUP BY task) latest ON latest.id = r.id`,
  );
  return new Map(
    rows.map((r) => [
      r.task,
      { startedAt: r.started_at, status: r.status, pruned: Number(r.rows_pruned), trigger: r.trigger_source, message: r.message ?? '', durationMs: r.duration_ms },
    ]),
  );
}

// The scheduled run, in the web process: at start, then every six hours.
export function createMaintenance({ pool, config }) {
  let timer = null;

  async function runScheduled() {
    try {
      const { results } = await runMaintenance(pool, config, { trigger: 'schedule' });
      const pruned = results.reduce((sum, r) => sum + r.pruned, 0);
      if (pruned > 0) log.info('maintenance pruned rows', { pruned });
    } catch (err) {
      log.warn('maintenance run failed', errorFields(err));
    }
  }

  return {
    start() {
      runScheduled();
      timer = setInterval(runScheduled, SCHEDULE_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
