// Bulk import. Many files at once, with no
// per-file review: each one goes through the same checks and the same path as a
// single upload (ingestUpload), except that a taken slug gets a numeric suffix
// instead of being refused, and a file that fails is skipped without stopping the
// batch. Every file and its outcome is stored, which is the import report.
//
// The chosen files wait in a folder under STAGING_DIR between the upload and the
// admin's confirmation, so the confirmation can state the number of AI calls
// before anything is created. The folder is removed after the import, and any
// that is left behind is cleaned up the next time a batch is staged.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log, errorFields } from '../logger.js';
import { findExceptions } from './review.js';
import { STATUS_LABELS } from './docs.js';
import { cleanLine } from './text.js';
import { ingestUpload, validateUploadFile } from './upload.js';

const STAGE_PREFIX = 'import-';
const STAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[a-f0-9]{24}$/;
const MESSAGE_MAX = 500;
const FILE_NAME_MAX = 255;

export const isStageToken = (value) => TOKEN_PATTERN.test(String(value));

const stageDir = (config, token) => path.join(config.paths.staging, `${STAGE_PREFIX}${token}`);

const fileNameOf = (originalName) => cleanLine(path.basename(String(originalName ?? ''))).slice(0, FILE_NAME_MAX) || '(no name)';

// Removes staged folders older than a day (an abandoned confirmation).
async function sweepStale(config) {
  try {
    for (const entry of await fs.readdir(config.paths.staging, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(STAGE_PREFIX)) continue;
      const dir = path.join(config.paths.staging, entry.name);
      const { mtimeMs } = await fs.stat(dir);
      if (Date.now() - mtimeMs > STAGE_MAX_AGE_MS) await fs.rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    log.warn('could not clean old staged imports', errorFields(err));
  }
}

// ------------------------------------------------------------------ staging

// files: multer memory files. They are stored by position (the names come from the
// browser and are never used as paths) with a manifest of the original names, sorted
// by name so the slug suffixes come out the same every time. Resolves to the token.
export async function stageFiles(config, files) {
  await sweepStale(config);
  const token = crypto.randomBytes(12).toString('hex');
  const dir = stageDir(config, token);
  const sorted = [...files].sort((a, b) => fileNameOf(a.originalname).localeCompare(fileNameOf(b.originalname)));
  await fs.mkdir(dir, { mode: 0o750 });
  try {
    for (const [index, file] of sorted.entries()) await fs.writeFile(path.join(dir, `${index}.md`), file.buffer, { flag: 'wx', mode: 0o640 });
    const manifest = sorted.map((file) => ({ name: fileNameOf(file.originalname) }));
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o640 });
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
  return token;
}

