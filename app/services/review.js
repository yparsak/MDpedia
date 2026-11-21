// The approval gate (brainstorm 5.10, roadmap Phase 7). Nothing reaches readers
// until the admin approves it: approving writes the categories and the `published`
// flag to the front matter and publishes the doc. This module holds the pending
// category proposals, the exceptions that hold a doc back from bulk approval, and
// the approve steps. It builds on docs.js, doc-categories.js and search-terms.js,
// so every write keeps their order: the file first, then the database.

import { MAX_DEPTH, checkName, checkSlug, createCategory } from './categories.js';
import { exportCategories } from './categories-export.js';
import { MAX_DOC_CATEGORIES, getDocCategoryIds, setDocCategories } from './doc-categories.js';
import { DocFileError } from './docfiles.js';
import { enqueueEmbedding } from './embed-queue.js';
import { setPublished } from './docs.js';

// ---------------------------------------------------------------- proposals

export async function countPendingProposals(pool) {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM category_proposals WHERE status = 'pending'");
  return Number(n);
}

// Every pending proposal with the doc it came from, oldest first (the review queue).
export async function listPendingProposals(pool, { limit, offset }) {
  const total = await countPendingProposals(pool);
  const [rows] = await pool.query(
    `SELECT p.id, p.doc_id, p.parent_id, p.name, p.source, p.source_value, d.title AS doc_title
       FROM category_proposals p JOIN docs d ON d.id = p.doc_id
      WHERE p.status = 'pending' ORDER BY p.id LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return { total, rows };
}

// One doc's pending proposals, for its review screen.
export async function getPendingProposals(pool, docId) {
  const [rows] = await pool.query(
    "SELECT id, parent_id, name, source, source_value FROM category_proposals WHERE doc_id = ? AND status = 'pending' ORDER BY id",
    [docId],
  );
  return rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, source: r.source, sourceValue: r.source_value ?? '' }));
}

const setProposalStatus = (pool, id, status) =>
  pool.query("UPDATE category_proposals SET status = ? WHERE id = ? AND status = 'pending'", [status, id]);

// The ids the review screen starts from: the doc's categories when it has any (a file's
// `categories:` line files it at upload), otherwise the AI's suggestions, best first.
export async function reviewCategoryIds(pool, docId, tree) {
  const current = await getDocCategoryIds(pool, docId);
  if (current.length > 0) return current;
  const [rows] = await pool.query('SELECT category_id FROM doc_category_suggestions WHERE doc_id = ? ORDER BY position', [docId]);
  return rows.map((r) => r.category_id).filter((id) => tree.byId.has(id)).slice(0, MAX_DOC_CATEGORIES);
}

// decisions: [{ id, action: 'accept' | 'reject' | 'keep', name }], one per pending proposal.
// Accepting makes the category (or, when a sibling already has that slug, uses it, so two
// docs proposing the same name share one category) and resolves to the ids to file the doc
// under. Everything is checked before the first category is made.
// { ok: true, categoryIds } or { ok: false, errors }.
export async function acceptProposals(pool, config, tree, proposals, decisions) {
  const errors = [];
  const plans = [];
  for (const decision of decisions) {
    const proposal = proposals.find((p) => p.id === decision.id);
    if (!proposal || decision.action !== 'accept') continue;
    const parent = proposal.parentId === null ? null : tree.byId.get(proposal.parentId);
    if (proposal.parentId !== null && !parent) {
      errors.push(`The parent category of the proposal "${proposal.name}" no longer exists. Reject the proposal.`);
      continue;
    }
    if ((parent ? parent.depth : 0) + 1 > MAX_DEPTH) {
      errors.push(`The proposal "${proposal.name}" would make the tree more than ${MAX_DEPTH} levels deep.`);
      continue;
    }
    const name = checkName(decision.name);
    const slug = name.ok ? checkSlug('', name.name) : name;
    if (!name.ok || !slug.ok) {
      errors.push(`Proposal "${proposal.name}": ${(name.ok ? slug : name).errors[0]}`);
      continue;
    }
    plans.push({ proposal, parent, name: name.name, slug: slug.slug });
  }
  if (errors.length > 0) return { ok: false, errors };

  const categoryIds = [];
  let created = false;
  for (const plan of plans) {
    const siblings = plan.parent ? plan.parent.children : tree.roots;
    const existing = siblings.find((s) => s.slug.toLowerCase() === plan.slug.toLowerCase());
    if (existing) {
      categoryIds.push(existing.id);
    } else {
      const result = await createCategory(pool, { name: plan.name, slug: plan.slug, parentId: plan.parent ? plan.parent.id : null });
      if (!result.ok) return { ok: false, errors: result.errors };
      categoryIds.push(result.id);
      created = true;
    }
    await setProposalStatus(pool, plan.proposal.id, 'accepted');
  }
  // categories.yaml follows the tree; a failed export is logged and never undoes the change.
  if (created) await exportCategories(pool, config);
  return { ok: true, categoryIds };
}

export async function rejectProposals(pool, proposals, decisions) {
  for (const decision of decisions) {
    if (decision.action === 'reject' && proposals.some((p) => p.id === decision.id)) await setProposalStatus(pool, decision.id, 'rejected');
  }
}

// ------------------------------------------------------------------ approval

// Publishes the doc and stamps approved_at. The categories, summary and keywords
// are saved by the caller first.
export async function approveDoc(pool, config, doc) {
  if (!doc.published) await setPublished(pool, config, doc, true);
  await pool.query('UPDATE docs SET approved_at = NOW() WHERE id = ?', [doc.id]);
  // The summary and keywords were saved before this; the vector is made from them.
  await enqueueEmbedding(pool, config, doc.id);
}

// ---------------------------------------------------------------- exceptions

// Why a doc is held back from bulk approval, for a list of doc rows (docs.js
// LIST_COLUMNS). Resolves to Map(doc id -> [{ kind, text, targetIds }]):
//   proposals  a category proposal is still pending (a `categories:` value that matched nothing, or the AI's)
//   links      a [[link]] points at a doc that is missing or not published (targetIds: those docs, null for a missing one)
//   raw-html   the file holds raw HTML, which is shown as text
//   oversize   the file is over MAX_UPLOAD_BYTES
export async function findExceptions(pool, config, docs) {
  const found = new Map(docs.map((d) => [d.id, []]));
  if (docs.length === 0) return found;
  const ids = docs.map((d) => d.id);

  const [proposalRows] = await pool.query(
    "SELECT doc_id, COUNT(*) AS n FROM category_proposals WHERE status = 'pending' AND doc_id IN (?) GROUP BY doc_id",
    [ids],
  );
  for (const { doc_id: docId, n } of proposalRows) {
    found.get(docId).push({ kind: 'proposals', text: `${n} category proposal${Number(n) === 1 ? '' : 's'} not decided`, targetIds: [] });
  }

  const [linkRows] = await pool.query(
    `SELECT l.source_doc_id, l.target_slug, t.id AS target_id
       FROM doc_links l LEFT JOIN docs t ON t.slug = l.target_slug
      WHERE l.source_doc_id IN (?) AND (t.id IS NULL OR t.published = 0) ORDER BY l.target_slug`,
    [ids],
  );
  const links = new Map();
  for (const row of linkRows) {
    if (!links.has(row.source_doc_id)) links.set(row.source_doc_id, []);
    links.get(row.source_doc_id).push(row);
  }
  for (const [docId, rows] of links) {
    found.get(docId).push({
      kind: 'links',
      text: `unresolved link${rows.length === 1 ? '' : 's'}: ${rows.map((r) => r.target_slug).join(', ')}`,
      targetIds: rows.map((r) => r.target_id),
    });
  }

  for (const doc of docs) {
    if (doc.has_raw_html) found.get(doc.id).push({ kind: 'raw-html', text: 'contains raw HTML', targetIds: [] });
    if (doc.size_bytes !== null && doc.size_bytes > config.uploads.maxBytes) {
      found.get(doc.id).push({ kind: 'oversize', text: `file is ${doc.size_bytes} bytes, over the ${config.uploads.maxBytes} byte limit`, targetIds: [] });
    }
  }
  return found;
}

// Splits candidate docs (status "ready") into those a bulk approve may publish and
// those held back with their reasons. A doc whose only exception is a link to
// another doc in the same approval set is not held back: that link works once the set is published.
// Resolves to { approve: [doc], held: [{ doc, reasons: [text] }] }.
export async function planBulkApproval(pool, config, docs) {
  const exceptions = await findExceptions(pool, config, docs);
  const hasHard = (doc) => exceptions.get(doc.id).some((e) => e.kind !== 'links');
  let approve = docs.filter((doc) => !hasHard(doc));
  for (;;) {
    const inSet = new Set(approve.map((doc) => doc.id));
    const next = approve.filter((doc) =>
      exceptions.get(doc.id).every((e) => e.kind !== 'links' || e.targetIds.every((id) => id !== null && inSet.has(id))),
    );
    if (next.length === approve.length) break;
    approve = next;
  }
  const approved = new Set(approve.map((doc) => doc.id));
  return {
    approve,
    held: docs.filter((doc) => !approved.has(doc.id)).map((doc) => ({ doc, reasons: exceptions.get(doc.id).map((e) => e.text) })),
  };
}

// Approves docs without a review screen: each keeps its categories, or takes the AI's
// suggestions when it has none. Resolves to { approved: n, failed: [{ doc, reason }] }; a file
// problem on one doc does not stop the rest.
export async function approveMany(pool, config, docs, tree) {
  let approved = 0;
  const failed = [];
  for (const doc of docs) {
    try {
      if ((await getDocCategoryIds(pool, doc.id)).length === 0) {
        const suggested = await reviewCategoryIds(pool, doc.id, tree);
        if (suggested.length > 0) await setDocCategories(pool, config, doc, suggested);
      }
      await approveDoc(pool, config, doc);
      approved += 1;
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof DocFileError)) throw err;
      failed.push({ doc, reason: err.code === 'ENOENT' ? 'the file is missing from the docs directory' : err.message });
    }
  }
  return { approved, failed };
}
