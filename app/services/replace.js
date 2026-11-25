// Replacing a published doc without readers seeing a half-finished version.
// The upload goes to staging as
// STAGING_DIR/replace-<id>.md, built from the live doc's front matter and the new
// body, so the app keeps the front matter and the old version stays live. If the AI
// is configured a `replace` job refreshes the staged keywords (and the summary,
// unless it was hand-edited); categories are never touched. Approving swaps the
// file into place and then updates the row in one transaction. If a crash falls
// between the two, the reconciliation scan repairs the row from the file.
//
// One staged version per doc: staging again replaces the earlier one. A staged
// version nobody approves is removed after STAGED_RETENTION_DAYS (cleanupStaged).

import { slugify } from '../public/js/slug.js';
import { aiConfigured } from '../config.js';
import {
  DocFileError,
  cleanStagingDir,
  readDocFile,
  readStagedFile,
  removeStagedFile,
  statDocFile,
  swapIntoPlace,
  writeStagedFile,
} from './docfiles.js';
import { enqueueEmbedding } from './embed-queue.js';
import { bodyHash, parseFrontMatter, serializeFrontMatter } from './frontmatter.js';
import { enqueueJob } from './jobs.js';
import { insertTerms, termsFromFrontMatter } from './search-terms.js';
import { SUMMARY_MAX, cleanLine, validateUploadFile } from './upload.js';
import { insertLinks, renderWithLinks } from './wiki-links.js';

const TERM_KEYS = ['keywords', 'key_phrases', 'synonyms', 'questions'];

const fail = (status, ...errors) => ({ ok: false, status, errors });

// Docs the AI queue still owns cannot be replaced yet.
const BUSY = ['uploaded', 'processing'];

// Replace jobs that are not running. A running one finds the staged file changed or gone and stops quietly.
const dropReplaceJobs = (pool, docId) =>
  pool.query("DELETE FROM jobs WHERE doc_id = ? AND type = 'replace' AND status <> 'running'", [docId]);

const clearStaged = (pool, docId) =>
  pool.query('UPDATE docs SET staged_at = NULL, staged_status = NULL, staged_hash = NULL, staged_size = NULL WHERE id = ?', [docId]);

// ------------------------------------------------------------------ staging

// Checks the file against the doc and stages it. Nothing live changes.
// Resolves to { ok: true, queued } or { ok: false, status, errors }.
export async function stageReplacement(pool, config, doc, file) {
  if (BUSY.includes(doc.status)) return fail(409, 'The AI is still working on this document. Replace it once it is ready for review.');

  const checked = validateUploadFile({ buffer: file?.buffer, originalName: file?.originalname, maxBytes: config.uploads.maxBytes });
  if (!checked.ok) return checked;
  const parsed = parseFrontMatter(checked.text);
  if (!parsed.ok) return fail(400, parsed.error);
  const { data, body } = parsed;

  if (data.id !== undefined && data.id !== doc.id) {
    return fail(409, `The file's front matter id (${data.id}) is not this document's id (${doc.id}). Remove the id line or use this document's id.`);
  }
  if (cleanLine(data.slug) !== '' && slugify(data.slug, { max: Infinity }) !== doc.slug) {
    return fail(409, `The file's front matter slug does not match "${doc.slug}". A slug is permanent: remove the slug line or use "${doc.slug}".`);
  }
  if (body.trim() === '') return fail(400, 'The file has no content after its front matter.');

  let live;
  try {
    live = await readDocFile(config, doc.slug);
  } catch (err) {
    if (err.code === 'ENOENT') return fail(409, 'The live file for this document is missing from the docs directory, so there is nothing to replace. Restore it first.');
    if (err instanceof DocFileError) return fail(409, err.message);
    throw err;
  }

  // The staged file keeps the live front matter (keywords and summary carry over until the AI refreshes them).
  const hash = bodyHash(body);
  await writeStagedFile(config, doc.id, serializeFrontMatter(live.data, body), hash);

  const queued = aiConfigured(config);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM jobs WHERE doc_id = ? AND type = 'replace' AND status <> 'running'", [doc.id]);
    await conn.query(
      'UPDATE docs SET staged_at = NOW(), staged_status = ?, staged_hash = ?, staged_size = ? WHERE id = ?',
      [queued ? 'processing' : 'ready', hash, file.buffer.length, doc.id],
    );
    if (queued) await enqueueJob(conn, doc.id, 'replace');
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return { ok: true, queued };
}

// What the replace page shows about the staged version: its body rendered (links
// resolved as they stand now), its keywords and summary. Resolves to
// { ok: true, ... } or { ok: false, reason } when the staged file is gone or unreadable.
export async function loadStaged(pool, config, doc) {
  let staged;
  try {
    staged = await readStagedFile(config, doc.id);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'The staged file is gone from the staging directory. Discard this replacement and upload it again.' };
    if (err instanceof DocFileError) return { ok: false, reason: err.message };
    throw err;
  }
  const rendered = await renderWithLinks(pool, staged.body, doc.title);
  return {
    ok: true,
    html: rendered.html,
    hasRawHtml: rendered.hasRawHtml,
    terms: termsFromFrontMatter(staged.data),
    summary: typeof staged.data.summary === 'string' ? staged.data.summary : '',
  };
}

