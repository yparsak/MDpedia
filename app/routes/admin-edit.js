import express, { Router } from 'express';
import { aiConfigured } from '../config.js';
import { verifyCsrf } from '../middleware/admin-session.js';
import { aiOverview } from '../services/ai-status.js';
import { allowanceNeeded, grantAllowance } from '../services/ai-usage.js';
import { recordAudit } from '../services/audit.js';
import { getBackupAge } from '../services/backup-status.js';
import { loadTree } from '../services/categories.js';
import {
  INSTRUCTION_MAX,
  approveRows,
  createBatch,
  estimateCalls,
  findScopeDocs,
  getBatch,
  getBatchDoc,
  getBatchDocs,
  listBatches,
  loadProposal,
  parseEditForm,
  rejectRow,
  retryFailed,
  saveHandEdit,
  stopBatch,
} from '../services/bulk-edit.js';
import { noticeFrom } from '../services/notices.js';

const RECENT_BATCHES = 10;

const NOTICES = {
  stopped: { kind: 'ok', text: 'Stopped. Queued documents were cancelled; finished results stay here for review.' },
  retried: { kind: 'ok', text: 'The failed and refused documents are queued again.' },
  'retried-none': { kind: 'warn', text: 'Nothing to retry: no document failed or was refused, or each already has a staged version.' },
  approved: { kind: 'ok', text: 'Approved. Readers now see the new version.' },
  rejected: { kind: 'ok', text: 'Rejected. The proposal was discarded and the live document was not touched.' },
  saved: { kind: 'ok', text: 'Your edit was saved to the proposal. Readers still see the current version.' },
  'none-selected': { kind: 'warn', text: 'Select at least one document to approve.' },
};

const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);
const str = (value) => (typeof value === 'string' ? value : '');

