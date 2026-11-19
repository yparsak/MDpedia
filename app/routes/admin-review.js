import { Router } from 'express';
import { verifyCsrf } from '../middleware/admin-session.js';
import { recordAudit } from '../services/audit.js';
import { loadTree, pathLabel } from '../services/categories.js';
import { MAX_DOC_CATEGORIES, checkCategoryIds, getDocCategoryIds, setDocCategories } from '../services/doc-categories.js';
import { DocFileError } from '../services/docfiles.js';
import { STATUS_LABELS, getDocById, getReadyDocs, listDocs, setSummary } from '../services/docs.js';
import { noticeFrom } from '../services/notices.js';
import { pageCount, parsePage } from '../services/pagination.js';
import {
  acceptProposals,
  approveDoc,
  approveMany,
  findExceptions,
  getPendingProposals,
  listPendingProposals,
  planBulkApproval,
  rejectProposals,
  reviewCategoryIds,
} from '../services/review.js';
import { TERM_LISTS, formatTermForm, getDocTerms, parseTermForm, setDocTerms } from '../services/search-terms.js';
import { SUMMARY_MAX, cleanLine } from '../services/upload.js';

const QUEUE_PAGE_SIZE = 25;
const PROPOSAL_LIMIT = 25;

const NOTICES = {
  saved: { kind: 'ok', text: 'Saved. The document is not published yet.' },
  'none-selected': { kind: 'warn', text: 'Select at least one document to approve.' },
};

// The queue's filter links; the keys are the only values honoured.
const VIEWS = [
  { key: 'ready', label: STATUS_LABELS.ready, status: 'ready' },
  { key: 'unpublished', label: STATUS_LABELS.unpublished, status: 'unpublished' },
];

const ACTIONS = ['accept', 'reject', 'keep'];

const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);
const str = (value) => (typeof value === 'string' ? value : '');

// A repeated form field arrives as a string, or as an array when there are several.
const idsFrom = (value) => [...new Set([value].flat().map((v) => parseId(str(v))).filter((id) => id !== null))];

