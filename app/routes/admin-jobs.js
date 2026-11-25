import { Router } from 'express';
import { verifyCsrf } from '../middleware/admin-session.js';
import { aiOverview } from '../services/ai-status.js';
import { resume } from '../services/ai-circuit.js';
import { recordAudit } from '../services/audit.js';
import { JOB_STATUSES, dismissJob, listJobs, retryAllFailed, retryJob } from '../services/jobs.js';
import { noticeFrom } from '../services/notices.js';
import { pageCount, parsePage } from '../services/pagination.js';

const JOB_PAGE_SIZE = 50;

const NOTICES = {
  resumed: { kind: 'ok', text: 'The AI queue is running again. Retry the failed jobs if you want them run.' },
  retried: { kind: 'ok', text: 'The job is queued again with a fresh set of attempts.' },
  'retried-all': { kind: 'ok', text: 'Every failed job is queued again.' },
  'retried-none': { kind: 'warn', text: 'There are no failed jobs to retry.' },
  dismissed: { kind: 'ok', text: 'The job was removed from the list.' },
  unchanged: { kind: 'warn', text: 'Nothing changed. The job is not in a state that allows that.' },
};

// The filter links; only these keys are honoured.
const FILTERS = [{ key: 'all', label: 'All', status: null }, ...JOB_STATUSES.map((s) => ({ key: s, label: s[0].toUpperCase() + s.slice(1), status: s }))];

const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);

// The AI job queue: what is waiting, running, done and failed,
// with retry and dismiss, and the resume button for the circuit breaker.
export function adminJobsRouter({ pool, config, needAdmin }) {
  const router = Router();

  const audit = (req, action, summary, jobId = null) =>
    recordAudit(pool, { actor: req.session.username, action, targetType: jobId === null ? null : 'job', targetId: jobId, summary, ip: req.ip });

  router.get('/', needAdmin, async (req, res) => {
    const filter = FILTERS.find((f) => f.key === req.query.status) ?? FILTERS[0];
    const page = parsePage(req.query.page);
    const { total, rows } = await listJobs(pool, { status: filter.status, limit: JOB_PAGE_SIZE, offset: (page - 1) * JOB_PAGE_SIZE });
    res.render('admin/jobs', {
      title: 'AI jobs',
      notice: noticeFrom(NOTICES, req),
      ai: await aiOverview(pool, config),
      filters: FILTERS.map(({ key, label }) => ({ key, label, active: key === filter.key })),
      filterKey: filter.key,
      rows: rows.map(jobView),
      page,
      pages: pageCount(total, JOB_PAGE_SIZE),
      total,
      retentionDays: config.worker.jobRetentionDays,
    });
  });

  router.post('/resume', needAdmin, verifyCsrf, async (req, res) => {
    await resume(pool);
    await audit(req, 'ai.resume', 'Resumed the AI queue after a pause.');
    res.redirect(303, '/admin/jobs?msg=resumed');
  });

  router.post('/retry-all', needAdmin, verifyCsrf, async (req, res) => {
    const retried = await retryAllFailed(pool);
    if (retried === 0) return res.redirect(303, '/admin/jobs?msg=retried-none');
    await audit(req, 'job.retry_all', `Retried ${retried} failed job${retried === 1 ? '' : 's'}.`);
    res.redirect(303, '/admin/jobs?msg=retried-all');
  });

  router.post('/:id/retry', needAdmin, verifyCsrf, async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await retryJob(pool, id))) return res.redirect(303, '/admin/jobs?msg=unchanged');
    await audit(req, 'job.retry', `Retried job ${id}.`, id);
    res.redirect(303, '/admin/jobs?msg=retried');
  });

  router.post('/:id/dismiss', needAdmin, verifyCsrf, async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await dismissJob(pool, id))) return res.redirect(303, '/admin/jobs?msg=unchanged');
    await audit(req, 'job.dismiss', `Dismissed job ${id}.`, id);
    res.redirect(303, '/admin/jobs?msg=dismissed');
  });

  return router;
}

// Template rows are built field by field.
function jobView(j) {
  return {
    id: j.id,
    docId: j.doc_id,
    docTitle: j.doc_title,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    lastError: j.last_error ?? '',
    runAfter: j.run_after,
    createdAt: j.created_at,
    finishedAt: j.finished_at ?? '',
  };
}
