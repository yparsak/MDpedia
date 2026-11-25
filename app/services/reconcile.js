// The reconciliation scan. The file is
// canonical ("file wins"): a doc edited over SSH is re-read and the row follows.
// It runs at startup, every RECONCILE_INTERVAL_MINUTES, and from the "Rescan now"
// button. Size and modified time are compared first and a file is read only when
// they differ (or the doc needs attention); then the body hash decides whether the
// page is rendered again. The staging directory is never scanned.
//
// What a scan applies from a changed file: the body, title, summary and search
// terms. `published` and `categories` stay under the admin's control in the app.
//
// The safeguards:
//   - invalid front matter (broken YAML, wrong types, an unknown category id, a
//     changed `id` or `slug`): the row keeps its last good state and is marked
//     "invalid"; nothing from that file is applied
//   - a missing file marks the doc "missing". The row is never deleted and readers
//     keep seeing the last good version
//   - a file with no row that claims the id or slug of a doc is rejected and listed
//     (file_issues); the doc it copies is untouched. A file that is not a doc at all
//     is listed as untracked and ignored: documents are added by upload

import { SLUG_PATTERN, slugify } from '../public/js/slug.js';
import { log, errorFields } from '../logger.js';
import { recordAudit } from './audit.js';
import { loadTree } from './categories.js';
import { listDocFiles, readDocFileText } from './docfiles.js';
import { enqueueEmbedding } from './embed-queue.js';
import { bodyHash, parseFrontMatter } from './frontmatter.js';
import { cleanupStaged } from './replace.js';
import { formatTermForm, getDocTerms, insertTerms, termsFromFrontMatter } from './search-terms.js';
import { SUMMARY_MAX, TITLE_MAX, cleanLine } from './upload.js';
import { insertLinks, renderWithLinks, rerenderDependents } from './wiki-links.js';

// A file this new may still be in the middle of being written (an upload, or an
// editor on the Pi), so a file with no row is judged on a later scan.
const NEW_FILE_SETTLE_MS = 3000;

const MISSING_REASON = 'The file is missing from the docs directory. Readers still see the last good version.';

let scanning = false;


// ------------------------------------------------------------ one known doc

// Why the file cannot be applied, or null. A sentence for the admin.
function problemWith(doc, parsed, tree) {
  if (!parsed.ok) return parsed.error;
  const { data } = parsed;
  if (data.id !== undefined && data.id !== doc.id) {
    return `The front matter id is ${data.id}, but this document's id is ${doc.id}. The id is permanent: put it back.`;
  }
  if (cleanLine(data.slug) !== '' && slugify(data.slug, { max: Infinity }) !== doc.slug) {
    return `The front matter slug does not match "${doc.slug}". The slug is permanent: put it back.`;
  }
  if (cleanLine(data.title).length > TITLE_MAX) return `The front matter title is longer than ${TITLE_MAX} characters.`;
  const unknown = (data.categories ?? []).find((value) => typeof value === 'number' && !tree.byId.has(value));
  if (unknown !== undefined) return `The front matter lists category id ${unknown}, which does not exist.`;
  return null;
}

// Marks the doc and says so once, when the state or the reason changes.
async function setAttention(pool, doc, kind, reason) {
  const text = reason.slice(0, 300);
  if (doc.attention === kind && doc.attention_reason === text) return false;
  await pool.query('UPDATE docs SET attention = ?, attention_reason = ?, attention_at = NOW() WHERE id = ?', [kind, text, doc.id]);
  log.warn('document needs attention', { slug: doc.slug, kind });
  await recordAudit(pool, { actor: 'system', action: 'doc.attention', targetType: 'doc', targetId: doc.id, summary: `"${doc.slug}" needs attention (${kind}): ${text}` });
  return true;
}

