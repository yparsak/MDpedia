// Categories: the tree, its editing rules and the reader-side counts
// (brainstorm 5.4). An adjacency list in `categories`, at most three levels deep.
// The URL path is derived from the slugs on every request, never stored, so a
// rename or move changes no file and no row besides the category itself.
//
// The tree is small (tens of nodes), so it is read whole and handled in memory
// instead of with a recursive query per request.

import { SLUG_MAX, SLUG_PATTERN, slugify } from '../public/js/slug.js';
import { cleanLine } from './upload.js';

export const MAX_DEPTH = 3;
export const NAME_MAX = 100;

const fail = (...errors) => ({ ok: false, errors });

// ------------------------------------------------------- pure tree helpers

const byOrder = (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id - b.id;

// rows: { id, parent_id, name, slug, sort_order }. Resolves to
// { byId: Map, roots: [], nodes: [] } where nodes are in display order (parents
// before children). A row that cannot be reached from a root is left out.
export function buildTree(rows) {
  const byId = new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, parentId: r.parent_id, name: r.name, slug: r.slug, sortOrder: r.sort_order, children: [], parent: null, depth: 0, path: '' },
    ]),
  );
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (node.parentId === null) roots.push(node);
    else if (parent) parent.children.push(node);
  }

  const nodes = [];
  const visit = (node, parent) => {
    node.parent = parent;
    node.depth = parent ? parent.depth + 1 : 1;
    node.path = parent ? `${parent.path}/${node.slug}` : node.slug;
    node.children.sort(byOrder);
    nodes.push(node);
    node.children.forEach((child) => visit(child, node));
  };
  roots.sort(byOrder);
  roots.forEach((root) => visit(root, null));
  return { byId, roots, nodes };
}

// The node and everything below it, as a list.
export function subtreeOf(node) {
  return [node, ...node.children.flatMap(subtreeOf)];
}

// Number of levels from this node down, itself included: a leaf is 1.
export const heightOf = (node) => 1 + Math.max(0, ...node.children.map(heightOf));

// Root first, the node last.
export function chainOf(node) {
  const chain = [];
  for (let n = node; n; n = n.parent) chain.unshift(n);
  return chain;
}

