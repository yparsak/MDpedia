// Documents: the `docs` table and the lifecycle around it.
// The file is canonical and the table is a derived index, so every change writes
// the file first (see docfiles.js) and then updates the row.
//
// The states: a new upload is "uploaded" and waits in the AI queue, "processing"
// while the AI runs, then "ready" (ready for review), or "failed" when the job
// gave up. With the AI not configured an upload skips the queue and is "ready"
// at once. Publishing makes a doc "published", unpublishing "unpublished".
// There is no delete in v1.

import { bodyHash, serializeFrontMatter } from './frontmatter.js';
import { createDocFile, removeDocFile, updateDocFile } from './docfiles.js';
import { enqueueEmbedding } from './embed-queue.js';
import { enqueueJob } from './jobs.js';
import { emptyTerms, insertTerms, termsToFrontMatter } from './search-terms.js';
import { insertLinks, renderWithLinks, rerenderDependents } from './wiki-links.js';

export const STATUS_LABELS = {
  uploaded: 'Uploaded',
  processing: 'Processing',
  ready: 'Ready for review',
  failed: 'Failed',
  published: 'Published',
  unpublished: 'Unpublished',
};

const LIST_COLUMNS =
  'id, slug, title, status, published, summary, summary_edited, has_raw_html, size_bytes, attention, created_at, updated_at, published_at';

// ------------------------------------------------------------------ reading

export async function getDocById(pool, id) {
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS}, body_hash, html, ai_provider, ai_model, ai_prompt_version, ai_at,
            attention_reason, staged_at, staged_status, staged_hash, staged_size FROM docs WHERE id = ?`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getPublishedById(pool, id) {
  const [rows] = await pool.query(`SELECT ${LIST_COLUMNS}, html FROM docs WHERE id = ? AND published = 1`, [id]);
  return rows[0] ?? null;
}

export async function getPublishedBySlug(pool, slug) {
  const [rows] = await pool.query(`SELECT ${LIST_COLUMNS}, html FROM docs WHERE slug = ? AND published = 1`, [slug]);
  return rows[0] ?? null;
}

export async function slugTaken(pool, slug) {
  const [rows] = await pool.query('SELECT 1 FROM docs WHERE slug = ? LIMIT 1', [slug]);
  return rows.length > 0;
}

// status: one of the keys of STATUS_LABELS, or null for every doc. Newest first.
export async function listDocs(pool, { status = null, limit, offset }) {
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM docs ${where}`, params);
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM docs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { total: Number(total), rows };
}

