// Queues embedding jobs. They live in the same `jobs` table
// as the AI jobs, with type 'embed', but a separate worker runs them (embed-worker.js):
// embedding is local, so it does not use the AI daily cap or the circuit breaker.
//
// Best effort: a failure to queue is logged and never undoes the change that
// triggered it (a summary edit, an approval), and the "Rebuild all vectors"
// button is the safety net. Nothing happens when vector search is off.

import { log, errorFields } from '../logger.js';

export const EMBED_JOB_TYPE = 'embed';

// Only a published doc is queued (readers and the lab only ever see those), and
// a doc that already has a waiting embed job is not queued twice. Resolves to
// true when a job was added.
export async function enqueueEmbedding(pool, config, docId) {
  if (!config.embed?.enabled) return false;
  try {
    const [result] = await pool.query(
      `INSERT INTO jobs (doc_id, type)
       SELECT d.id, ? FROM docs d
        WHERE d.id = ? AND d.published = 1
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.doc_id = d.id AND j.type = ? AND j.status = 'queued')`,
      [EMBED_JOB_TYPE, docId, EMBED_JOB_TYPE],
    );
    return result.affectedRows > 0;
  } catch (err) {
    log.warn('could not queue an embedding job', { doc: docId, ...errorFields(err) });
    return false;
  }
}

// The "Rebuild all vectors" button: every published doc, whether or not it has a
// current vector. Existing vectors are marked stale first (input_hash cleared), so
// the jobs recompute them instead of skipping them as unchanged; the old vectors
// keep serving until each new one replaces it. Resolves to how many jobs were added.
export async function enqueueAllEmbeddings(pool, config) {
  if (!config.embed?.enabled) return 0;
  await pool.query("UPDATE doc_vectors SET input_hash = ''");
  const [result] = await pool.query(
    `INSERT INTO jobs (doc_id, type)
     SELECT d.id, ? FROM docs d
      WHERE d.published = 1
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.doc_id = d.id AND j.type = ? AND j.status IN ('queued', 'running'))`,
    [EMBED_JOB_TYPE, EMBED_JOB_TYPE],
  );
  return result.affectedRows;
}
