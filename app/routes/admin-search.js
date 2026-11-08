import { Router } from 'express';
import multer from 'multer';
import { verifyCsrf } from '../middleware/admin-session.js';
import { recordAudit } from '../services/audit.js';
import { EVAL_MAX_QUERIES, TOP_N, parseTestSet, runEvaluation } from '../services/search-eval.js';
import { MIN_SEARCHES, MISS_THRESHOLD, searchReport } from '../services/search-log.js';

const EVAL_MAX_BYTES = 256 * 1024;

// The admin side of search (roadmap Phase 4): the miss report built from the
// search log, and the evaluation page that runs a test set against the index.
export function adminSearchRouter({ pool, config, needAdmin }) {
  const router = Router();

  // Multipart parsing happens after the admin check and before the CSRF check,
  // because the token is a form field. The test set stays in memory (small cap).
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: EVAL_MAX_BYTES, files: 1, fields: 3, fieldSize: 1024, parts: 5 },
    defParamCharset: 'utf8',
  }).single('file');
  const receiveUpload = (req, res, next) =>
    upload(req, res, (err) => {
      req.uploadError = err ?? null;
      next();
    });

  const renderEval = (res, status, { errors = [], report = null } = {}) =>
    res.status(status).render('admin/search-eval', {
      title: 'Search evaluation',
      errors,
      report,
      maxBytes: EVAL_MAX_BYTES,
      maxQueries: EVAL_MAX_QUERIES,
      topN: TOP_N,
      weights: config.search.weights,
    });

  router.get('/', needAdmin, async (req, res) => {
    const report = await searchReport(pool);
    res.render('admin/search', {
      title: 'Search report',
      report,
      threshold: Math.round(MISS_THRESHOLD * 100),
      minSearches: MIN_SEARCHES,
      retentionDays: config.search.logRetentionDays,
    });
  });

  router.get('/eval', needAdmin, (req, res) => renderEval(res, 200));

  router.post('/eval', needAdmin, receiveUpload, verifyCsrf, async (req, res) => {
    if (req.uploadError) {
      const tooBig = req.uploadError.code === 'LIMIT_FILE_SIZE';
      return renderEval(res, tooBig ? 413 : 400, {
        errors: [tooBig ? `The file is over the ${EVAL_MAX_BYTES} byte limit.` : 'The upload could not be read. Choose the file again.'],
      });
    }
    if (!req.file || req.file.buffer.length === 0) return renderEval(res, 400, { errors: ['Choose a test set file (.json) to upload.'] });

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(req.file.buffer);
    } catch {
      return renderEval(res, 400, { errors: ['The file is not valid UTF-8.'] });
    }
    const parsed = parseTestSet(text);
    if (!parsed.ok) return renderEval(res, 400, { errors: [parsed.error] });

    const report = await runEvaluation(pool, config, parsed.queries);
    await recordAudit(pool, {
      actor: req.session.username,
      action: 'search.eval',
      summary: `Ran a search evaluation of ${report.summary.total} queries.`,
      ip: req.ip,
    });
    renderEval(res, 200, { report });
  });

  return router;
}
