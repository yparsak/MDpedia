// Bulk AI edit (roadmap Phase 9). An instruction and a scope (a category with its
// subcategories, chosen documents, or both) become a batch: one `edit` job per doc
// on the Phase 6 queue. Each result is a staged version (Phase 8), so nothing goes
// live until the admin approves it, and approving uses the Phase 8 swap.
//
// This module holds the form checks, the dry run (which docs match, how many AI
// calls), creating, stopping and retrying a batch, and the review actions. The job
// itself is in ai-edit.js; the safeguards on a result are in edit-check.js.
//
// A batch doc row (edit_batch_docs) says what happened to one doc. Its `proposal_hash`
// is the body hash of the staged file it refers to: if the staged version was replaced
// or discarded elsewhere (the Replace page), the hash no longer matches and the row is
// "superseded", never approved by mistake.

import { aiConfigured } from '../config.js';
import { EDIT_PROMPT_VERSION } from './ai-prompt.js';
import { subtreeOf } from './categories.js';
import { DocFileError, readDocFile, readStagedFile, writeStagedFile } from './docfiles.js';
import { getDocById } from './docs.js';
import { checkBodyText } from './edit-check.js';
import { bodyHash, serializeFrontMatter } from './frontmatter.js';
import { enqueueJob } from './jobs.js';
import { diffLines } from './line-diff.js';
import { approveStaged, discardStaged } from './replace.js';

export const INSTRUCTION_MAX = 2000;
const REFS_MAX = 200;
const REF_MAX = 80;
const MESSAGE_MAX = 500;

// Per doc: one edit call, one self-check call, one call to refresh the keywords.
export const CALLS_PER_DOC = 3;

// Docs the AI queue still owns cannot take a staged version (as in replace.js).
const BUSY = ['uploaded', 'processing'];