// Slugs are compared in lowercase: the column collation ignores case too.
export function findByPath(tree, segments) {
  let level = tree.roots;
  let found = null;
  for (const segment of segments) {
    found = level.find((n) => n.slug.toLowerCase() === segment) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
}

export const categoryUrl = (node) => `/category/${node.path}`;

// `math/calculus/limits`, or just `limits` for a doc with no category.
export const docPath = (primary, slug) => (primary ? `${primary.path}/${slug}` : slug);

// "Math > Calculus"
export const pathLabel = (node) => chainOf(node).map((n) => n.name).join(' > ');

// ------------------------------------------------------------------ reading

export async function loadTree(pool) {
  const [rows] = await pool.query('SELECT id, parent_id, name, slug, sort_order FROM categories');
  return buildTree(rows);
}

// Docs filed directly in each category, in every state: Map(category id -> n).
export async function directDocCounts(pool) {
  const [rows] = await pool.query('SELECT category_id, COUNT(*) AS n FROM doc_categories GROUP BY category_id');
  return new Map(rows.map((r) => [r.category_id, Number(r.n)]));
}

// Published docs per category, counting the whole subtree and each doc once
// even if it sits in two categories of the same subtree: Map(category id -> n).
// Only published docs count, so an unpublished doc never shows in a reader count.
export async function publishedSubtreeCounts(pool, tree) {
  const [rows] = await pool.query(
    'SELECT dc.category_id, dc.doc_id FROM doc_categories dc JOIN docs d ON d.id = dc.doc_id WHERE d.published = 1',
  );
  const direct = new Map();
  for (const { category_id: categoryId, doc_id: docId } of rows) {
    if (!direct.has(categoryId)) direct.set(categoryId, new Set());
    direct.get(categoryId).add(docId);
  }
  const counts = new Map();
  for (const node of tree.nodes) {
    const docs = new Set();
    for (const member of subtreeOf(node)) for (const docId of direct.get(member.id) ?? []) docs.add(docId);
    counts.set(node.id, docs.size);
  }
  return counts;
}

// For the dashboard card.
export async function categoryStats(pool) {
  const [[{ categories }]] = await pool.query('SELECT COUNT(*) AS categories FROM categories');
  const [[{ uncategorized }]] = await pool.query(
    'SELECT COUNT(*) AS uncategorized FROM docs d WHERE NOT EXISTS (SELECT 1 FROM doc_categories dc WHERE dc.doc_id = d.id)',
  );
  return { categories: Number(categories), uncategorized: Number(uncategorized) };
}

// ----------------------------------------------------------------- validating

// { ok: true, name } or { ok: false, errors }
export function checkName(value) {
  const name = cleanLine(value);
  if (name === '') return fail('A name is required.');
  if (name.length > NAME_MAX) return fail(`The name is longer than ${NAME_MAX} characters.`);
  return { ok: true, name };
}

// A typed slug is normalised and checked; one that is too long is refused rather
// than cut. An empty one is made from the name. { ok: true, slug } or { ok: false, errors }
export function checkSlug(value, name) {
  const typed = cleanLine(value);
  const slug = typed === '' ? slugify(name) : slugify(typed, { max: Infinity });
  if (slug === '') return fail('A slug could not be made from this name. Type one in the slug field.');
  if (slug.length > SLUG_MAX) return fail(`The slug is longer than ${SLUG_MAX} characters.`);
  if (!SLUG_PATTERN.test(slug)) return fail('The slug may only use lowercase letters, digits and hyphens.');
  return { ok: true, slug };
}

const siblingsOf = (tree, parent) => (parent ? parent.children : tree.roots);

const slugTakenAmong = (siblings, slug, exceptId = null) =>
  siblings.some((s) => s.id !== exceptId && s.slug.toLowerCase() === slug.toLowerCase());

const slugTakenResult = (slug) => fail(`The slug "${slug}" is already used by a sibling category.`);

const nextSortOrder = (siblings) => Math.max(0, ...siblings.map((s) => s.sortOrder)) + 1;

// ------------------------------------------------------------------ changing
// Each change returns { ok: true, ... } or { ok: false, errors } with sentences
// for the admin. Tree rules are checked against a fresh read of the tree.

export async function createCategory(pool, { name, slug, parentId }) {
  const tree = await loadTree(pool);
  const parent = parentId === null ? null : tree.byId.get(parentId);
  if (parentId !== null && !parent) return fail('The parent category does not exist.');
  if ((parent ? parent.depth : 0) + 1 > MAX_DEPTH) return fail(`Categories can be at most ${MAX_DEPTH} levels deep.`);
  const siblings = siblingsOf(tree, parent);
  if (slugTakenAmong(siblings, slug)) return slugTakenResult(slug);

  try {
    const [result] = await pool.query(
      'INSERT INTO categories (parent_id, name, slug, sort_order) VALUES (?, ?, ?, ?)',
      [parentId, name, slug, nextSortOrder(siblings)],
    );
    return { ok: true, id: result.insertId };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return slugTakenResult(slug);
    throw err;
  }
}

// Display name and slug. Changing the slug changes the URLs of the category and
// everything under it; the doc pages redirect from the old ones.
export async function updateCategory(pool, id, { name, slug }) {
  const tree = await loadTree(pool);
  const node = tree.byId.get(id);
  if (!node) return fail('The category does not exist.');
  if (slugTakenAmong(siblingsOf(tree, node.parent), slug, node.id)) return slugTakenResult(slug);

  try {
    await pool.query('UPDATE categories SET name = ?, slug = ? WHERE id = ?', [name, slug, id]);
    return { ok: true, changed: name !== node.name || slug !== node.slug, slugChanged: slug !== node.slug };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return slugTakenResult(slug);
    throw err;
  }
}

// Moves a category (and its subtree) under another parent, or to the top level
// when newParentId is null. It goes to the end of the new siblings.
export async function moveCategory(pool, id, newParentId) {
  const tree = await loadTree(pool);
  const node = tree.byId.get(id);
  if (!node) return fail('The category does not exist.');
  const newParent = newParentId === null ? null : tree.byId.get(newParentId);
  if (newParentId !== null && !newParent) return fail('The new parent category does not exist.');
  if (newParentId === node.parentId) return { ok: true, changed: false };

  if (newParent && subtreeOf(node).some((n) => n.id === newParent.id)) {
    return fail('A category cannot be moved under itself or one of its own subcategories.');
  }
  if ((newParent ? newParent.depth : 0) + heightOf(node) > MAX_DEPTH) {
    return fail(`The move would make the tree more than ${MAX_DEPTH} levels deep.`);
  }
  const siblings = siblingsOf(tree, newParent);
  if (slugTakenAmong(siblings, node.slug)) {
    return fail(`The new parent already has a category with the slug "${node.slug}". Change the slug first.`);
  }

  try {
    await pool.query('UPDATE categories SET parent_id = ?, sort_order = ? WHERE id = ?', [
      newParentId,
      nextSortOrder(siblings),
      id,
    ]);
    return { ok: true, changed: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return slugTakenResult(node.slug);
    throw err;
  }
}

// direction: 'up' or 'down' among the siblings. The siblings are renumbered
// 1..n, so equal or gappy sort orders cannot make a button do nothing.
export async function reorderCategory(pool, id, direction) {
  const tree = await loadTree(pool);
  const node = tree.byId.get(id);
  if (!node) return fail('The category does not exist.');

  const siblings = [...siblingsOf(tree, node.parent)];
  const from = siblings.findIndex((s) => s.id === id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= siblings.length) return { ok: true, changed: false };
  [siblings[from], siblings[to]] = [siblings[to], siblings[from]];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [index, sibling] of siblings.entries()) {
      await conn.query('UPDATE categories SET sort_order = ? WHERE id = ?', [index + 1, sibling.id]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return { ok: true, changed: true };
}

// Only an empty category can go: no subcategories and no docs in any state
// (published, ready or unpublished), or those docs would point at a missing id.
export async function deleteCategory(pool, id) {
  const tree = await loadTree(pool);
  const node = tree.byId.get(id);
  if (!node) return fail('The category does not exist.');
  if (node.children.length > 0) {
    return fail('This category has subcategories. Move or delete them first.');
  }
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM doc_categories WHERE category_id = ?', [id]);
  if (Number(n) > 0) return docsBlockDelete(Number(n));

  try {
    await pool.query('DELETE FROM categories WHERE id = ?', [id]);
    return { ok: true, slug: node.slug };
  } catch (err) {
    // A doc was filed here between the check and the delete.
    if (err.code === 'ER_ROW_IS_REFERENCED_2') return docsBlockDelete(1);
    throw err;
  }
}

const docsBlockDelete = (count) =>
  fail(
    `This category holds ${count} document${count === 1 ? '' : 's'} (published or not). Remove ${count === 1 ? 'it' : 'them'} from the category first.`,
  );
