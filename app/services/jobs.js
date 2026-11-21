// The job queue (brainstorm 5.5): the `jobs` table and the few state changes the
// worker and the Jobs page make. Claiming is one conditional UPDATE, so a job is
// never run twice. `attempts` is counted when a job is claimed, which is also
// what makes a run interrupted by a crash count as an attempt.
//
// last_error is a short sentence for the admin. Callers never pass document text.

import { cleanLine } from './text.js';

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'];

const ERROR_MAX = 300;
const shortError = (message) => cleanLine(message).slice(0, ERROR_MAX) || null;

// On a connection (a transaction of the caller's), so a doc and its job appear together.
// Resolves to the new job's id.
export async function enqueueJob(conn, docId, type = 'ingest') {
  const [result] = await conn.query('INSERT INTO jobs (doc_id, type) VALUES (?, ?)', [docId, type]);
  return result.insertId;
}

// Two workers share the table: the AI worker takes every type but 'embed', the embed
// worker (Phase 11) only 'embed'. A constant fragment, never user input.
const typeScope = (embed) => (embed ? "type = 'embed'" : "type <> 'embed'");

// Takes the oldest job that is due, or resolves to null. Resolves to { id, docId, type, attempts }.
export async function claimNext(pool, { embed = false } = {}) {
  const [candidates] = await pool.query(`SELECT id FROM jobs WHERE status = 'queued' AND run_after <= NOW() AND ${typeScope(embed)} ORDER BY id LIMIT 1`);
  if (candidates.length === 0) return null;
  const [result] = await pool.query(
    "UPDATE jobs SET status = 'running', locked_at = NOW(), attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
    [candidates[0].id],
  );
  if (result.affectedRows === 0) return null;
  const [rows] = await pool.query('SELECT id, doc_id, type, attempts FROM jobs WHERE id = ?', [candidates[0].id]);
  return { id: rows[0].id, docId: rows[0].doc_id, type: rows[0].type, attempts: rows[0].attempts };
}

export async function markDone(pool, jobId) {
  await pool.query("UPDATE jobs SET status = 'done', last_error = NULL, locked_at = NULL, finished_at = NOW() WHERE id = ?", [jobId]);
}

export async function markFailed(pool, jobId, message) {
  await pool.query(
    "UPDATE jobs SET status = 'failed', last_error = ?, locked_at = NULL, finished_at = NOW() WHERE id = ?",
    [shortError(message), jobId],
  );
}

// Back to the queue after a failed attempt, to run again after delayMs.
export async function requeue(pool, jobId, { delayMs = 0, message = null } = {}) {
  await pool.query(
    "UPDATE jobs SET status = 'queued', last_error = ?, locked_at = NULL, run_after = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?",
    [shortError(message), Math.ceil(delayMs / 1000), jobId],
  );
}

// Back to the queue without using up an attempt: the cap was reached or the app
// is shutting down, which says nothing about the job.
export async function release(pool, jobId, message = null) {
  await pool.query(
    "UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts, 1) - 1, last_error = ?, locked_at = NULL WHERE id = ?",
    [shortError(message), jobId],
  );
}