// The docs awaiting review ("ready"), oldest first. ids: only these, or null for all of them.
// For bulk approval, which has to look at the whole queue, not a page of it.
export async function getReadyDocs(pool, ids = null) {
  if (ids !== null && ids.length === 0) return [];
  const where = ids === null ? '' : 'AND id IN (?)';
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM docs WHERE status = 'ready' ${where} ORDER BY id`,
    ids === null ? [] : [ids],
  );
  return rows;
}

// Reader home page: published docs, alphabetical.
export async function listPublished(pool, { limit, offset }) {
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM docs WHERE published = 1');
  const [rows] = await pool.query(
    'SELECT id, slug, title, summary FROM docs WHERE published = 1 ORDER BY title, id LIMIT ? OFFSET ?',
    [limit, offset],
  );
  return { total: Number(total), rows };
}

// { total, uploaded, processing, ready, failed, published, unpublished } in one query.
export async function countByStatus(pool) {
  const [rows] = await pool.query('SELECT status, COUNT(*) AS n FROM docs GROUP BY status');
  const counts = { total: 0, uploaded: 0, processing: 0, ready: 0, failed: 0, published: 0, unpublished: 0 };
  for (const { status, n } of rows) {
    counts.total += Number(n);
    if (Object.hasOwn(counts, status)) counts[status] = Number(n);
  }
  return counts;
}

// ----------------------------------------------------------------- creating

// Inserts the row, writes the file, then commits. If either step fails the
// other is undone, so a doc never exists in only one place. Throws ER_DUP_ENTRY
// (slug taken in the table) or EEXIST (a file with that name is already in the
// docs directory); the caller turns both into "slug taken". Resolves to the new id.
// queue: true starts the doc as "uploaded" with an AI job, in the same transaction.
// categoryIds (already matched against the tree) are filed at once and written to the
// front matter; proposals ({ name, parentId, sourceValue }) wait in category_proposals.
export async function createDoc(
  pool,
  config,
  { slug, title, summary, extraFrontMatter, terms = emptyTerms(), body, rendered, queue = false, categoryIds = [], proposals = [], sizeBytes = null },
) {
  const hash = bodyHash(body);
  const conn = await pool.getConnection();
  let fileWritten = false;
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO docs (slug, title, status, published, summary, summary_edited, has_raw_html, body_hash, html, plain_text, size_bytes)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [slug, title, queue ? 'uploaded' : 'ready', summary, summary ? 1 : 0, rendered.hasRawHtml ? 1 : 0, hash, rendered.html, rendered.plainText, sizeBytes],
    );
    const id = result.insertId;
    await insertTerms(conn, id, terms);
    await insertLinks(conn, id, rendered.linkTargets);
    if (categoryIds.length > 0) {
      await conn.query('INSERT INTO doc_categories (doc_id, category_id, position) VALUES ?', [
        categoryIds.map((categoryId, index) => [id, categoryId, index + 1]),
      ]);
    }
    if (proposals.length > 0) {
      await conn.query("INSERT INTO category_proposals (doc_id, parent_id, name, source, source_value) VALUES ?", [
        proposals.map((p) => [id, p.parentId, p.name, 'file', p.sourceValue]),
      ]);
    }
    if (queue) await enqueueJob(conn, id);
    const text = serializeFrontMatter(
      {
        ...extraFrontMatter,
        id,
        slug,
        title,
        published: false,
        categories: categoryIds.length > 0 ? categoryIds : undefined,
        summary: summary || undefined,
        summary_edited: summary ? true : undefined,
        ...termsToFrontMatter(terms),
      },
      body,
    );
    await createDocFile(config, { slug, text, expectedHash: hash });
    fileWritten = true;
    await conn.commit();
    return id;
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (fileWritten) await removeDocFile(config, slug).catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ----------------------------------------------------------------- changing

// Publish, re-publish and unpublish. The front matter flag changes first so a
// database rebuild keeps the state. Docs that link here are
// rendered again, since their links to this one work only while it is published.
export async function setPublished(pool, config, doc, published) {
  await updateDocFile(config, doc.slug, (data) => ({ ...data, published }));
  if (published) {
    await pool.query("UPDATE docs SET published = 1, status = 'published', published_at = NOW() WHERE id = ?", [doc.id]);
  } else {
    await pool.query("UPDATE docs SET published = 0, status = 'unpublished' WHERE id = ?", [doc.id]);
  }
  await rerenderDependents(pool, config, doc);
  if (published) await enqueueEmbedding(pool, config, doc.id);
}

// The slug never changes. The page is rendered again because a first heading
// that repeated the old title is dropped only while it matches the title. A
// published doc's title is the text of the links that name no display text, so
// the docs that link here are rendered again too.
export async function setTitle(pool, config, doc, title) {
  const { body } = await updateDocFile(config, doc.slug, (data) => ({ ...data, title }));
  const rendered = await renderWithLinks(pool, body, title);
  await pool.query(
    'UPDATE docs SET title = ?, html = ?, plain_text = ?, has_raw_html = ?, body_hash = ? WHERE id = ?',
    [title, rendered.html, rendered.plainText, rendered.hasRawHtml ? 1 : 0, bodyHash(body), doc.id],
  );
  if (doc.published) await rerenderDependents(pool, config, doc);
  await enqueueEmbedding(pool, config, doc.id);
}

// A saved summary is flagged as hand-edited; an empty one clears the summary and the flag.
export async function setSummary(pool, config, doc, summary) {
  await updateDocFile(config, doc.slug, (data) => ({
    ...data,
    summary: summary || undefined,
    summary_edited: summary ? true : undefined,
  }));
  await pool.query('UPDATE docs SET summary = ?, summary_edited = ? WHERE id = ?', [summary || null, summary ? 1 : 0, doc.id]);
  await enqueueEmbedding(pool, config, doc.id);
}