export const ROW_LABELS = {
  queued: 'Queued',
  running: 'Running',
  ready: 'Ready for review',
  attention: 'Needs attention',
  failed: 'Failed',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const ROW_BADGES = {
  queued: 'queued',
  running: 'running',
  ready: 'ready',
  attention: 'warn',
  failed: 'failed',
  approved: 'published',
  rejected: 'unpublished',
  cancelled: 'unpublished',
};

const num = (value) => Number(value ?? 0);

// ---------------------------------------------------------------- the form

// Control characters other than line breaks and tabs go; the rest is the admin's own text.
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const cleanInstruction = (value) =>
  String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();

// "slug", "slug, other" or "12" per line, as typed. Lower case, repeats dropped.
export const parseRefs = (value) => [...new Set(String(value ?? '').split(/[\n,]+/).map((ref) => ref.trim().toLowerCase()).filter((ref) => ref !== ''))];

// form: { instruction, category, docs, includeUnpublished } as typed.
// Resolves to { ok: true, scope } or { ok: false, errors }. scope is
// { instruction, categoryId, refs, includeUnpublished }.
export function parseEditForm(form, tree) {
  const errors = [];
  const instruction = cleanInstruction(form.instruction);
  if (instruction === '') errors.push('An instruction is required.');
  if (instruction.length > INSTRUCTION_MAX) errors.push(`The instruction is longer than ${INSTRUCTION_MAX} characters.`);

  let categoryId = null;
  if (String(form.category ?? '') !== '') {
    categoryId = /^\d{1,10}$/.test(String(form.category)) ? Number(form.category) : null;
    if (categoryId === null || !tree.byId.has(categoryId)) errors.push('That category does not exist.');
  }

  const refs = parseRefs(form.docs);
  if (refs.length > REFS_MAX) errors.push(`Name at most ${REFS_MAX} documents.`);
  if (refs.some((ref) => ref.length > REF_MAX)) errors.push(`A document slug or id is longer than ${REF_MAX} characters.`);
  if (categoryId === null && refs.length === 0 && !errors.includes('That category does not exist.')) {
    errors.push('Choose a category, name some documents, or both.');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scope: { instruction, categoryId, refs, includeUnpublished: Boolean(form.includeUnpublished) } };
}

// ---------------------------------------------------------------- dry run

// Which docs the scope matches and which of those can be edited now.
// Resolves to { matched, excluded: [{ doc, reason }], unpublished, unknown } where unpublished
// is how many docs were left out for not being published and unknown the names that matched nothing.
export async function findScopeDocs(pool, tree, scope) {
  const found = new Map();
  const add = (rows) => rows.forEach((row) => found.set(row.id, row));
  const columns = 'id, slug, title, status, published, attention, staged_at, size_bytes';

  if (scope.categoryId !== null) {
    const categoryIds = subtreeOf(tree.byId.get(scope.categoryId)).map((node) => node.id);
    const [rows] = await pool.query(
      `SELECT DISTINCT d.id, d.slug, d.title, d.status, d.published, d.attention, d.staged_at, d.size_bytes
         FROM docs d JOIN doc_categories dc ON dc.doc_id = d.id WHERE dc.category_id IN (?)`,
      [categoryIds],
    );
    add(rows);
  }

  const unknown = [];
  if (scope.refs.length > 0) {
    const ids = scope.refs.filter((ref) => /^\d{1,10}$/.test(ref)).map(Number);
    const [rows] = await pool.query(`SELECT ${columns} FROM docs WHERE slug IN (?) OR id IN (?)`, [scope.refs, ids.length > 0 ? ids : [0]]);
    add(rows);
    const known = new Set(rows.flatMap((row) => [row.slug.toLowerCase(), String(row.id)]));
    unknown.push(...scope.refs.filter((ref) => !known.has(ref)));
  }

  const docs = [...found.values()].sort((a, b) => a.id - b.id);
  const [active] = docs.length === 0
    ? [[]]
    : await pool.query("SELECT DISTINCT doc_id FROM edit_batch_docs WHERE status IN ('queued', 'running') AND doc_id IN (?)", [docs.map((d) => d.id)]);
  const inBatch = new Set(active.map((row) => row.doc_id));

  const matched = [];
  const excluded = [];
  let unpublished = 0;
  for (const doc of docs) {
    if (!doc.published && !scope.includeUnpublished) {
      unpublished += 1;
      continue;
    }
    const reason = BUSY.includes(doc.status)
      ? 'The AI is still working on it.'
      : doc.attention
        ? 'It needs attention (its file is missing or invalid).'
        : doc.staged_at
          ? 'It already has a staged version waiting (a replacement or an earlier edit).'
          : inBatch.has(doc.id)
            ? 'It is in a bulk edit that is still running.'
            : null;
    if (reason) excluded.push({ doc, reason });
    else matched.push(doc);
  }
  return { matched, excluded, unpublished, unknown };
}

// The AI calls a batch of `count` docs uses: the usual case, and the most it can use
// when every doc needs every retry.
export function estimateCalls(count, maxRetries) {
  return { expected: count * CALLS_PER_DOC, worst: count * ((1 + maxRetries) * 2 + 1) };
}

// ----------------------------------------------------------------- creating

// Queues one job per doc and records the batch, in one transaction. Resolves to the batch id.
// aiCalls and extraCalls are what the confirmation stated and granted.
export async function createBatch(pool, config, { actor, scope, docs, aiCalls, extraCalls }) {
  if (!aiConfigured(config)) throw new Error('The AI is not configured.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [batch] = await conn.query(
      'INSERT INTO edit_batches (actor, instruction, scope, prompt_version, max_retries, ai_calls, extra_calls) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        actor,
        scope.instruction,
        JSON.stringify({ categoryId: scope.categoryId, refs: scope.refs, includeUnpublished: scope.includeUnpublished }).slice(0, 2000),
        EDIT_PROMPT_VERSION,
        config.bulkEdit.maxRetries,
        aiCalls,
        extraCalls,
      ],
    );
    for (const [index, doc] of docs.entries()) {
      const jobId = await enqueueJob(conn, doc.id, 'edit');
      await conn.query('INSERT INTO edit_batch_docs (batch_id, doc_id, job_id, position) VALUES (?, ?, ?, ?)', [batch.insertId, doc.id, jobId, index + 1]);
    }
    await conn.commit();
    return batch.insertId;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ------------------------------------------------------------------ reading

const BATCH_COLUMNS = `b.id, b.actor, b.instruction, b.scope, b.status, b.prompt_version, b.max_retries, b.ai_calls, b.extra_calls,
       b.created_at, b.stopped_at, COUNT(e.id) AS total,
       COALESCE(SUM(e.status IN ('queued', 'running')), 0) AS active,
       COALESCE(SUM(e.status = 'ready'), 0) AS ready,
       COALESCE(SUM(e.status IN ('attention', 'failed')), 0) AS problems,
       COALESCE(SUM(e.status = 'approved'), 0) AS approved`;

// What the batch list and page show: a batch is running while a doc is queued or
// running, stopped when the admin pressed stop, and finished otherwise.
function batchRow(r) {
  const active = num(r.active);
  return {
    id: r.id,
    actor: r.actor,
    instruction: r.instruction,
    scope: r.scope,
    prompt: r.prompt_version,
    maxRetries: r.max_retries,
    aiCalls: r.ai_calls,
    extraCalls: r.extra_calls,
    createdAt: r.created_at,
    stoppedAt: r.stopped_at ?? '',
    total: num(r.total),
    active,
    ready: num(r.ready),
    problems: num(r.problems),
    approved: num(r.approved),
    state: r.status === 'stopped' ? 'Stopped' : active > 0 ? 'Running' : 'Finished',
    stopped: r.status === 'stopped',
  };
}

export async function listBatches(pool, limit) {
  const [rows] = await pool.query(
    `SELECT ${BATCH_COLUMNS} FROM edit_batches b LEFT JOIN edit_batch_docs e ON e.batch_id = b.id GROUP BY b.id ORDER BY b.id DESC LIMIT ?`,
    [limit],
  );
  return rows.map(batchRow);
}

// Resolves to null when there is no such batch.
export async function getBatch(pool, batchId) {
  const [rows] = await pool.query(
    `SELECT ${BATCH_COLUMNS} FROM edit_batches b LEFT JOIN edit_batch_docs e ON e.batch_id = b.id WHERE b.id = ? GROUP BY b.id`,
    [batchId],
  );
  return rows.length === 0 ? null : batchRow(rows[0]);
}

// The state of one doc in a batch, as the page shows it. A "ready" doc is superseded when
// its staged version is not the one this row recorded, and waits while the keywords refresh.
function rowView(r) {
  const superseded = r.status === 'ready' && (!r.staged_at || r.staged_hash !== r.proposal_hash);
  const refreshing = r.status === 'ready' && !superseded && r.staged_status === 'processing';
  return {
    id: r.id,
    docId: r.doc_id,
    title: r.title,
    slug: r.slug,
    status: r.status,
    statusLabel: superseded ? 'Superseded' : (ROW_LABELS[r.status] ?? r.status),
    badge: superseded ? 'unpublished' : (ROW_BADGES[r.status] ?? 'queued'),
    note: superseded
      ? 'The staged version was replaced or discarded elsewhere, so this proposal can no longer be approved here.'
      : refreshing
        ? 'The AI is refreshing the keywords. Approve once that finishes (reload).'
        : r.staged_status === 'failed' && r.status === 'ready'
          ? 'The keyword refresh failed; approving keeps the current keywords.'
          : '',
    message: r.message ?? '',
    checkResult: r.check_result ?? '',
    addedLines: r.added_lines,
    aiCalls: r.ai_calls,
    proposalHash: r.proposal_hash ?? '',
    superseded,
    refreshing,
    canApprove: r.status === 'ready' && !superseded && !refreshing,
    canReview: r.status === 'ready' && !superseded,
  };
}

const ROW_SELECT = `SELECT e.id, e.doc_id, e.status, e.proposal_hash, e.added_lines, e.ai_calls, e.message, e.check_result,
       d.title, d.slug, d.staged_at, d.staged_status, d.staged_hash
  FROM edit_batch_docs e JOIN docs d ON d.id = e.doc_id`;

export async function getBatchDocs(pool, batchId) {
  const [rows] = await pool.query(`${ROW_SELECT} WHERE e.batch_id = ? ORDER BY e.position`, [batchId]);
  return rows.map(rowView);
}

// Resolves to null when the doc is not in the batch.
export async function getBatchDoc(pool, batchId, docId) {
  const [rows] = await pool.query(`${ROW_SELECT} WHERE e.batch_id = ? AND e.doc_id = ?`, [batchId, docId]);
  return rows.length === 0 ? null : rowView(rows[0]);
}

// What the review screen shows for one doc: the live body against the staged one, side by side.
// Resolves to { ok: true, diff, body } or { ok: false, reason }.
export async function loadProposal(config, doc) {
  try {
    const live = await readDocFile(config, doc.slug);
    const staged = await readStagedFile(config, doc.id);
    return { ok: true, diff: diffLines(live.body, staged.body), body: staged.body };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'The live file or the staged file is missing.' };
    if (err instanceof DocFileError) return { ok: false, reason: err.message };
    throw err;
  }
}

