// Runs one bulk edit job (roadmap Phase 9): the AI adds content to one doc, the app
// checks the result, and a result that passes becomes a staged version (Phase 8).
// The live doc is never touched. A refused result marks the doc "needs attention"
// with the reason; it is not an error, so the job itself finishes.
//
// The staged file is the live front matter plus the new body, so the AI never edits
// front matter; only the `ai:` provenance block gains the edit's details. The staged
// slot is claimed with one conditional UPDATE first, so a doc that already holds a
// staged replacement is left alone. A `replace` job then refreshes the staged keywords,
// the same step a Phase 8 replacement gets.

import { DocFileError, readDocFile, removeStagedFile, writeStagedFile } from './docfiles.js';
import { getDocById } from './docs.js';
import { validateProposal } from './edit-check.js';
import { bodyHash, serializeFrontMatter } from './frontmatter.js';
import { enqueueJob } from './jobs.js';

// The batch doc a job belongs to moves between states as the worker handles it.
// onlyFrom limits the change to docs in one of those states.
export async function setEditDocState(pool, jobId, status, { message = null, onlyFrom = null } = {}) {
  const where = onlyFrom ? 'AND status IN (?)' : '';
  await pool.query(`UPDATE edit_batch_docs SET status = ?, message = ? WHERE job_id = ? ${where}`, [
    status,
    message === null ? null : String(message).slice(0, 500),
    jobId,
    ...(onlyFrom ? [onlyFrom] : []),
  ]);
}

const attention = (pool, row, message) => pool.query("UPDATE edit_batch_docs SET status = 'attention', message = ? WHERE id = ?", [message, row.id]);

// Stages the accepted proposal. Resolves to false when the doc's staged slot is taken.
async function stageProposal(pool, config, doc, live, batch, result) {
  const hash = bodyHash(result.text);
  const [claimed] = await pool.query(
    "UPDATE docs SET staged_at = NOW(), staged_status = 'processing', staged_hash = ?, staged_size = ? WHERE id = ? AND staged_at IS NULL",
    [hash, Buffer.byteLength(result.text, 'utf8'), doc.id],
  );
  if (claimed.affectedRows === 0) return false;

  try {
    const frontMatter = {
      ...live.data,
      ai: {
        ...live.data.ai,
        provider: result.provider,
        model: result.model,
        date: new Date().toISOString().slice(0, 10),
        edit_prompt_version: result.promptVersion,
        edit_batch: batch.id,
      },
    };
    await writeStagedFile(config, doc.id, serializeFrontMatter(frontMatter, result.text), hash);
    await enqueueJob(pool, doc.id, 'replace');
  } catch (err) {
    await pool.query('UPDATE docs SET staged_at = NULL, staged_status = NULL, staged_hash = NULL, staged_size = NULL WHERE id = ?', [doc.id]);
    await removeStagedFile(config, doc.id).catch(() => {});
    throw err;
  }
  return hash;
}

// The whole job. Throws AiError, AiAborted, AiCapReached (from the provider), DocFileError,
// or ENOENT when the file is gone; the worker turns those into a failed or released job.
export async function editForDoc(pool, config, provider, job, { signal } = {}) {
  const [[row]] = await pool.query(
    `SELECT e.id, e.batch_id, e.doc_id, e.status, b.instruction, b.status AS batch_status
       FROM edit_batch_docs e JOIN edit_batches b ON b.id = e.batch_id WHERE e.job_id = ?`,
    [job.id],
  );
  // A cancelled or finished row has nothing left to do.
  if (!row || !['queued', 'running'].includes(row.status)) return false;

  // A job that waited out a retry delay and starts after the admin pressed stop.
  if (row.batch_status === 'stopped') {
    await pool.query("UPDATE edit_batch_docs SET status = 'cancelled', message = 'Stopped before it ran.' WHERE id = ?", [row.id]);
    return false;
  }

  const doc = await getDocById(pool, row.doc_id);
  if (!doc) throw new DocFileError('The document no longer exists.');
  if (doc.staged_at) return attention(pool, row, 'The document already has a staged version, so nothing was added.').then(() => false);
  if (doc.attention) return attention(pool, row, 'The document needs attention (its file is missing or invalid), so it was skipped.').then(() => false);

  const live = await readDocFile(config, doc.slug);
  const result = await provider.editDocument(live.body, row.instruction, {
    title: doc.title,
    signal,
    maxRetries: config.bulkEdit.maxRetries,
    validate: (reply) => validateProposal({ original: live.body, reply, maxBytes: config.uploads.maxBytes }),
  });
  await pool.query('UPDATE edit_batch_docs SET ai_calls = ai_calls + ? WHERE id = ?', [result.calls, row.id]);

  if (!result.ok) {
    await pool.query("UPDATE edit_batch_docs SET status = 'attention', message = ?, check_result = NULL WHERE id = ?", [
      `Refused after ${result.calls} AI call${result.calls === 1 ? '' : 's'}: ${result.reason}`.slice(0, 500),
      row.id,
    ]);
    return false;
  }

  const hash = await stageProposal(pool, config, doc, live, { id: row.batch_id }, result);
  if (hash === false) return attention(pool, row, 'The document got a staged version while the AI worked, so the result was dropped.').then(() => false);

  const addedLines = result.text.split('\n').length - live.body.split('\n').length;
  await pool.query(
    "UPDATE edit_batch_docs SET status = 'ready', proposal_hash = ?, added_lines = ?, message = NULL, check_result = ? WHERE id = ?",
    [hash, Math.max(0, addedLines), `Passed: ${result.checkReason || 'no reason given'}`.slice(0, 500), row.id],
  );
  return true;
}