// At startup, jobs left "running" by a crash go back to the queue. The interrupted
// run already counted as an attempt, so one that has used them all is failed.
// Resolves to { requeued, failed }.
export async function recoverRunning(pool, maxAttempts, { embed = false } = {}) {
  const scope = typeScope(embed);
  const [exhausted] = await pool.query(`SELECT id, doc_id, type FROM jobs WHERE status = 'running' AND attempts >= ? AND ${scope}`, [maxAttempts]);
  for (const { id, doc_id: docId, type } of exhausted) {
    await markFailed(pool, id, 'The app restarted during every attempt.');
    // An embed job has no document state to undo; the doc's vector is simply not there yet.
    if (type === 'embed') continue;
    // A replace job's doc stays live; only its staged version failed.
    if (type === 'replace') await pool.query("UPDATE docs SET staged_status = 'failed' WHERE id = ? AND staged_status = 'processing'", [docId]);
    else if (type === 'edit') await pool.query("UPDATE edit_batch_docs SET status = 'failed', message = ? WHERE job_id = ? AND status IN ('queued', 'running')", ['The app restarted during every attempt.', id]);
    else await pool.query("UPDATE docs SET status = 'failed' WHERE id = ? AND status = 'processing'", [docId]);
  }
  // A bulk edit doc that was running goes back to waiting with its job.
  const [running] = await pool.query("SELECT id FROM jobs WHERE status = 'running' AND type = 'edit'");
  if (running.length > 0) await pool.query("UPDATE edit_batch_docs SET status = 'queued' WHERE status = 'running' AND job_id IN (?)", [running.map((j) => j.id)]);
  const [requeued] = await pool.query(`UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND ${scope}`);
  return { requeued: requeued.affectedRows, failed: exhausted.length };
}

// Finished jobs older than the retention period. Failed jobs stay until dismissed.
export async function pruneJobs(pool, retentionDays) {
  const [result] = await pool.query(
    "DELETE FROM jobs WHERE status = 'done' AND finished_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
    [retentionDays],
  );
  return result.affectedRows;
}

// ------------------------------------------------------------ admin actions

// A failed job starts over with a fresh set of attempts. Resolves to true if it was failed.
export async function retryJob(pool, jobId) {
  const [result] = await pool.query(
    "UPDATE jobs SET status = 'queued', attempts = 0, last_error = NULL, run_after = NOW(), finished_at = NULL WHERE id = ? AND status = 'failed'",
    [jobId],
  );
  if (result.affectedRows === 0) return false;
  await pool.query("UPDATE docs d JOIN jobs j ON j.doc_id = d.id SET d.status = 'uploaded' WHERE j.id = ? AND j.type = 'ingest' AND d.status = 'failed'", [jobId]);
  await pool.query("UPDATE docs d JOIN jobs j ON j.doc_id = d.id SET d.staged_status = 'processing' WHERE j.id = ? AND j.type = 'replace' AND d.staged_status = 'failed'", [jobId]);
  await pool.query("UPDATE edit_batch_docs e JOIN jobs j ON j.id = e.job_id SET e.status = 'queued', e.message = NULL WHERE j.id = ? AND j.type = 'edit' AND e.status = 'failed'", [jobId]);
  return true;
}

// Resolves to how many jobs were retried.
export async function retryAllFailed(pool) {
  const [ids] = await pool.query("SELECT id FROM jobs WHERE status = 'failed'");
  let retried = 0;
  for (const { id } of ids) if (await retryJob(pool, id)) retried += 1;
  return retried;
}

// Removes a finished or failed job from the list. A job still queued or running stays.
export async function dismissJob(pool, jobId) {
  const [result] = await pool.query("DELETE FROM jobs WHERE id = ? AND status IN ('done', 'failed')", [jobId]);
  return result.affectedRows > 0;
}

// ------------------------------------------------------------------ reading

// Newest first. status: one of JOB_STATUSES, or null for all.
export async function listJobs(pool, { status = null, limit, offset }) {
  const where = status ? 'WHERE j.status = ?' : '';
  const params = status ? [status] : [];
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM jobs j ${where}`, params);
  const [rows] = await pool.query(
    `SELECT j.id, j.doc_id, j.type, j.status, j.attempts, j.last_error, j.run_after, j.created_at, j.finished_at, d.title AS doc_title
       FROM jobs j JOIN docs d ON d.id = j.doc_id ${where} ORDER BY j.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { total: Number(total), rows };
}

// { queued, running, done, failed }
export async function countJobs(pool) {
  const [rows] = await pool.query('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]));
  for (const { status, n } of rows) counts[status] = Number(n);
  return counts;
}
