// Which categories a doc is filed under (brainstorm 5.4). Up to three, in order:
// the first is the primary one (breadcrumb and canonical URL). The file is
// canonical, so a change writes the front matter `categories` list of ids first
// and then replaces the rows, the same order docs.js uses.

import { updateDocFile } from './docfiles.js';

export const MAX_DOC_CATEGORIES = 3;

// The ordered ids for one doc.
export async function getDocCategoryIds(pool, docId) {
  const [rows] = await pool.query('SELECT category_id FROM doc_categories WHERE doc_id = ? ORDER BY position', [docId]);
  return rows.map((r) => r.category_id);
}

// Map(doc id -> ordered category ids) for a page of docs, in one query.
export async function categoryIdsForDocs(pool, docIds) {
  const map = new Map(docIds.map((id) => [id, []]));
  if (docIds.length === 0) return map;
  const [rows] = await pool.query(
    'SELECT doc_id, category_id FROM doc_categories WHERE doc_id IN (?) ORDER BY doc_id, position',
    [docIds],
  );
  for (const { doc_id: docId, category_id: categoryId } of rows) map.get(docId).push(categoryId);
  return map;
}

// { ok: true } or { ok: false, errors }. The ids must be distinct, exist in the
// tree, and be at most three.
export function checkCategoryIds(ids, tree) {
  if (ids.length > MAX_DOC_CATEGORIES) {
    return { ok: false, errors: [`A document can be in at most ${MAX_DOC_CATEGORIES} categories.`] };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, errors: ['A category can be listed only once.'] };
  if (ids.some((id) => !tree.byId.has(id))) return { ok: false, errors: ['That category does not exist.'] };
  return { ok: true };
}

// Replaces the doc's categories with the ordered list `ids` (already checked).
// Throws like updateDocFile if the file is missing or cannot be parsed.
export async function setDocCategories(pool, config, doc, ids) {
  await updateDocFile(config, doc.slug, (data) => ({ ...data, categories: ids.length > 0 ? ids : undefined }));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM doc_categories WHERE doc_id = ?', [doc.id]);
    for (const [index, categoryId] of ids.entries()) {
      await conn.query('INSERT INTO doc_categories (doc_id, category_id, position) VALUES (?, ?, ?)', [
        doc.id,
        categoryId,
        index + 1,
      ]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Published docs filed directly in one category, alphabetical (brainstorm 5.4).
export async function listPublishedInCategory(pool, categoryId, { limit, offset }) {
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM doc_categories dc JOIN docs d ON d.id = dc.doc_id
      WHERE dc.category_id = ? AND d.published = 1`,
    [categoryId],
  );
  const [rows] = await pool.query(
    `SELECT d.id, d.slug, d.title, d.summary FROM doc_categories dc JOIN docs d ON d.id = dc.doc_id
      WHERE dc.category_id = ? AND d.published = 1 ORDER BY d.title, d.id LIMIT ? OFFSET ?`,
    [categoryId, limit, offset],
  );
  return { total: Number(total), rows };
}
