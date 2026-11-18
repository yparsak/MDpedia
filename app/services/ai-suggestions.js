// What the AI suggested for a doc and nobody has accepted yet (brainstorm 5.4):
// an ordered list of existing categories and proposals for new ones. Both are
// only stored. doc_categories changes when the admin changes it, and a proposal
// becomes a category only when the admin accepts it (the review screens arrive
// in Phase 7).

import { pathLabel } from './categories.js';

// On a connection (a transaction of the caller's). Replaces the doc's earlier
// suggestions and its pending AI proposals; accepted and rejected proposals are history.
export async function replaceSuggestions(conn, docId, categoryIds, proposals) {
  await conn.query('DELETE FROM doc_category_suggestions WHERE doc_id = ?', [docId]);
  await conn.query("DELETE FROM category_proposals WHERE doc_id = ? AND source = 'ai' AND status = 'pending'", [docId]);
  if (categoryIds.length > 0) {
    await conn.query('INSERT INTO doc_category_suggestions (doc_id, category_id, position) VALUES ?', [
      categoryIds.map((categoryId, index) => [docId, categoryId, index + 1]),
    ]);
  }
  if (proposals.length > 0) {
    await conn.query("INSERT INTO category_proposals (doc_id, parent_id, name, source) VALUES ?", [
      proposals.map((p) => [docId, p.parentId, p.name, 'ai']),
    ]);
  }
}

// { categories: [label], proposals: [{ name, parentLabel }] } for the doc page.
export async function getSuggestions(pool, docId, tree) {
  const [categoryRows] = await pool.query('SELECT category_id FROM doc_category_suggestions WHERE doc_id = ? ORDER BY position', [docId]);
  const [proposalRows] = await pool.query(
    "SELECT parent_id, name FROM category_proposals WHERE doc_id = ? AND status = 'pending' ORDER BY id",
    [docId],
  );
  return {
    categories: categoryRows.map((r) => tree.byId.get(r.category_id)).filter(Boolean).map(pathLabel),
    proposals: proposalRows.map((r) => ({
      name: r.name,
      parentLabel: r.parent_id !== null && tree.byId.has(r.parent_id) ? pathLabel(tree.byId.get(r.parent_id)) : '',
    })),
  };
}