// Applies a changed file to its row. Resolves to 'updated', 'unchanged' (only the
// stored size and time moved) or 'flagged'.
async function syncDoc(pool, config, tree, doc, file) {
  let text;
  try {
    text = await readDocFileText(config, file.fileName);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await setAttention(pool, doc, 'missing', MISSING_REASON);
    return 'flagged';
  }
  const parsed = parseFrontMatter(text);
  const problem = problemWith(doc, parsed, tree);
  if (problem !== null) {
    await setAttention(pool, doc, 'invalid', `${problem} Readers still see the last good version.`);
    return 'flagged';
  }

  const { data, body } = parsed;
  const title = cleanLine(data.title) || doc.title;
  const summary = cleanLine(data.summary).slice(0, SUMMARY_MAX) || null;
  const summaryEdited = summary !== null && data.summary_edited === true ? 1 : 0;
  const hash = bodyHash(body);
  const terms = termsFromFrontMatter(data);

  const bodyChanged = hash !== doc.body_hash;
  const titleChanged = title !== doc.title;
  const summaryChanged = summary !== (doc.summary ?? null) || summaryEdited !== Number(doc.summary_edited);
  const termsChanged = JSON.stringify(formatTermForm(terms)) !== JSON.stringify(formatTermForm(await getDocTerms(pool, doc.id)));
  const rendered = bodyChanged || titleChanged ? await renderWithLinks(pool, body, title) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE docs SET title = ?, summary = ?, summary_edited = ?, file_size = ?, file_mtime_ms = ?,
              attention = NULL, attention_reason = NULL, attention_at = NULL, updated_at = IF(?, NOW(), updated_at)
        WHERE id = ?`,
      [title, summary, summaryEdited, file.size, file.mtimeMs, bodyChanged || titleChanged || summaryChanged || termsChanged ? 1 : 0, doc.id],
    );
    if (rendered) {
      await conn.query('UPDATE docs SET html = ?, plain_text = ?, has_raw_html = ?, body_hash = ? WHERE id = ?', [
        rendered.html,
        rendered.plainText,
        rendered.hasRawHtml ? 1 : 0,
        hash,
        doc.id,
      ]);
    }
    if (bodyChanged) {
      await conn.query('DELETE FROM doc_links WHERE source_doc_id = ?', [doc.id]);
      await insertLinks(conn, doc.id, rendered.linkTargets);
    }
    if (termsChanged) {
      await conn.query('DELETE FROM doc_terms WHERE doc_id = ?', [doc.id]);
      await insertTerms(conn, doc.id, terms);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  if (titleChanged && doc.published) await rerenderDependents(pool, config, { ...doc, title });
  // A file edited over SSH: the vector is made from the title, summary and terms.
  if (titleChanged || summaryChanged || termsChanged) await enqueueEmbedding(pool, config, doc.id);
  return bodyChanged || titleChanged || summaryChanged || termsChanged ? 'updated' : 'unchanged';
}

// ------------------------------------------------------- files with no row

// The issue for a file no row owns, or null when it only needs to wait. { kind, docId, reason }.
async function judgeStrayFile(config, file, docsById, docsBySlug) {
  if (!SLUG_PATTERN.test(file.slug)) {
    return { kind: 'bad-name', docId: null, reason: 'The file name is not a valid slug (lowercase letters, digits and hyphens), so it cannot be a document. It is ignored.' };
  }
  let parsed;
  try {
    parsed = parseFrontMatter(await readDocFileText(config, file.fileName));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!parsed.ok) return { kind: 'unreadable', docId: null, reason: `Not a known document, and its front matter cannot be read. ${parsed.error} It is ignored.` };

  const { data } = parsed;
  const byId = data.id === undefined ? null : docsById.get(data.id);
  if (byId) {
    return { kind: 'duplicate-id', docId: byId.id, reason: `Rejected: it claims id ${byId.id}, which belongs to "${byId.slug}". The original stays live and this file is ignored.` };
  }
  const bySlug = cleanLine(data.slug) === '' ? null : docsBySlug.get(slugify(data.slug, { max: Infinity }));
  if (bySlug) {
    return { kind: 'duplicate-slug', docId: bySlug.id, reason: `Rejected: it claims the slug "${bySlug.slug}", which belongs to another document. The original stays live and this file is ignored.` };
  }
  return { kind: 'untracked', docId: null, reason: 'Not a known document. Documents are added by upload, so this file is ignored.' };
}

async function saveFileIssues(pool, issues, keepNames) {
  for (const issue of issues) {
    await pool.query(
      `INSERT INTO file_issues (file_name, kind, doc_id, reason) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), doc_id = VALUES(doc_id), reason = VALUES(reason)`,
      [issue.fileName, issue.kind, issue.docId, issue.reason],
    );
  }
  const names = [...issues.map((i) => i.fileName), ...keepNames];
  if (names.length === 0) await pool.query('DELETE FROM file_issues');
  else await pool.query('DELETE FROM file_issues WHERE file_name NOT IN (?)', [names]);
}

// ------------------------------------------------------------------- a scan

// One pass. trigger: 'startup', 'scheduled' or 'manual'. Resolves to
// { skipped: true } when a scan is already running, otherwise
// { seen, read, updated, flagged, deferred, issues, staged: { discarded, orphans } }.
export async function reconcile(pool, config, { trigger = 'scheduled' } = {}) {
  if (scanning) return { skipped: true };
  scanning = true;
  const started = Date.now();
  try {
    const files = await listDocFiles(config);
    const [docs] = await pool.query(
      `SELECT id, slug, title, published, summary, summary_edited, body_hash, file_size, file_mtime_ms, attention, attention_reason FROM docs`,
    );
    const tree = await loadTree(pool);
    const filesBySlug = new Map(files.map((f) => [f.slug, f]));
    const result = { seen: files.length, read: 0, updated: 0, flagged: 0, deferred: 0, issues: 0 };

    for (const doc of docs) {
      const file = filesBySlug.get(doc.slug);
      if (!file) {
        if (await setAttention(pool, doc, 'missing', MISSING_REASON)) result.flagged += 1;
        continue;
      }
      const unchanged = doc.attention === null && doc.file_size === file.size && Number(doc.file_mtime_ms) === file.mtimeMs;
      if (unchanged) continue;
      result.read += 1;
      const outcome = await syncDoc(pool, config, tree, doc, file);
      if (outcome === 'updated') result.updated += 1;
      if (outcome === 'flagged') result.flagged += 1;
    }

    const docsById = new Map(docs.map((d) => [d.id, d]));
    const docsBySlug = new Map(docs.map((d) => [d.slug, d]));
    const issues = [];
    const waiting = [];
    for (const file of files.filter((f) => !docsBySlug.has(f.slug))) {
      if (Date.now() - file.mtimeMs < NEW_FILE_SETTLE_MS) {
        waiting.push(file.fileName);
        continue;
      }
      result.read += 1;
      const issue = await judgeStrayFile(config, file, docsById, docsBySlug);
      if (issue === null) waiting.push(file.fileName);
      else issues.push({ fileName: file.fileName, ...issue });
    }
    result.deferred = waiting.length;
    result.issues = issues.length;
    await saveFileIssues(pool, issues, waiting);

    const staged = await cleanupStaged(pool, config);
    await pool.query(
      `UPDATE reconcile_state SET last_run_at = NOW(), last_trigger = ?, files_seen = ?, files_read = ?, docs_updated = ?, duration_ms = ? WHERE id = 1`,
      [trigger, result.seen, result.read, result.updated, Date.now() - started],
    );
    if (result.updated + result.flagged + result.issues > 0 || staged.discarded + staged.orphans > 0) {
      log.info('reconciliation scan', { trigger, ...result, stagedRemoved: staged.discarded + staged.orphans });
    }
    return { ...result, staged };
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------- reading

export async function getReconcileState(pool) {
  const [rows] = await pool.query('SELECT last_run_at, last_trigger, files_seen, files_read, docs_updated, duration_ms FROM reconcile_state WHERE id = 1');
  const row = rows[0];
  return {
    lastRunAt: row?.last_run_at ?? '',
    lastTrigger: row?.last_trigger ?? '',
    filesSeen: Number(row?.files_seen ?? 0),
    filesRead: Number(row?.files_read ?? 0),
    docsUpdated: Number(row?.docs_updated ?? 0),
    durationMs: Number(row?.duration_ms ?? 0),
  };
}

// Everything the Attention page lists: docs in a problem state, rejected files, and staged replacements.
export async function listAttention(pool) {
  const [docRows] = await pool.query(
    "SELECT id, slug, title, published, status, attention, attention_reason, attention_at FROM docs WHERE attention IS NOT NULL ORDER BY attention_at, id",
  );
  const [fileRows] = await pool.query('SELECT file_name, kind, doc_id, reason, detected_at FROM file_issues ORDER BY detected_at, file_name');
  return { docs: docRows, files: fileRows };
}

export async function countAttention(pool) {
  const [[{ docs }]] = await pool.query('SELECT COUNT(*) AS docs FROM docs WHERE attention IS NOT NULL');
  const [[{ files }]] = await pool.query('SELECT COUNT(*) AS files FROM file_issues');
  return { docs: Number(docs), files: Number(files), total: Number(docs) + Number(files) };
}

// ----------------------------------------------------------------- schedule

// Startup scan, then one every RECONCILE_INTERVAL_MINUTES. A failure is logged and
// the app carries on (a database that is behind shows on the status page).
export function createReconciler({ pool, config }) {
  let timer = null;

  async function run(trigger) {
    try {
      await reconcile(pool, config, { trigger });
    } catch (err) {
      log.warn('reconciliation scan failed', errorFields(err));
    }
  }

  return {
    async start() {
      await run('startup');
      timer = setInterval(() => run('scheduled'), config.worker.reconcileIntervalMinutes * 60 * 1000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
