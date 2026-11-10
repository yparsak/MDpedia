// Wiki links between docs (brainstorm 5.9). The HTML of a doc is rendered once
// and stored, so a [[link]] is drawn as it stands at that moment: a working
// anchor when the target is published, a marked dead span otherwise. When the
// target is published, unpublished or retitled, the docs that link to it are
// rendered again here, during the request, up to MAX_DEPENDENTS of them.
//
// The doc_links table holds the normalised targets of each doc and nothing
// else. Slugs are unique and permanent, so docs.slug is the join: a forward
// reference starts to resolve as soon as a doc with that slug exists.

import { log, errorFields } from '../logger.js';
import { readDocFile } from './docfiles.js';
import { renderMarkdown } from './markdown.js';

export const MAX_DEPENDENTS = 200;
export const BACKLINK_LIMIT = 50;

// The lookup renderMarkdown calls with the targets it found. Resolves to
// Map(slug -> { id, title, published }), with no entry for a slug no doc has.
export function linkResolver(pool) {
  return async (slugs) => {
    const [rows] = await pool.query('SELECT id, slug, title, published FROM docs WHERE slug IN (?)', [slugs]);
    return new Map(rows.map((r) => [r.slug, { id: r.id, title: r.title, published: Boolean(r.published) }]));
  };
}

export const renderWithLinks = (pool, body, title) => renderMarkdown(body, { title, resolveLinks: linkResolver(pool) });

// Records a new doc's targets on a connection (a transaction of the caller's).
export async function insertLinks(conn, docId, targets) {
  if (targets.length === 0) return;
  await conn.query('INSERT IGNORE INTO doc_links (source_doc_id, target_slug) VALUES ?', [targets.map((target) => [docId, target])]);
}

// ------------------------------------------------------------ re-rendering

async function rerenderOne(pool, config, dependent) {
  try {
    const { body } = await readDocFile(config, dependent.slug);
    const { html } = await renderWithLinks(pool, body, dependent.title);
    // updated_at = updated_at: a re-render is not an edit, so "last updated" stays.
    await pool.query('UPDATE docs SET html = ?, updated_at = updated_at WHERE id = ?', [html, dependent.id]);
  } catch (err) {
    log.warn('could not re-render a doc that links here', { slug: dependent.slug, ...errorFields(err) });
  }
}

// Renders again every doc whose [[links]] point at `doc` (a doc itself included,
// if it links to itself). Never throws: the change that called it has already
// been saved, and a failure here is logged and leaves the old HTML in place.
// Creating a doc needs no call: a new doc is unpublished, which draws links the
// same way as no doc at all.
export async function rerenderDependents(pool, config, doc) {
  try {
    const [rows] = await pool.query(
      `SELECT d.id, d.slug, d.title FROM doc_links l JOIN docs d ON d.id = l.source_doc_id
        WHERE l.target_slug = ? ORDER BY d.id LIMIT ?`,
      [doc.slug, MAX_DEPENDENTS + 1],
    );
    if (rows.length > MAX_DEPENDENTS) {
      log.warn('too many docs link here; the rest keep their old links', { slug: doc.slug, cap: MAX_DEPENDENTS });
    }
    for (const dependent of rows.slice(0, MAX_DEPENDENTS)) await rerenderOne(pool, config, dependent);
  } catch (err) {
    log.error('could not re-render the docs that link here', { slug: doc.slug, ...errorFields(err) });
  }
}

// ----------------------------------------------------------------- reading

// "What links here" for readers: published docs that link to this one, never
// the doc itself. Rows are shaped for docLinks().
export async function getBacklinks(pool, doc) {
  const [rows] = await pool.query(
    `SELECT d.id, d.slug, d.title, d.summary FROM doc_links l JOIN docs d ON d.id = l.source_doc_id
      WHERE l.target_slug = ? AND d.published = 1 AND d.id <> ? ORDER BY d.title, d.id LIMIT ?`,
    [doc.slug, doc.id, BACKLINK_LIMIT],
  );
  return rows;
}

// The state of a link as the admin sees it: it works, it points at a doc that
// is not published, or no doc has that slug.
const linkState = (row) => (row.target_id === null ? 'missing' : row.target_published ? 'ok' : 'unpublished');

// The links a doc contains, with where each one stands. For the admin doc page.
export async function getDocLinks(pool, docId) {
  const [rows] = await pool.query(
    `SELECT l.target_slug, t.id AS target_id, t.title AS target_title, t.published AS target_published
       FROM doc_links l LEFT JOIN docs t ON t.slug = l.target_slug
      WHERE l.source_doc_id = ? ORDER BY l.target_slug`,
    [docId],
  );
  return rows.map((row) => ({
    slug: row.target_slug,
    title: row.target_title ?? '',
    targetId: row.target_id,
    state: linkState(row),
  }));
}

const UNRESOLVED = 't.id IS NULL OR t.published = 0';

export async function countUnresolved(pool) {
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM doc_links l LEFT JOIN docs t ON t.slug = l.target_slug WHERE ${UNRESOLVED}`,
  );
  return Number(total);
}

// Every link, in any doc, whose target is not a published doc: the report after
// an upload and on the dashboard.
export async function listUnresolved(pool, { limit, offset }) {
  const total = await countUnresolved(pool);
  const [rows] = await pool.query(
    `SELECT s.id AS source_id, s.title AS source_title, l.target_slug, t.id AS target_id, t.published AS target_published
       FROM doc_links l
       JOIN docs s ON s.id = l.source_doc_id
       LEFT JOIN docs t ON t.slug = l.target_slug
      WHERE ${UNRESOLVED}
      ORDER BY s.title, s.id, l.target_slug LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return {
    total,
    rows: rows.map((row) => ({
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      slug: row.target_slug,
      state: linkState(row),
    })),
  };
}
