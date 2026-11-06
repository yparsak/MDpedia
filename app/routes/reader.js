import { Router } from 'express';
import { SLUG_PATTERN } from '../public/js/slug.js';
import { getPublishedById, getPublishedBySlug, listPublished } from '../services/docs.js';
import { pageCount, parsePage } from '../services/pagination.js';

const HOME_PAGE_SIZE = 50;

// Public pages. Only published docs are ever served. A doc that is unpublished,
// unknown or not even a valid address gets the one generic 404, so a reader
// cannot probe which ids or slugs exist (brainstorm 5.10).
export function readerRouter({ pool }) {
  const router = Router();

  // Revalidate on every request, so an unpublished doc disappears immediately.
  const revalidate = (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    next();
  };

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  const renderDoc = (res, doc) =>
    res.render('doc', {
      title: doc.title,
      doc: { title: doc.title, html: doc.html, updatedAt: doc.updated_at },
      styles: ['/vendor/katex/katex.min.css', '/css/doc.css'],
    });

  router.get('/', revalidate, async (req, res) => {
    const page = parsePage(req.query.page);
    const { total, rows } = await listPublished(pool, { limit: HOME_PAGE_SIZE, offset: (page - 1) * HOME_PAGE_SIZE });
    res.render('home', {
      title: 'Home',
      docs: rows.map((d) => ({ slug: d.slug, title: d.title, summary: d.summary ?? '' })),
      page,
      pages: pageCount(total, HOME_PAGE_SIZE),
    });
  });

  router.get('/wiki/:slug', revalidate, async (req, res) => {
    const slug = req.params.slug.toLowerCase();
    const doc = SLUG_PATTERN.test(slug) ? await getPublishedBySlug(pool, slug) : null;
    if (!doc) return notFound(res);
    renderDoc(res, doc);
  });

  // The permanent link. It serves the doc directly; the id never changes even if
  // the title does (brainstorm 5.9).
  router.get('/doc', revalidate, async (req, res) => {
    const id = typeof req.query.id === 'string' && /^\d{1,10}$/.test(req.query.id) ? Number(req.query.id) : null;
    const doc = id === null ? null : await getPublishedById(pool, id);
    if (!doc) return notFound(res);
    renderDoc(res, doc);
  });

  return router;
}
