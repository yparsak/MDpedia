import { Router } from 'express';
import multer from 'multer';
import { verifyCsrf } from '../middleware/admin-session.js';
import { recordAudit } from '../services/audit.js';
import { MAX_DOC_CATEGORIES, checkCategoryIds, getDocCategoryIds, setDocCategories } from '../services/doc-categories.js';
import { docPath, loadTree, pathLabel } from '../services/categories.js';
import { DocFileError } from '../services/docfiles.js';
import {
  STATUS_LABELS,
  getDocById,
  listDocs,
  setPublished,
  setSummary,
  setTitle,
} from '../services/docs.js';
import { noticeFrom } from '../services/notices.js';
import { TERM_LISTS, formatTermForm, getDocTerms, parseTermForm, setDocTerms } from '../services/search-terms.js';
import { pageCount, parsePage } from '../services/pagination.js';
import { SLUG_MAX } from '../public/js/slug.js';
import { SUMMARY_MAX, TITLE_MAX, cleanLine, ingestUpload } from '../services/upload.js';

const DOC_PAGE_SIZE = 25;

const NOTICES = {
  uploaded: { kind: 'ok', text: 'Uploaded. The document is ready for review. Publish it when you are happy with it.' },
  published: { kind: 'ok', text: 'Published. Readers can see this document now.' },
  unpublished: { kind: 'ok', text: 'Unpublished. Readers get "page not found" for it until you publish it again.' },
  'title-saved': { kind: 'ok', text: 'Title saved. The slug did not change.' },
  'summary-saved': { kind: 'ok', text: 'Summary saved and marked as hand-edited.' },
  'summary-cleared': { kind: 'ok', text: 'Summary cleared.' },
  'categories-saved': { kind: 'ok', text: 'Categories saved. The first one is the primary category.' },
  'keywords-saved': { kind: 'ok', text: 'Search keywords saved. Searches find them straight away.' },
  unchanged: { kind: 'warn', text: 'Nothing changed.' },
};

// The filter links on the list page; the keys are the only values honoured.
const FILTERS = [
  { key: 'all', label: 'All', status: null },
  { key: 'ready', label: STATUS_LABELS.ready, status: 'ready' },
  { key: 'published', label: STATUS_LABELS.published, status: 'published' },
  { key: 'unpublished', label: STATUS_LABELS.unpublished, status: 'unpublished' },
];

const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);

