import { Router } from 'express';
import { SLUG_PATTERN } from '../public/js/slug.js';
import {
  categoryUrl,
  chainOf,
  docPath,
  findByPath,
  loadTree,
  pathLabel,
  publishedSubtreeCounts,
} from '../services/categories.js';
import { categoryIdsForDocs, getDocCategoryIds, listPublishedInCategory } from '../services/doc-categories.js';
import { getPublishedById, getPublishedBySlug, listPublished } from '../services/docs.js';
import { pageCount, parsePage } from '../services/pagination.js';

const HOME_PAGE_SIZE = 50;

// Public pages. Only published docs are ever served. A doc that is unpublished,
// unknown or not even a valid address gets the one generic 404, so a reader
// cannot probe which ids or slugs exist (brainstorm 5.10). The same goes for a
// category with no published doc anywhere under it.
export function readerRouter({ pool }) {
  const router = Router();

  // Revalidate on every request, so an unpublished doc disappears immediately.
  const revalidate = (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    next();
  };

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  // A redirect that is never cached: the target changes when a category is
  // renamed or moved, and a cached 301 would then send readers the wrong way.
  const redirectTo = (res, status, url) => {
    res.set('Cache-Control', 'no-store');
    res.redirect(status, url);
  };

  // Link target for each doc row: the canonical path through its primary category.
  async function docLinks(tree, rows) {
    const categoryIds = await categoryIdsForDocs(pool, rows.map((d) => d.id));
    return rows.map((d) => ({
      url: `/wiki/${docPath(tree.byId.get(categoryIds.get(d.id)[0]) ?? null, d.slug)}`,
      title: d.title,
      summary: d.summary ?? '',
    }));
  }

  const crumbsFor = (node) => [{ name: 'Home', url: '/' }, ...chainOf(node).map((n) => ({ name: n.name, url: categoryUrl(n) }))];

  // Shows the doc when requestedPath is its current path. A stale or wrong path
  // gets a 301 to the current one; null (the /doc?id= permalink) always redirects.
  async function serveDoc(req, res, doc, requestedPath) {
    const tree = await loadTree(pool);
    const categories = (await getDocCategoryIds(pool, doc.id)).map((id) => tree.byId.get(id)).filter(Boolean);
    const canonical = docPath(categories[0] ?? null, doc.slug);
    if (requestedPath === null) return redirectTo(res, 302, `/wiki/${canonical}`);
    if (requestedPath !== canonical) return redirectTo(res, 301, `/wiki/${canonical}`);

    res.render('doc', {
      title: doc.title,
      doc: { title: doc.title, html: doc.html, updatedAt: doc.updated_at },
      crumbs: categories[0] ? crumbsFor(categories[0]) : [],
      alsoIn: categories.slice(1).map((n) => ({ label: pathLabel(n), url: categoryUrl(n) })),
      styles: ['/vendor/katex/katex.min.css', '/css/doc.css'],
    });
  }

  router.get('/', revalidate, async (req, res) => {
    const page = parsePage(req.query.page);
    const { total, rows } = await listPublished(pool, { limit: HOME_PAGE_SIZE, offset: (page - 1) * HOME_PAGE_SIZE });
    const tree = await loadTree(pool);
    const counts = await publishedSubtreeCounts(pool, tree);
    res.render('home', {
      title: 'Home',
      categories: tree.roots
        .filter((n) => counts.get(n.id) > 0)
        .map((n) => ({ name: n.name, url: categoryUrl(n), count: counts.get(n.id) })),
      docs: await docLinks(tree, rows),
      page,
      pages: pageCount(total, HOME_PAGE_SIZE),
    });
  });

  // /wiki/<category path>/<slug>, or just /wiki/<slug> for a doc with no
  // category. The doc is found by its slug alone (the last segment): the
  // category part is only cosmetic, and a stale or wrong one is redirected to
  // the current path (brainstorm 5.4).
  router.get('/wiki/*path', revalidate, async (req, res) => {
    const segments = req.params.path.map((segment) => segment.toLowerCase());
    const slug = segments[segments.length - 1];
    const doc = SLUG_PATTERN.test(slug) ? await getPublishedBySlug(pool, slug) : null;
    if (!doc) return notFound(res);
    await serveDoc(req, res, doc, segments.join('/'));
  });

  // The permanent link. It always redirects to the doc's current path; the id
  // never changes even if the title or the categories do (brainstorm 5.9).
  router.get('/doc', revalidate, async (req, res) => {
    const id = typeof req.query.id === 'string' && /^\d{1,10}$/.test(req.query.id) ? Number(req.query.id) : null;
    const doc = id === null ? null : await getPublishedById(pool, id);
    if (!doc) return notFound(res);
    await serveDoc(req, res, doc, null);
  });

  // Folder-style browsing (brainstorm 5.4): the direct subcategories with the
  // published count of their whole subtree, then the docs filed directly here.
  router.get('/category/*path', revalidate, async (req, res) => {
    const tree = await loadTree(pool);
    const node = findByPath(tree, req.params.path.map((segment) => segment.toLowerCase()));
    const counts = node ? await publishedSubtreeCounts(pool, tree) : null;
    if (!node || counts.get(node.id) === 0) return notFound(res);

    const page = parsePage(req.query.page);
    const { total, rows } = await listPublishedInCategory(pool, node.id, {
      limit: HOME_PAGE_SIZE,
      offset: (page - 1) * HOME_PAGE_SIZE,
    });
    res.render('category', {
      title: node.name,
      name: node.name,
      crumbs: [...crumbsFor(node).slice(0, -1), { name: node.name, url: null }],
      subcategories: node.children
        .filter((n) => counts.get(n.id) > 0)
        .map((n) => ({ name: n.name, url: categoryUrl(n), count: counts.get(n.id) })),
      docs: await docLinks(tree, rows),
      basePath: `${categoryUrl(node)}?`,
      page,
      pages: pageCount(total, HOME_PAGE_SIZE),
    });
  });

  router.get('/category', (req, res) => redirectTo(res, 302, '/'));

  return router;
}