// -------------------------------------------------------- stop and retry

// Cancels what has not started. A doc already running finishes, and every finished result
// stays for review. Resolves to how many queued docs were cancelled.
export async function stopBatch(pool, batchId) {
  await pool.query("UPDATE edit_batches SET status = 'stopped', stopped_at = NOW() WHERE id = ? AND status = 'running'", [batchId]);
  const [queued] = await pool.query("SELECT id, job_id FROM edit_batch_docs WHERE batch_id = ? AND status = 'queued'", [batchId]);
  let cancelled = 0;
  for (const row of queued) {
    // A job claimed a moment ago is no longer queued: leave it to finish.
    const [removed] = row.job_id === null ? [{ affectedRows: 1 }] : await pool.query("DELETE FROM jobs WHERE id = ? AND status = 'queued'", [row.job_id]);
    if (removed.affectedRows === 0) continue;
    await pool.query("UPDATE edit_batch_docs SET status = 'cancelled', message = 'Stopped before it ran.' WHERE id = ? AND status = 'queued'", [row.id]);
    cancelled += 1;
  }
  return cancelled;
}

// Queues again the docs that errored or were refused. A doc that has a staged version
// meanwhile is skipped. Resolves to { retried, skipped }.
export async function retryFailed(pool, batchId) {
  const [rows] = await pool.query(
    `SELECT e.id, e.job_id, d.id AS doc_id, d.staged_at
       FROM edit_batch_docs e JOIN docs d ON d.id = e.doc_id
      WHERE e.batch_id = ? AND e.status IN ('failed', 'attention') ORDER BY e.position`,
    [batchId],
  );
  let retried = 0;
  for (const row of rows) {
    if (row.staged_at) continue;
    const jobId = await enqueueJob(pool, row.doc_id, 'edit');
    await pool.query("UPDATE edit_batch_docs SET status = 'queued', job_id = ?, message = NULL, check_result = NULL WHERE id = ?", [jobId, row.id]);
    if (row.job_id !== null) await pool.query("DELETE FROM jobs WHERE id = ? AND status IN ('failed', 'done')", [row.job_id]);
    retried += 1;
  }
  if (retried > 0) await pool.query("UPDATE edit_batches SET status = 'running', stopped_at = NULL WHERE id = ?", [batchId]);
  return { retried, skipped: rows.length - retried };
}