export function adminDocsRouter({ pool, config, needAdmin }) {
  const router = Router();

  // Multipart parsing happens here, after the admin check and before the CSRF
  // check, because the token is a form field. The file stays in memory (the
  // cap is small) and is written only through the staging directory.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 5, fieldSize: 10 * 1024, parts: 10 },
    defParamCharset: 'utf8',
  }).single('file');
  const receiveUpload = (req, res, next) =>
    upload(req, res, (err) => {
      req.uploadError = err ?? null;
      next();
    });

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  async function loadDoc(req, res, next) {
    const id = parseId(req.params.id);
    req.doc = id === null ? null : await getDocById(pool, id);
    if (!req.doc) return notFound(res);
    next();
  }

  const renderUpload = (res, status, { errors = [], title = '', slug = '' } = {}) =>
    res.status(status).render('admin/doc-upload', {
      title: 'Upload a document',
      errors,
      form: { title, slug },
      maxBytes: config.uploads.maxBytes,
      titleMax: TITLE_MAX,
      slugMax: SLUG_MAX,
      styles: [],
      scripts: ['/js/upload.js'],
    });

  const renderDetail = async (res, status, doc, { errors = [], notice = null, titleValue, summaryValue, termsValue } = {}) => {
    const tree = await loadTree(pool);
    const categoryIds = await getDocCategoryIds(pool, doc.id);
    const assigned = categoryIds.map((id) => tree.byId.get(id)).filter(Boolean);
    res.status(status).render('admin/doc-detail', {
      title: doc.title,
      doc: docView(doc),
      readerPath: `/wiki/${docPath(assigned[0] ?? null, doc.slug)}`,
      categories: assigned.map((n, index) => ({
        id: n.id,
        label: pathLabel(n),
        primary: index === 0,
        canUp: index > 0,
        canDown: index < assigned.length - 1,
      })),
      categoryOptions: tree.nodes
        .filter((n) => !categoryIds.includes(n.id))
        .map((n) => ({ id: n.id, label: `${'\u2014 '.repeat(n.depth - 1)}${n.name}` })),
      categoryMax: MAX_DOC_CATEGORIES,
      errors,
      notice,
      titleValue: titleValue ?? doc.title,
      summaryValue: summaryValue ?? doc.summary ?? '',
      termsValue: termsValue ?? formatTermForm(await getDocTerms(pool, doc.id)),
      termLists: TERM_LISTS.map(({ list, label, max, length }) => ({ list, label, max, length })),
      titleMax: TITLE_MAX,
      summaryMax: SUMMARY_MAX,
      styles: ['/vendor/katex/katex.min.css', '/css/doc.css'],
    });
  };

  // -------------------------------------------------------------------- list

  router.get('/', needAdmin, async (req, res) => {
    const filter = FILTERS.find((f) => f.key === req.query.status) ?? FILTERS[0];
    const page = parsePage(req.query.page);
    const { total, rows } = await listDocs(pool, {
      status: filter.status,
      limit: DOC_PAGE_SIZE,
      offset: (page - 1) * DOC_PAGE_SIZE,
    });
    res.render('admin/docs', {
      title: 'Documents',
      notice: noticeFrom(NOTICES, req),
      filters: FILTERS.map(({ key, label }) => ({ key, label, active: key === filter.key })),
      filterKey: filter.key,
      rows: rows.map(docView),
      page,
      pages: pageCount(total, DOC_PAGE_SIZE),
      total,
    });
  });

  // ------------------------------------------------------------------ upload

  router.get('/new', needAdmin, (req, res) => renderUpload(res, 200));

  router.post('/', needAdmin, receiveUpload, verifyCsrf, async (req, res) => {
    const formTitle = typeof req.body.title === 'string' ? req.body.title : '';
    const formSlug = typeof req.body.slug === 'string' ? req.body.slug : '';
    const echo = { title: cleanLine(formTitle), slug: cleanLine(formSlug) };

    if (req.uploadError) {
      const tooBig = req.uploadError.code === 'LIMIT_FILE_SIZE';
      const message = tooBig
        ? `The file is over the ${config.uploads.maxBytes} byte limit.`
        : 'The upload could not be read. Choose the file again.';
      return renderUpload(res, tooBig ? 413 : 400, { errors: [message], ...echo });
    }

    const result = await ingestUpload(pool, config, { file: req.file, formTitle, formSlug });
    if (!result.ok) return renderUpload(res, result.status, { errors: result.errors, ...echo });

    await recordAudit(pool, {
      actor: req.session.username,
      action: 'doc.upload',
      targetType: 'doc',
      targetId: result.id,
      summary: `Uploaded "${result.slug}". Ready for review.`,
      ip: req.ip,
    });
    res.redirect(303, `/admin/docs/${result.id}?msg=uploaded`);
  });

  // ------------------------------------------------------------------ detail

  router.get('/:id', needAdmin, loadDoc, (req, res) =>
    renderDetail(res, 200, req.doc, { notice: noticeFrom(NOTICES, req) }),
  );

  // Runs a change to a doc and turns the file problems it can hit into a message.
  async function applyChange(req, res, { action, summary, change, done }) {
    try {
      await change();
    } catch (err) {
      const message =
        err.code === 'ENOENT'
          ? 'The file for this document is missing from the docs directory, so nothing was changed.'
          : err instanceof DocFileError
            ? err.message
            : null;
      if (message === null) throw err;
      return renderDetail(res, 409, req.doc, { errors: [message] });
    }
    await recordAudit(pool, {
      actor: req.session.username,
      action,
      targetType: 'doc',
      targetId: req.doc.id,
      summary,
      ip: req.ip,
    });
    res.redirect(303, `/admin/docs/${req.doc.id}?msg=${done}`);
  }

  const unchanged = (req, res) => res.redirect(303, `/admin/docs/${req.doc.id}?msg=unchanged`);

  router.post('/:id/publish', needAdmin, verifyCsrf, loadDoc, (req, res) => {
    if (req.doc.published) return unchanged(req, res);
    return applyChange(req, res, {
      action: 'doc.publish',
      summary: `Published "${req.doc.slug}".`,
      change: () => setPublished(pool, config, req.doc, true),
      done: 'published',
    });
  });

  router.post('/:id/unpublish', needAdmin, verifyCsrf, loadDoc, (req, res) => {
    if (!req.doc.published) return unchanged(req, res);
    return applyChange(req, res, {
      action: 'doc.unpublish',
      summary: `Unpublished "${req.doc.slug}".`,
      change: () => setPublished(pool, config, req.doc, false),
      done: 'unpublished',
    });
  });

  router.post('/:id/title', needAdmin, verifyCsrf, loadDoc, (req, res) => {
    const title = cleanLine(typeof req.body.title === 'string' ? req.body.title : '');
    if (title === '') return renderDetail(res, 400, req.doc, { errors: ['A title is required.'] });
    if (title.length > TITLE_MAX) {
      return renderDetail(res, 400, req.doc, { errors: [`The title is longer than ${TITLE_MAX} characters.`], titleValue: title });
    }
    if (title === req.doc.title) return unchanged(req, res);
    return applyChange(req, res, {
      action: 'doc.title',
      summary: `Changed the title of "${req.doc.slug}".`,
      change: () => setTitle(pool, config, req.doc, title),
      done: 'title-saved',
    });
  });

  router.post('/:id/summary', needAdmin, verifyCsrf, loadDoc, (req, res) => {
    const summary = cleanLine(typeof req.body.summary === 'string' ? req.body.summary : '');
    if (summary.length > SUMMARY_MAX) {
      return renderDetail(res, 400, req.doc, { errors: [`The summary is longer than ${SUMMARY_MAX} characters.`], summaryValue: summary });
    }
    if (summary === (req.doc.summary ?? '')) return unchanged(req, res);
    return applyChange(req, res, {
      action: 'doc.summary',
      summary: `${summary ? 'Edited' : 'Cleared'} the summary of "${req.doc.slug}".`,
      change: () => setSummary(pool, config, req.doc, summary),
      done: summary ? 'summary-saved' : 'summary-cleared',
    });
  });

  // ---------------------------------------------------------------- keywords

  // The four textareas arrive as one form; any refused line saves nothing and
  // the text typed is shown again with the reasons.
  router.post('/:id/keywords', needAdmin, verifyCsrf, loadDoc, async (req, res) => {
    const text = (key) => (typeof req.body[key] === 'string' ? req.body[key] : '');
    const form = Object.fromEntries(TERM_LISTS.map(({ list }) => [list, text(list)]));
    const parsed = parseTermForm(form);
    if (!parsed.ok) return renderDetail(res, 400, req.doc, { errors: parsed.errors, termsValue: form });

    const current = await getDocTerms(pool, req.doc.id);
    if (JSON.stringify(formatTermForm(current)) === JSON.stringify(formatTermForm(parsed.terms))) return unchanged(req, res);
    return applyChange(req, res, {
      action: 'doc.keywords',
      summary: `Changed the search keywords of "${req.doc.slug}".`,
      change: () => setDocTerms(pool, config, req.doc, parsed.terms),
      done: 'keywords-saved',
    });
  });

  // ------------------------------------------------------------- categories

  // Add, remove and reorder all end in the same place: the new ordered list of
  // ids is checked against the tree and saved (front matter first).
  async function changeCategories(req, res, ids, summary) {
    const checked = checkCategoryIds(ids, await loadTree(pool));
    if (!checked.ok) return renderDetail(res, 400, req.doc, { errors: checked.errors });
    return applyChange(req, res, {
      action: 'doc.categories',
      summary,
      change: () => setDocCategories(pool, config, req.doc, ids),
      done: 'categories-saved',
    });
  }

  const categoryIdFrom = (req) => parseId(typeof req.body.category_id === 'string' ? req.body.category_id : '');

  router.post('/:id/categories/add', needAdmin, verifyCsrf, loadDoc, async (req, res) => {
    const categoryId = categoryIdFrom(req);
    const current = await getDocCategoryIds(pool, req.doc.id);
    if (categoryId === null) return renderDetail(res, 400, req.doc, { errors: ['Choose a category to add.'] });
    if (current.includes(categoryId)) return unchanged(req, res);
    return changeCategories(req, res, [...current, categoryId], `Added category ${categoryId} to "${req.doc.slug}".`);
  });

  router.post('/:id/categories/remove', needAdmin, verifyCsrf, loadDoc, async (req, res) => {
    const categoryId = categoryIdFrom(req);
    const current = await getDocCategoryIds(pool, req.doc.id);
    if (categoryId === null || !current.includes(categoryId)) return unchanged(req, res);
    return changeCategories(
      req,
      res,
      current.filter((id) => id !== categoryId),
      `Removed category ${categoryId} from "${req.doc.slug}".`,
    );
  });

  router.post('/:id/categories/move', needAdmin, verifyCsrf, loadDoc, async (req, res) => {
    const categoryId = categoryIdFrom(req);
    const direction = req.body.direction;
    const current = await getDocCategoryIds(pool, req.doc.id);
    const from = current.indexOf(categoryId);
    const to = direction === 'up' ? from - 1 : direction === 'down' ? from + 1 : -1;
    if (from === -1 || to < 0 || to >= current.length) return unchanged(req, res);

    const ids = [...current];
    [ids[from], ids[to]] = [ids[to], ids[from]];
    return changeCategories(req, res, ids, `Changed the category order of "${req.doc.slug}".`);
  });

  return router;
}

// Template rows are built field by field (brainstorm 5.7).
function docView(d) {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    status: d.status,
    statusLabel: STATUS_LABELS[d.status] ?? d.status,
    published: Boolean(d.published),
    summary: d.summary ?? '',
    summaryEdited: Boolean(d.summary_edited),
    hasRawHtml: Boolean(d.has_raw_html),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    publishedAt: d.published_at ?? '',
    html: d.html ?? '',
  };
}