// The review gate (roadmap Phase 7): the queue of docs awaiting review, the review
// screen where the admin edits what the AI produced and approves, and bulk approval.
export function adminReviewRouter({ pool, config, needAdmin }) {
  const router = Router();

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  const audit = (req, action, summary, docId = null) =>
    recordAudit(pool, { actor: req.session.username, action, targetType: docId === null ? null : 'doc', targetId: docId, summary, ip: req.ip });

  async function loadDoc(req, res, next) {
    const id = parseId(req.params.id);
    req.doc = id === null ? null : await getDocById(pool, id);
    if (!req.doc) return notFound(res);
    next();
  }

  // ------------------------------------------------------------------- queue

  router.get('/', needAdmin, async (req, res) => {
    const view = VIEWS.find((v) => v.key === req.query.view) ?? VIEWS[0];
    const page = parsePage(req.query.page);
    const { total, rows } = await listDocs(pool, { status: view.status, limit: QUEUE_PAGE_SIZE, offset: (page - 1) * QUEUE_PAGE_SIZE });
    const exceptions = view.key === 'ready' ? await findExceptions(pool, config, rows) : new Map();
    const tree = await loadTree(pool);
    const proposals = await listPendingProposals(pool, { limit: PROPOSAL_LIMIT, offset: 0 });
    res.render('admin/review', {
      title: 'Review queue',
      notice: noticeFrom(NOTICES, req),
      views: VIEWS.map(({ key, label }) => ({ key, label, active: key === view.key })),
      viewKey: view.key,
      rows: rows.map((d) => ({
        id: d.id,
        title: d.title,
        slug: d.slug,
        statusLabel: STATUS_LABELS[d.status] ?? d.status,
        updatedAt: d.updated_at,
        exceptions: (exceptions.get(d.id) ?? []).map((e) => e.text),
      })),
      proposals: proposals.rows.map((p) => ({
        id: p.id,
        docId: p.doc_id,
        docTitle: p.doc_title,
        name: p.name,
        parentLabel: p.parent_id !== null && tree.byId.has(p.parent_id) ? pathLabel(tree.byId.get(p.parent_id)) : '',
        origin: p.source === 'file' ? `file: ${p.source_value}` : 'AI',
      })),
      proposalTotal: proposals.total,
      proposalLimit: PROPOSAL_LIMIT,
      page,
      pages: pageCount(total, QUEUE_PAGE_SIZE),
      total,
    });
  });

  // ----------------------------------------------------------- bulk approval

  const bulkView = (res, status, stage, { plan = null, result = null } = {}) =>
    res.status(status).render('admin/review-bulk', {
      title: 'Approve documents',
      stage,
      approve: plan ? plan.approve.map(summaryRow) : [],
      held: plan ? plan.held.map(({ doc, reasons }) => ({ ...summaryRow(doc), reasons })) : [],
      ids: plan ? plan.approve.map((d) => d.id) : [],
      approved: result ? result.approved : 0,
      failed: result ? result.failed.map(({ doc, reason }) => ({ ...summaryRow(doc), reason })) : [],
    });

  // Step 1: nothing is approved yet. The page lists what would be, and the exceptions
  // held back for review. "all" is every ready doc; "selected" is the ticked ones.
  router.post('/approve', needAdmin, verifyCsrf, async (req, res) => {
    const selected = req.body.mode === 'selected';
    const ids = idsFrom(req.body.ids);
    if (selected && ids.length === 0) return res.redirect(303, '/admin/review?msg=none-selected');
    const docs = await getReadyDocs(pool, selected ? ids : null);
    return bulkView(res, 200, 'confirm', { plan: await planBulkApproval(pool, config, docs) });
  });

  // Step 2: the same plan is made again from the ids shown, since the docs may have
  // changed in between, and only what it still allows is approved.
  router.post('/approve/confirm', needAdmin, verifyCsrf, async (req, res) => {
    const docs = await getReadyDocs(pool, idsFrom(req.body.ids));
    const plan = await planBulkApproval(pool, config, docs);
    const result = await approveMany(pool, config, plan.approve, await loadTree(pool));
    await audit(req, 'doc.approve_bulk', `Approved ${result.approved} document${result.approved === 1 ? '' : 's'} in bulk; ${plan.held.length} held back.`);
    return bulkView(res, 200, 'done', { plan: { approve: [], held: plan.held }, result });
  });

  // ------------------------------------------------------------ review screen

  // form: what the page shows. A first visit starts from the doc as it is; a refused
  // save shows the values that were typed.
  async function renderReview(res, status, doc, { errors = [], notice = null, form = null } = {}) {
    const tree = await loadTree(pool);
    const proposals = await getPendingProposals(pool, doc.id);
    const values = form ?? {
      summary: doc.summary ?? '',
      terms: formatTermForm(await getDocTerms(pool, doc.id)),
      categories: (await reviewCategoryIds(pool, doc.id, tree)).map(String),
      proposals: {},
    };
    const slots = Array.from({ length: MAX_DOC_CATEGORIES }, (_, index) => values.categories[index] ?? '');
    res.status(status).render('admin/doc-review', {
      title: `Review: ${doc.title}`,
      doc: {
        id: doc.id,
        title: doc.title,
        slug: doc.slug,
        statusLabel: STATUS_LABELS[doc.status] ?? doc.status,
        status: doc.status,
        published: Boolean(doc.published),
        inProgress: ['uploaded', 'processing'].includes(doc.status),
        summaryEdited: Boolean(doc.summary_edited),
        hasRawHtml: Boolean(doc.has_raw_html),
        html: doc.html,
        ai: doc.ai_at ? { provider: doc.ai_provider, model: doc.ai_model, promptVersion: doc.ai_prompt_version, at: doc.ai_at } : null,
      },
      errors,
      notice,
      summaryValue: values.summary,
      termsValue: values.terms,
      termLists: TERM_LISTS.map(({ list, label, max, length }) => ({ list, label, max, length })),
      slots: slots.map((value, index) => ({ n: index + 1, value, label: index === 0 ? 'Primary category' : `Category ${index + 1}` })),
      categoryOptions: tree.nodes.map((n) => ({ id: String(n.id), label: `${'— '.repeat(n.depth - 1)}${n.name}` })),
      categoryMax: MAX_DOC_CATEGORIES,
      proposals: proposals.map((p) => ({
        id: p.id,
        name: values.proposals[p.id]?.name ?? p.name,
        action: values.proposals[p.id]?.action ?? 'keep',
        parentLabel: p.parentId !== null && tree.byId.has(p.parentId) ? pathLabel(tree.byId.get(p.parentId)) : '',
        origin: p.source === 'file' ? `the file's categories line (${p.sourceValue})` : 'the AI',
      })),
      summaryMax: SUMMARY_MAX,
      styles: ['/vendor/katex/katex.min.css', '/css/doc.css'],
    });
  }

  router.get('/:id', needAdmin, loadDoc, (req, res) => renderReview(res, 200, req.doc, { notice: noticeFrom(NOTICES, req) }));

  // Save, or save and approve (the button that was pressed, `intent`). Everything is
  // checked before the first change; a refused form shows the values typed.
  router.post('/:id', needAdmin, verifyCsrf, loadDoc, async (req, res) => {
    const doc = req.doc;
    const approve = req.body.intent === 'approve';
    const proposals = await getPendingProposals(pool, doc.id);
    const form = {
      summary: cleanLine(str(req.body.summary)),
      terms: Object.fromEntries(TERM_LISTS.map(({ list }) => [list, str(req.body[list])])),
      categories: Array.from({ length: MAX_DOC_CATEGORIES }, (_, index) => str(req.body[`category_${index + 1}`]).trim()).filter((v) => v !== ''),
      proposals: Object.fromEntries(
        proposals.map((p) => [
          p.id,
          {
            action: ACTIONS.includes(req.body[`proposal_action_${p.id}`]) ? req.body[`proposal_action_${p.id}`] : 'keep',
            name: str(req.body[`proposal_name_${p.id}`]),
          },
        ]),
      ),
    };
    const refuse = (errors) => renderReview(res, 400, doc, { errors, form });

    if (['uploaded', 'processing'].includes(doc.status)) {
      return renderReview(res, 409, doc, { errors: ['The AI is still working on this document. Review it once it is ready.'], form });
    }
    const errors = [];
    if (form.summary.length > SUMMARY_MAX) errors.push(`The summary is longer than ${SUMMARY_MAX} characters.`);
    const terms = parseTermForm(form.terms);
    if (!terms.ok) errors.push(...terms.errors);

    const chosenIds = form.categories.map(parseId);
    if (chosenIds.includes(null)) errors.push('That category does not exist.');
    const tree = await loadTree(pool);
    const accepted = Object.values(form.proposals).filter((p) => p.action === 'accept').length;
    const checked = chosenIds.includes(null) ? { ok: true } : checkCategoryIds(chosenIds, tree);
    if (!checked.ok) errors.push(...checked.errors);
    else if (chosenIds.length + accepted > MAX_DOC_CATEGORIES) {
      errors.push(`A document can be in at most ${MAX_DOC_CATEGORIES} categories: you chose ${chosenIds.length} and accepted ${accepted} proposal${accepted === 1 ? '' : 's'}.`);
    }
    if (errors.length > 0) return refuse(errors);

    const decisions = proposals.map((p) => ({ id: p.id, ...form.proposals[p.id] }));
    try {
      // The file first: a missing or unreadable file stops everything before a category is made.
      if (form.summary !== (doc.summary ?? '')) await setSummary(pool, config, doc, form.summary);
      const currentTerms = formatTermForm(await getDocTerms(pool, doc.id));
      if (JSON.stringify(currentTerms) !== JSON.stringify(formatTermForm(terms.terms))) await setDocTerms(pool, config, doc, terms.terms);

      const resolved = await acceptProposals(pool, config, tree, proposals, decisions);
      if (!resolved.ok) return refuse(resolved.errors);
      await rejectProposals(pool, proposals, decisions);

      const ids = [...new Set([...chosenIds, ...resolved.categoryIds])];
      const current = await getDocCategoryIds(pool, doc.id);
      if (JSON.stringify(ids) !== JSON.stringify(current)) await setDocCategories(pool, config, doc, ids);
      if (approve) await approveDoc(pool, config, doc);
    } catch (err) {
      const message =
        err.code === 'ENOENT'
          ? 'The file for this document is missing from the docs directory, so nothing was changed.'
          : err instanceof DocFileError
            ? err.message
            : null;
      if (message === null) throw err;
      return renderReview(res, 409, doc, { errors: [message], form });
    }

    await audit(
      req,
      approve ? 'doc.approve' : 'doc.review_save',
      approve ? `Approved and published "${doc.slug}".` : `Saved the review of "${doc.slug}" without approving it.`,
      doc.id,
    );
    res.redirect(303, approve ? `/admin/docs/${doc.id}?msg=approved` : `/admin/review/${doc.id}?msg=saved`);
  });

  return router;
}

// Template rows are built field by field (brainstorm 5.7).
function summaryRow(d) {
  return { id: d.id, title: d.title, slug: d.slug };
}