// ---------------------------------------------------------------- approving

// The live front matter with the staged version's refreshed pieces laid over it:
// keywords, key phrases, synonyms, questions, the AI provenance, and the summary
// unless the live one was hand-edited. Everything else (categories, published, title) stays live.
function mergeFrontMatter(liveData, stagedData) {
  const merged = { ...liveData };
  for (const key of TERM_KEYS) merged[key] = stagedData[key];
  if (!liveData.summary_edited) {
    merged.summary = stagedData.summary;
    merged.summary_edited = undefined;
  }
  if (stagedData.ai) merged.ai = stagedData.ai;
  return merged;
}

// Swaps the staged version in. expectedHash is the body hash the admin was looking at.
// Resolves to { ok: true } or { ok: false, status, errors }.
export async function approveStaged(pool, config, doc, expectedHash) {
  if (!doc.staged_at) return fail(409, 'There is no staged replacement for this document.');
  if (doc.staged_status === 'processing') return fail(409, 'The AI is still refreshing the keywords. Approve it once that finishes.');
  if (expectedHash !== doc.staged_hash) return fail(409, 'The staged version changed since you opened this page. Look at it again before approving.');

  let staged;
  let live;
  try {
    staged = await readStagedFile(config, doc.id);
    live = await readDocFile(config, doc.slug);
  } catch (err) {
    if (err.code === 'ENOENT') return fail(409, 'The staged file or the live file is missing, so nothing was changed.');
    if (err instanceof DocFileError) return fail(409, err.message);
    throw err;
  }
  const hash = bodyHash(staged.body);
  if (hash !== doc.staged_hash) return fail(409, 'The staged file does not match what was recorded for it, so nothing was changed. Discard it and upload again.');

  const merged = mergeFrontMatter(live.data, staged.data);
  const rendered = await renderWithLinks(pool, staged.body, doc.title);
  const terms = termsFromFrontMatter(merged);
  const summary = cleanLine(merged.summary).slice(0, SUMMARY_MAX) || null;
  const aiChanged = Boolean(merged.ai) && JSON.stringify(merged.ai) !== JSON.stringify(live.data.ai);

  // File first, then the row.
  await swapIntoPlace(config, doc.slug, serializeFrontMatter(merged, staged.body), hash);
  const stat = await statDocFile(config, doc.slug);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE docs SET html = ?, plain_text = ?, has_raw_html = ?, body_hash = ?, summary = ?,
              size_bytes = ?, file_size = ?, file_mtime_ms = ?,
              attention = NULL, attention_reason = NULL, attention_at = NULL,
              staged_at = NULL, staged_status = NULL, staged_hash = NULL, staged_size = NULL
        WHERE id = ?`,
      [rendered.html, rendered.plainText, rendered.hasRawHtml ? 1 : 0, hash, summary, doc.staged_size, stat?.size ?? null, stat?.mtimeMs ?? null, doc.id],
    );
    if (aiChanged) {
      await conn.query('UPDATE docs SET ai_provider = ?, ai_model = ?, ai_prompt_version = ?, ai_at = NOW() WHERE id = ?', [
        String(merged.ai.provider ?? '').slice(0, 50) || null,
        String(merged.ai.model ?? '').slice(0, 200) || null,
        String(merged.ai.prompt_version ?? '').slice(0, 20) || null,
        doc.id,
      ]);
    }
    await conn.query('DELETE FROM doc_terms WHERE doc_id = ?', [doc.id]);
    await insertTerms(conn, doc.id, terms);
    await conn.query('DELETE FROM doc_links WHERE source_doc_id = ?', [doc.id]);
    await insertLinks(conn, doc.id, rendered.linkTargets);
    await conn.commit();
  } catch (err) {
    // The new file is already live. The scan sees that the body hash differs and fixes the row.
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  await removeStagedFile(config, doc.id).catch(() => {});
  await dropReplaceJobs(pool, doc.id);
  // The summary and keywords may have changed with the new version.
  await enqueueEmbedding(pool, config, doc.id);
  return { ok: true };
}

// ------------------------------------------------------------- discarding

export async function discardStaged(pool, config, doc) {
  await dropReplaceJobs(pool, doc.id);
  await clearStaged(pool, doc.id);
  await removeStagedFile(config, doc.id);
}

// Staged versions nobody approved for STAGED_RETENTION_DAYS, and staging files no
// doc owns. Resolves to { discarded, orphans }.
export async function cleanupStaged(pool, config) {
  const [abandoned] = await pool.query(
    'SELECT id FROM docs WHERE staged_at IS NOT NULL AND staged_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [config.worker.stagedRetentionDays],
  );
  for (const { id } of abandoned) await discardStaged(pool, config, { id });
  const [kept] = await pool.query('SELECT id FROM docs WHERE staged_at IS NOT NULL');
  const orphans = await cleanStagingDir(config, new Set(kept.map((row) => row.id)));
  return { discarded: abandoned.length, orphans };
}

// The doc ids that have a staged version, for the dashboard and the Attention page.
export async function listStaged(pool) {
  const [rows] = await pool.query(
    'SELECT id, slug, title, staged_at, staged_status FROM docs WHERE staged_at IS NOT NULL ORDER BY staged_at',
  );
  return rows;
}