// [{ name, buffer }] in order, or null when the token matches no staged import.
export async function readStaged(config, token) {
  if (!isStageToken(token)) return null;
  const dir = stageDir(config, token);
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    return await Promise.all(manifest.map(async ({ name }, index) => ({ name, buffer: await fs.readFile(path.join(dir, `${index}.md`)) })));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function removeStaged(config, token) {
  if (isStageToken(token)) await fs.rm(stageDir(config, token), { recursive: true, force: true });
}

// What the confirmation page shows: the files that can be imported, and those that
// will be skipped with the reason. The checks are the first ones ingestUpload makes.
export function previewStaged(config, staged) {
  const accepted = [];
  const skipped = [];
  for (const { name, buffer } of staged) {
    const checked = validateUploadFile({ buffer, originalName: name, maxBytes: config.uploads.maxBytes });
    if (checked.ok) accepted.push({ name, bytes: buffer.length });
    else skipped.push({ name, reason: checked.errors[0] });
  }
  return { accepted, skipped };
}

// ------------------------------------------------------------------- import

function describeImported(result) {
  const parts = [];
  if (result.slug !== result.baseSlug) parts.push(`"${result.baseSlug}" was taken, so the slug has a suffix.`);
  if (result.categoryLabels.length > 0) parts.push(`Filed under ${result.categoryLabels.join(' and ')} from the file.`);
  for (const value of result.proposed) parts.push(`Category "${value}" is not in the tree: a proposal was queued, nothing was created.`);
  parts.push(result.queued ? 'Queued for AI extraction.' : 'Ready for review.');
  return parts.join(' ').slice(0, MESSAGE_MAX);
}

// Imports every staged file and records the report. Resolves to the batch id.
// aiCalls and extraCalls are what the confirmation stated and granted.
export async function runImport(pool, config, { actor, staged, aiCalls, extraCalls }) {
  const [batch] = await pool.query('INSERT INTO import_batches (actor, file_count, ai_calls, extra_calls) VALUES (?, ?, ?, ?)', [
    actor,
    staged.length,
    aiCalls,
    extraCalls,
  ]);
  let imported = 0;
  for (const [index, { name, buffer }] of staged.entries()) {
    let item;
    try {
      const result = await ingestUpload(pool, config, {
        file: { buffer, originalname: name },
        formTitle: '',
        formSlug: '',
        suffixCollisions: true,
      });
      item = result.ok
        ? { docId: result.id, slug: result.slug, baseSlug: result.baseSlug, status: 'imported', message: describeImported(result) }
        : { docId: null, slug: null, baseSlug: null, status: 'skipped', message: result.errors.join(' ').slice(0, MESSAGE_MAX) };
    } catch (err) {
      log.error('bulk import could not read a file', { file: name, ...errorFields(err) });
      item = { docId: null, slug: null, baseSlug: null, status: 'skipped', message: 'Unexpected error. See the server log.' };
    }
    if (item.status === 'imported') imported += 1;
    await pool.query(
      'INSERT INTO import_batch_items (batch_id, position, file_name, doc_id, slug, base_slug, status, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [batch.insertId, index + 1, name, item.docId, item.slug, item.baseSlug, item.status, item.message],
    );
  }
  await pool.query('UPDATE import_batches SET imported = ?, skipped = ? WHERE id = ?', [imported, staged.length - imported, batch.insertId]);
  return batch.insertId;
}

// ------------------------------------------------------------------ reading

export async function listBatches(pool, limit) {
  const [rows] = await pool.query(
    'SELECT id, actor, file_count, imported, skipped, ai_calls, extra_calls, created_at FROM import_batches ORDER BY id DESC LIMIT ?',
    [limit],
  );
  return rows;
}

// The import report: the batch, each file's outcome with its doc's current state, and
// the exceptions still holding its docs back (read now, so they clear as you handle them).
// Resolves to null when there is no such batch.
export async function getBatchReport(pool, config, batchId) {
  const [[batch]] = await pool.query(
    'SELECT id, actor, file_count, imported, skipped, ai_calls, extra_calls, created_at FROM import_batches WHERE id = ?',
    [batchId],
  );
  if (!batch) return null;
  const [items] = await pool.query(
    `SELECT i.position, i.file_name, i.doc_id, i.slug, i.base_slug, i.status, i.message,
            d.title, d.status AS doc_status, d.published, d.has_raw_html, d.size_bytes
       FROM import_batch_items i LEFT JOIN docs d ON d.id = i.doc_id
      WHERE i.batch_id = ? ORDER BY i.position`,
    [batchId],
  );
  const docs = items.filter((i) => i.doc_id !== null).map((i) => ({ id: i.doc_id, has_raw_html: i.has_raw_html, size_bytes: i.size_bytes }));
  const exceptions = await findExceptions(pool, config, docs);
  return {
    batch,
    items: items.map((i) => ({
      position: i.position,
      fileName: i.file_name,
      docId: i.doc_id,
      title: i.title ?? '',
      slug: i.slug ?? '',
      suffixed: i.slug !== null && i.slug !== i.base_slug,
      baseSlug: i.base_slug ?? '',
      imported: i.status === 'imported',
      message: i.message ?? '',
      docStatus: i.doc_status ?? '',
      docStatusLabel: STATUS_LABELS[i.doc_status] ?? i.doc_status ?? '',
      // Only docs still waiting: a published doc's old exceptions no longer matter.
      exceptions: i.doc_id !== null && !i.published ? exceptions.get(i.doc_id).map((e) => e.text) : [],
    })),
  };
}