// Bulk AI edit (roadmap Phase 9): an instruction and a scope, a dry run that says what
// it will cost, one job per doc, and a review of each proposal. Nothing goes live until approved.
export function adminEditRouter({ pool, config, needAdmin }) {
  const router = Router();

  // A proposal can be as big as an upload, and a form field is URL-encoded, so the
  // body limit of the rest of the admin area (64 kb) is too small for the hand-edit form.
  // Only a logged-in admin gets this larger parse.
  router.use(needAdmin, express.urlencoded({ extended: false, limit: config.uploads.maxBytes * 3 + 65536 }));

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  const audit = (req, action, summary, { targetType = 'edit_batch', targetId = null } = {}) =>
    recordAudit(pool, { actor: req.session.username, action, targetType, targetId, summary, ip: req.ip });

  const formOf = (body) => ({
    instruction: str(body.instruction),
    category: str(body.category),
    docs: str(body.docs),
    includeUnpublished: body.include_unpublished === 'yes',
  });

  async function renderForm(res, status, { errors = [], form = null } = {}) {
    const tree = await loadTree(pool);
    res.status(status).render('admin/edit', {
      title: 'Bulk AI edit',
      errors,
      form: form ?? { instruction: '', category: '', docs: '', includeUnpublished: false },
      categoryOptions: tree.nodes.map((n) => ({ id: String(n.id), label: `${'— '.repeat(n.depth - 1)}${n.name}` })),
      instructionMax: INSTRUCTION_MAX,
      maxDocs: config.bulkEdit.maxDocs,
      ai: await aiOverview(pool, config),
      batches: await listBatches(pool, RECENT_BATCHES),
    });
  }

  // The dry run: what the batch would do and cost. Nothing is created.
  async function renderConfirm(res, status, scope, { errors = [] } = {}) {
    const tree = await loadTree(pool);
    const { matched, excluded, unpublished, unknown } = await findScopeDocs(pool, tree, scope);
    const ai = await aiOverview(pool, config);
    const backup = await getBackupAge();
    const calls = estimateCalls(matched.length, config.bulkEdit.maxRetries);
    const overLimit = matched.length > config.bulkEdit.maxDocs;
    res.status(status).render('admin/edit-confirm', {
      title: 'Confirm the bulk edit',
      errors,
      scope,
      scopeLabel: scope.categoryId === null ? '' : tree.byId.get(scope.categoryId).name,
      matched: matched.map((d) => ({ id: d.id, title: d.title, slug: d.slug, bytes: d.size_bytes ?? 0, published: Boolean(d.published) })),
      excluded: excluded.map(({ doc, reason }) => ({ id: doc.id, title: doc.title, slug: doc.slug, reason })),
      unpublished,
      unknown,
      aiOn: aiConfigured(config),
      ai,
      calls,
      remaining: Math.max(0, ai.usage.cap - ai.usage.used),
      allowance: allowanceNeeded(ai.usage, calls.expected),
      backupKnown: backup.known,
      backupDays: backup.known ? backup.days : 0,
      maxDocs: config.bulkEdit.maxDocs,
      maxRetries: config.bulkEdit.maxRetries,
      overLimit,
      canConfirm: aiConfigured(config) && matched.length > 0 && !overLimit,
      docIds: matched.map((d) => d.id).join(','),
    });
  }

  router.get('/', needAdmin, (req, res) => renderForm(res, 200));

  // Step 1: validate the form and show the dry run.
  router.post('/', needAdmin, verifyCsrf, async (req, res) => {
    const form = formOf(req.body);
    const parsed = parseEditForm(form, await loadTree(pool));
    if (!parsed.ok) return renderForm(res, 400, { errors: parsed.errors, form });
    if (!aiConfigured(config)) return renderForm(res, 400, { errors: ['The AI is not configured (AI_BASE_URL, AI_API_KEY and AI_MODEL), so there is nothing to run the edit with.'], form });
    return renderConfirm(res, 200, parsed.scope);
  });

  // Step 2: the admin has seen the matched documents and the call count. The scope is matched
  // again, since documents may have changed in between, and must give the same list.
  router.post('/confirm', needAdmin, verifyCsrf, async (req, res) => {
    const form = formOf(req.body);
    const parsed = parseEditForm(form, await loadTree(pool));
    if (!parsed.ok) return renderForm(res, 400, { errors: parsed.errors, form });
    if (!aiConfigured(config)) return renderForm(res, 400, { errors: ['The AI is not configured, so the edit cannot run.'], form });
    const { scope } = parsed;
    if (req.body.confirm !== 'yes') return renderConfirm(res, 400, scope, { errors: ['Tick the box to confirm the bulk edit.'] });

    const { matched } = await findScopeDocs(pool, await loadTree(pool), scope);
    if (matched.length === 0) return renderConfirm(res, 400, scope, { errors: ['No document can be edited with this scope.'] });
    if (matched.length > config.bulkEdit.maxDocs) {
      return renderConfirm(res, 400, scope, { errors: [`The scope matches ${matched.length} documents; a batch is limited to ${config.bulkEdit.maxDocs}. Narrow the scope.`] });
    }
    if (matched.map((d) => d.id).join(',') !== str(req.body.doc_ids)) {
      return renderConfirm(res, 409, scope, { errors: ['The matching documents changed since you looked. Check the list again and confirm.'] });
    }

    const aiCalls = estimateCalls(matched.length, config.bulkEdit.maxRetries).expected;
    const ai = await aiOverview(pool, config);
    const extraCalls = allowanceNeeded(ai.usage, aiCalls);
    if (extraCalls > 0) await grantAllowance(pool, extraCalls);

    const batchId = await createBatch(pool, config, { actor: req.session.username, scope, docs: matched, aiCalls, extraCalls });
    await audit(
      req,
      'edit.batch_start',
      `Started bulk edit ${batchId} over ${matched.length} document${matched.length === 1 ? '' : 's'}: ${aiCalls} AI calls expected, ${extraCalls} above the daily cap.`,
      { targetId: batchId },
    );
    res.redirect(303, `/admin/edit/${batchId}`);
  });

  // ------------------------------------------------------------------ batch

  async function loadBatch(req, res, next) {
    const id = parseId(req.params.id);
    req.batch = id === null ? null : await getBatch(pool, id);
    if (!req.batch) return notFound(res);
    next();
  }

  async function renderBatch(res, status, batch, { notice = null, result = null } = {}) {
    res.status(status).render('admin/edit-batch', {
      title: `Bulk edit ${batch.id}`,
      notice,
      result,
      batch,
      rows: await getBatchDocs(pool, batch.id),
      ai: await aiOverview(pool, config),
      aiOn: aiConfigured(config),
    });
  }

  router.get('/:id', needAdmin, loadBatch, (req, res) => renderBatch(res, 200, req.batch, { notice: noticeFrom(NOTICES, req) }));

  router.post('/:id/stop', needAdmin, verifyCsrf, loadBatch, async (req, res) => {
    const cancelled = await stopBatch(pool, req.batch.id);
    await audit(req, 'edit.batch_stop', `Stopped bulk edit ${req.batch.id}: ${cancelled} queued document${cancelled === 1 ? '' : 's'} cancelled.`, { targetId: req.batch.id });
    res.redirect(303, `/admin/edit/${req.batch.id}?msg=stopped`);
  });

  router.post('/:id/retry', needAdmin, verifyCsrf, loadBatch, async (req, res) => {
    if (!aiConfigured(config)) return renderBatch(res, 400, req.batch, { notice: { kind: 'warn', text: 'The AI is not configured, so nothing can be retried.' } });
    const { retried } = await retryFailed(pool, req.batch.id);
    if (retried === 0) return res.redirect(303, `/admin/edit/${req.batch.id}?msg=retried-none`);
    await audit(req, 'edit.batch_retry', `Retried ${retried} document${retried === 1 ? '' : 's'} of bulk edit ${req.batch.id}.`, { targetId: req.batch.id });
    res.redirect(303, `/admin/edit/${req.batch.id}?msg=retried`);
  });

  // Approve the ticked documents, or every one that is ready (mode "ready").
  router.post('/:id/approve', needAdmin, verifyCsrf, loadBatch, async (req, res) => {
    const chosen = new Set([req.body.ids].flat().map((v) => parseId(str(v))).filter((id) => id !== null));
    const rows = (await getBatchDocs(pool, req.batch.id)).filter((r) => (req.body.mode === 'ready' ? r.status === 'ready' : chosen.has(r.docId)));
    if (rows.length === 0) return res.redirect(303, `/admin/edit/${req.batch.id}?msg=none-selected`);

    const { approved, skipped } = await approveRows(pool, config, rows);
    for (const row of approved) {
      await audit(req, 'doc.edit_approve', `Approved the bulk edit of "${row.slug}" (batch ${req.batch.id}). The new version is live.`, { targetType: 'doc', targetId: row.docId });
    }
    const fresh = await getBatch(pool, req.batch.id);
    return renderBatch(res, 200, fresh, {
      result: { approved: approved.length, skipped: skipped.map(({ row, reason }) => ({ docId: row.docId, title: row.title, reason })) },
    });
  });

  // ------------------------------------------------------- one doc's review

  async function loadRow(req, res, next) {
    const docId = parseId(req.params.docId);
    req.row = docId === null ? null : await getBatchDoc(pool, req.batch.id, docId);
    if (!req.row) return notFound(res);
    next();
  }

  async function renderDoc(res, status, batch, row, { errors = [], notice = null, text = null } = {}) {
    const proposal = row.canReview ? await loadProposal(config, { id: row.docId, slug: row.slug }) : null;
    res.status(status).render('admin/edit-doc', {
      title: `Bulk edit ${batch.id}: ${row.title}`,
      errors,
      notice,
      batch,
      row,
      problem: proposal && !proposal.ok ? proposal.reason : '',
      diff: proposal?.ok ? proposal.diff : null,
      bodyValue: text ?? (proposal?.ok ? proposal.body : ''),
    });
  }

  router.get('/:id/doc/:docId', needAdmin, loadBatch, loadRow, (req, res) =>
    renderDoc(res, 200, req.batch, req.row, { notice: noticeFrom(NOTICES, req) }),
  );

  const auditDoc = (req, action, summary) => audit(req, action, summary, { targetType: 'doc', targetId: req.row.docId });

  async function approveOne(req, res) {
    const { approved, skipped } = await approveRows(pool, config, [req.row]);
    if (approved.length === 0) return renderDoc(res, 409, req.batch, req.row, { errors: [`Not approved: ${skipped[0].reason}.`] });
    await auditDoc(req, 'doc.edit_approve', `Approved the bulk edit of "${req.row.slug}" (batch ${req.batch.id}). The new version is live.`);
    return res.redirect(303, `/admin/edit/${req.batch.id}?msg=approved`);
  }

  router.post('/:id/doc/:docId/approve', needAdmin, verifyCsrf, loadBatch, loadRow, approveOne);

  router.post('/:id/doc/:docId/reject', needAdmin, verifyCsrf, loadBatch, loadRow, async (req, res) => {
    if (req.row.status !== 'ready') return renderDoc(res, 409, req.batch, req.row, { errors: ['Only a proposal that is ready for review can be rejected.'] });
    await rejectRow(pool, config, req.row);
    await auditDoc(req, 'doc.edit_reject', `Rejected the bulk edit of "${req.row.slug}" (batch ${req.batch.id}). The live version is unchanged.`);
    res.redirect(303, `/admin/edit/${req.batch.id}?msg=rejected`);
  });

  // Save the admin's own edit of the proposal, and optionally approve it (the button pressed, `intent`).
  router.post('/:id/doc/:docId/save', needAdmin, verifyCsrf, loadBatch, loadRow, async (req, res) => {
    const text = str(req.body.body);
    const saved = await saveHandEdit(pool, config, req.row, text);
    if (!saved.ok) return renderDoc(res, 400, req.batch, req.row, { errors: saved.errors, text });
    await auditDoc(req, 'doc.edit_hand', `Edited the proposal for "${req.row.slug}" by hand (batch ${req.batch.id}).`);
    if (req.body.intent !== 'approve') return res.redirect(303, `/admin/edit/${req.batch.id}/doc/${req.row.docId}?msg=saved`);
    req.row = await getBatchDoc(pool, req.batch.id, req.row.docId);
    return approveOne(req, res);
  });

  return router;
}