// ------------------------------------------------------------------ review

// Approves the given rows (from getBatchDocs) with the Phase 8 swap. A row whose staged
// version is not the one it recorded, or whose keywords are still refreshing, is skipped.
// Resolves to { approved: [row], skipped: [{ row, reason }] }.
export async function approveRows(pool, config, rows) {
  const approved = [];
  const skipped = [];
  for (const row of rows) {
    if (!row.canApprove) {
      skipped.push({ row, reason: row.superseded ? 'its staged version changed or was discarded' : row.note || `it is not ready (${row.statusLabel.toLowerCase()})` });
      continue;
    }
    try {
      const doc = await getDocById(pool, row.docId);
      const result = await approveStaged(pool, config, doc, row.proposalHash);
      if (!result.ok) {
        skipped.push({ row, reason: result.errors[0].slice(0, MESSAGE_MAX) });
        continue;
      }
      await pool.query("UPDATE edit_batch_docs SET status = 'approved', message = NULL WHERE id = ?", [row.id]);
      approved.push(row);
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof DocFileError)) throw err;
      skipped.push({ row, reason: err instanceof DocFileError ? err.message : 'its file is missing' });
    }
  }
  return { approved, skipped };
}

// Throws the proposal away: the staged version goes, the live doc is untouched.
// A staged version that is no longer this row's is left alone.
export async function rejectRow(pool, config, row) {
  const doc = await getDocById(pool, row.docId);
  if (doc?.staged_at && doc.staged_hash === row.proposalHash) await discardStaged(pool, config, doc);
  await pool.query("UPDATE edit_batch_docs SET status = 'rejected', message = NULL WHERE id = ? AND status = 'ready'", [row.id]);
}

// The admin's own edit of a proposal (edits to existing text are made by hand, never by the
// AI, so the add-only rule does not apply here). The staged file keeps its front matter.
// Resolves to { ok: true } or { ok: false, errors }.
export async function saveHandEdit(pool, config, row, rawText) {
  if (!row.canReview) return { ok: false, errors: ['This proposal can no longer be edited here.'] };
  if (row.refreshing) return { ok: false, errors: ['The AI is still refreshing the keywords. Edit once that finishes.'] };
  const text = String(rawText ?? '').replace(/\r\n?/g, '\n');
  if (text.trim() === '') return { ok: false, errors: ['The text is empty.'] };

  try {
    const live = await readDocFile(config, row.slug);
    const checked = checkBodyText({ text, original: live.body, maxBytes: config.uploads.maxBytes });
    if (!checked.ok) return { ok: false, errors: [`The text was refused: ${checked.reason}`] };

    const staged = await readStagedFile(config, row.docId);
    const hash = bodyHash(text);
    await writeStagedFile(config, row.docId, serializeFrontMatter(staged.data, text), hash);
    await pool.query('UPDATE docs SET staged_hash = ?, staged_size = ? WHERE id = ? AND staged_hash = ?', [
      hash,
      Buffer.byteLength(text, 'utf8'),
      row.docId,
      row.proposalHash,
    ]);
    await pool.query("UPDATE edit_batch_docs SET proposal_hash = ?, added_lines = ?, message = 'Edited by hand.' WHERE id = ?", [
      hash,
      Math.max(0, text.split('\n').length - live.body.split('\n').length),
      row.id,
    ]);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, errors: ['The live file or the staged file is missing, so nothing was saved.'] };
    if (err instanceof DocFileError) return { ok: false, errors: [err.message] };
    throw err;
  }
  return { ok: true };
}
