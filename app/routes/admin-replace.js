import { Router } from 'express';
import { verifyCsrf } from '../middleware/admin-session.js';
import { receiveUpload as receiveUploadFor } from '../middleware/receive-upload.js';
import { recordAudit } from '../services/audit.js';
import { DocFileError } from '../services/docfiles.js';
import { STATUS_LABELS, getDocById } from '../services/docs.js';
import { noticeFrom } from '../services/notices.js';
import { approveStaged, discardStaged, loadStaged, stageReplacement } from '../services/replace.js';
import { TERM_LISTS, formatTermForm, getDocTerms } from '../services/search-terms.js';

const NOTICES = {
  staged: { kind: 'ok', text: 'Staged. Readers still see the current version until you approve this one.' },
  'staged-queued': { kind: 'ok', text: 'Staged. The AI is refreshing the keywords; readers still see the current version. Approve once the status says ready.' },
  discarded: { kind: 'ok', text: 'The staged version was discarded. The live document was not touched.' },
  nothing: { kind: 'warn', text: 'There is no staged version to discard.' },
};

const STAGED_LABELS = { processing: 'AI refreshing keywords', ready: 'Ready to approve', failed: 'Keyword refresh failed' };

const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);
const str = (value) => (typeof value === 'string' ? value : '');

// Replace a doc: upload a new version to staging, wait for the
// keywords to be refreshed, then approve to swap it in. Readers see the old
// version until the swap.
export function adminReplaceRouter({ pool, config, needAdmin }) {
  const router = Router();
  const receiveUpload = receiveUploadFor({ maxBytes: config.uploads.maxBytes });

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  async function loadDoc(req, res, next) {
    const id = parseId(req.params.id);
    req.doc = id === null ? null : await getDocById(pool, id);
    if (!req.doc) return notFound(res);
    next();
  }

  const audit = (req, action, summary) =>
    recordAudit(pool, { actor: req.session.username, action, targetType: 'doc', targetId: req.doc.id, summary, ip: req.ip });

  async function renderPage(res, status, doc, { errors = [], notice = null } = {}) {
    const staged = doc.staged_at ? await loadStaged(pool, config, doc) : null;
    res.status(status).render('admin/doc-replace', {
      title: `Replace: ${doc.title}`,
      doc: {
        id: doc.id,
        title: doc.title,
        slug: doc.slug,
        statusLabel: STATUS_LABELS[doc.status] ?? doc.status,
        published: Boolean(doc.published),
        inProgress: ['uploaded', 'processing'].includes(doc.status),
        summaryEdited: Boolean(doc.summary_edited),
        summary: doc.summary ?? '',
        missing: doc.attention === 'missing',
      },
      staged: doc.staged_at
        ? {
            at: doc.staged_at,
            status: doc.staged_status,
            statusLabel: STAGED_LABELS[doc.staged_status] ?? doc.staged_status,
            hash: doc.staged_hash,
            size: doc.staged_size,
            problem: staged && !staged.ok ? staged.reason : '',
            html: staged?.ok ? staged.html : '',
            hasRawHtml: staged?.ok ? staged.hasRawHtml : false,
            summary: staged?.ok ? staged.summary : '',
            terms: staged?.ok ? formatTermForm(staged.terms) : null,
            canApprove: Boolean(staged?.ok) && doc.staged_status !== 'processing',
          }
        : null,
      currentTerms: formatTermForm(await getDocTerms(pool, doc.id)),
      termLists: TERM_LISTS.map(({ list, label }) => ({ list, label })),
      maxBytes: config.uploads.maxBytes,
      errors,
      notice,
      styles: ['/vendor/katex/katex.min.css', '/css/doc.css'],
    });
  }

  router.get('/:id', needAdmin, loadDoc, (req, res) => renderPage(res, 200, req.doc, { notice: noticeFrom(NOTICES, req) }));

  // Stage the uploaded file. Staging again replaces the earlier staged version.
  router.post('/:id', needAdmin, receiveUpload, verifyCsrf, loadDoc, async (req, res) => {
    if (req.uploadError) {
      const tooBig = req.uploadError.code === 'LIMIT_FILE_SIZE';
      const message = tooBig ? `The file is over the ${config.uploads.maxBytes} byte limit.` : 'The upload could not be read. Choose the file again.';
      return renderPage(res, tooBig ? 413 : 400, req.doc, { errors: [message] });
    }
    let result;
    try {
      result = await stageReplacement(pool, config, req.doc, req.file);
    } catch (err) {
      if (!(err instanceof DocFileError)) throw err;
      return renderPage(res, 409, req.doc, { errors: [err.message] });
    }
    if (!result.ok) return renderPage(res, result.status, req.doc, { errors: result.errors });
    await audit(req, 'doc.replace_stage', `Staged a replacement for "${req.doc.slug}". The live version is unchanged.`);
    res.redirect(303, `/admin/replace/${req.doc.id}?msg=${result.queued ? 'staged-queued' : 'staged'}`);
  });

  router.post('/:id/approve', needAdmin, verifyCsrf, loadDoc, async (req, res) => {
    let result;
    try {
      result = await approveStaged(pool, config, req.doc, str(req.body.staged_hash));
    } catch (err) {
      if (!(err instanceof DocFileError)) throw err;
      return renderPage(res, 409, req.doc, { errors: [err.message] });
    }
    if (!result.ok) return renderPage(res, result.status, req.doc, { errors: result.errors });
    await audit(req, 'doc.replace_approve', `Approved the replacement of "${req.doc.slug}". The new version is live.`);
    res.redirect(303, `/admin/docs/${req.doc.id}?msg=replaced`);
  });

  router.post('/:id/discard', needAdmin, verifyCsrf, loadDoc, async (req, res) => {
    if (!req.doc.staged_at) return res.redirect(303, `/admin/replace/${req.doc.id}?msg=nothing`);
    await discardStaged(pool, config, req.doc);
    await audit(req, 'doc.replace_discard', `Discarded the staged replacement of "${req.doc.slug}".`);
    res.redirect(303, `/admin/replace/${req.doc.id}?msg=discarded`);
  });

  return router;
}
