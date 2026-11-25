import { Router } from 'express';
import { aiConfigured } from '../config.js';
import { verifyCsrf } from '../middleware/admin-session.js';
import { receiveUploads } from '../middleware/receive-upload.js';
import { allowanceNeeded, getUsage, grantAllowance } from '../services/ai-usage.js';
import { recordAudit } from '../services/audit.js';
import { getBatchReport, isStageToken, listBatches, previewStaged, readStaged, removeStaged, runImport, stageFiles } from '../services/bulk-import.js';

const RECENT_BATCHES = 10;

const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);

// Bulk import: choose many files, confirm what it will cost, import,
// read the report. Approval comes afterwards, on the review queue.
export function adminImportRouter({ pool, config, needAdmin }) {
  const router = Router();

  const receive = receiveUploads({ maxBytes: config.uploads.maxBytes, maxFiles: config.uploads.bulkMaxFiles });

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  async function renderForm(res, status, errors = []) {
    res.status(status).render('admin/import', {
      title: 'Bulk import',
      errors,
      maxBytes: config.uploads.maxBytes,
      maxFiles: config.uploads.bulkMaxFiles,
      aiOn: aiConfigured(config),
      batches: (await listBatches(pool, RECENT_BATCHES)).map(batchView),
    });
  }

  // What the confirmation states: the calls the import will make, today's usage and
  // the allowance above the cap it needs. The age of the last backup comes from the
  // loadBackupAge middleware (res.locals.backup).
  async function renderConfirm(res, status, token, staged, errors = []) {
    const { accepted, skipped } = previewStaged(config, staged);
    const aiOn = aiConfigured(config);
    const calls = aiOn ? accepted.length : 0;
    const usage = await getUsage(pool, config.ai.dailyCap);
    res.status(status).render('admin/import-confirm', {
      title: 'Confirm the import',
      errors,
      token,
      accepted,
      skipped,
      aiOn,
      calls,
      usage,
      remaining: Math.max(0, usage.cap - usage.used),
      allowance: allowanceNeeded(usage, calls),
      maxAttempts: config.ai.maxAttempts,
    });
  }

  router.get('/', needAdmin, (req, res) => renderForm(res, 200));

  // Step 1: the files are staged, nothing is created yet.
  router.post('/', needAdmin, receive, verifyCsrf, async (req, res) => {
    if (req.uploadError) {
      const message =
        req.uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'A file is far over the upload limit. Remove it from the selection and try again.'
          : req.uploadError.code === 'LIMIT_UNEXPECTED_FILE'
            ? `Choose at most ${config.uploads.bulkMaxFiles} files.`
            : 'The upload could not be read. Choose the files again.';
      return renderForm(res, 400, [message]);
    }
    if (!req.files || req.files.length === 0) return renderForm(res, 400, ['Choose at least one Markdown (.md) file.']);

    const token = await stageFiles(config, req.files);
    return renderConfirm(res, 200, token, (await readStaged(config, token)) ?? []);
  });

  // Step 2: the admin has seen the call count. The allowance above the daily cap, if
  // one is needed, is granted now and spent only by the calls past the cap.
  router.post('/confirm', needAdmin, verifyCsrf, async (req, res) => {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const staged = isStageToken(token) ? await readStaged(config, token) : null;
    if (!staged) return renderForm(res, 400, ['That import is no longer waiting (it was already run, or it expired). Choose the files again.']);
    if (req.body.confirm !== 'yes') {
      return renderConfirm(res, 400, token, staged, ['Tick the box to confirm the import.']);
    }

    const { accepted } = previewStaged(config, staged);
    const calls = aiConfigured(config) ? accepted.length : 0;
    const extraCalls = allowanceNeeded(await getUsage(pool, config.ai.dailyCap), calls);
    if (extraCalls > 0) await grantAllowance(pool, extraCalls);

    const batchId = await runImport(pool, config, { actor: req.session.username, staged, aiCalls: calls, extraCalls });
    await removeStaged(config, token);
    await recordAudit(pool, {
      actor: req.session.username,
      action: 'doc.import',
      targetType: 'import',
      targetId: batchId,
      summary: `Bulk import of ${staged.length} file${staged.length === 1 ? '' : 's'}: ${calls} AI call${calls === 1 ? '' : 's'}, ${extraCalls} above the daily cap.`,
      ip: req.ip,
    });
    res.redirect(303, `/admin/import/${batchId}`);
  });

  // The import report.
  router.get('/:id', needAdmin, async (req, res) => {
    const id = parseId(req.params.id);
    const report = id === null ? null : await getBatchReport(pool, config, id);
    if (!report) return notFound(res);
    res.render('admin/import-report', {
      title: `Import report ${report.batch.id}`,
      batch: batchView(report.batch),
      items: report.items,
      held: report.items.filter((i) => i.exceptions.length > 0).length,
    });
  });

  return router;
}

// Template rows are built field by field.
function batchView(b) {
  return {
    id: b.id,
    actor: b.actor,
    fileCount: b.file_count,
    imported: b.imported,
    skipped: b.skipped,
    aiCalls: b.ai_calls,
    extraCalls: b.extra_calls,
    createdAt: b.created_at,
  };
}
