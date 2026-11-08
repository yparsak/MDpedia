import { Router } from 'express';
import { loadTree } from '../services/categories.js';
import { docLinks } from '../services/doc-links.js';
import { getPublishedById } from '../services/docs.js';
import { pageCount, parsePage } from '../services/pagination.js';
import { createRateLimiter } from '../services/rate-limit.js';
import { QUERY_MAX_CHARS, QUERY_MAX_TERMS, parseQuery } from '../services/search-query.js';
import { QUERY_LOG_MAX, recordClick, recordSearch } from '../services/search-log.js';
import { getPublishedByIds, searchPublished } from '../services/search.js';
import { cleanLine } from '../services/text.js';

const parseId = (value) => (typeof value === 'string' && /^\d{1,18}$/.test(value) ? Number(value) : null);

// Public search (brainstorm 5.15). Only published docs can be found; the visibility
// rule is in the SQL. Readers need no JavaScript: the form is a plain GET, and a
// result link goes through /search/click, which records the click and redirects.
export function searchRouter({ pool, config }) {
  const router = Router();
  const limiter = createRateLimiter({ limit: config.rate.searchPerMin });
  const { pageSize, partialThreshold } = config.search;

  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  const renderSearch = (res, status, view) =>
    res.status(status).render('search', {
      title: view.query ? `Search: ${view.query}` : 'Search',
      query: '',
      message: null,
      results: null,
      partial: false,
      trimmed: false,
      total: 0,
      page: 1,
      pages: 1,
      basePath: '',
      partialThreshold,
      maxTerms: QUERY_MAX_TERMS,
      maxChars: QUERY_MAX_CHARS,
      ...view,
    });

  router.get('/search', noStore, async (req, res) => {
    // ?q= given twice is an array: treated as no query.
    const query = cleanLine(typeof req.query.q === 'string' ? req.query.q : '').slice(0, QUERY_MAX_CHARS);
    if (query === '') return renderSearch(res, 200, {});

    const parsed = parseQuery(query);
    if (parsed.terms.length === 0) {
      return renderSearch(res, 200, { query, message: 'Type at least one word or number. Punctuation and operators are ignored.' });
    }

    const gate = limiter.hit(req.ip);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSeconds));
      return renderSearch(res, 429, {
        query,
        message: `Too many searches. Wait about ${gate.retryAfterSeconds} second${gate.retryAfterSeconds === 1 ? '' : 's'} and try again.`,
      });
    }

    const { ids, partial } = await searchPublished(pool, config, parsed);
    const page = parsePage(req.query.page);
    const pages = pageCount(ids.length, pageSize);

    // A new search is logged once. The links to the other pages carry the log
    // id along (?l=), so paging does not log again and a click on any page is
    // still tied to the search.
    const carriedId = parseId(req.query.l);
    const logId =
      carriedId ?? (page === 1 ? await recordSearch(pool, { queryText: query.slice(0, QUERY_LOG_MAX), resultCount: ids.length, partial }) : null);

    const rows = await getPublishedByIds(pool, ids.slice((page - 1) * pageSize, page * pageSize));
    const links = rows.length > 0 ? await docLinks(pool, await loadTree(pool), rows) : [];

    renderSearch(res, 200, {
      query,
      results: links.map((d) => ({
        url: logId === null ? d.url : `/search/click?l=${logId}&d=${d.id}`,
        title: d.title,
        summary: d.summary,
        categoryLabel: d.categoryLabel,
      })),
      partial,
      trimmed: parsed.trimmed,
      total: ids.length,
      page,
      pages,
      basePath: `/search?q=${encodeURIComponent(query)}${logId === null ? '' : `&l=${logId}`}&`,
    });
  });

  // Records that a result was opened, then sends the reader to the doc. An
  // unknown or unpublished doc gets the same generic 404 as anywhere else.
  router.get('/search/click', noStore, async (req, res) => {
    const docId = parseId(req.query.d);
    const doc = docId === null ? null : await getPublishedById(pool, docId);
    if (!doc) return res.status(404).render('404', { title: 'Page not found' });

    const logId = parseId(req.query.l);
    if (logId !== null) await recordClick(pool, { logId, docId });

    const [link] = await docLinks(pool, await loadTree(pool), [doc]);
    res.redirect(302, link.url);
  });

  return router;
}
