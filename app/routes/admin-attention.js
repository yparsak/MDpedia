import { Router } from 'express';
import { verifyCsrf } from '../middleware/admin-session.js';
import { recordAudit } from '../services/audit.js';
import { noticeFrom } from '../services/notices.js';
import { getReconcileState, listAttention, reconcile } from '../services/reconcile.js';
import { cleanupStaged, listStaged } from '../services/replace.js';

const NOTICES = {
  rescanned: { kind: 'ok', text: 'Rescan finished. The summary of the scan is below.' },
  busy: { kind: 'warn', text: 'A scan is already running. Try again in a moment.' },
  cleaned: { kind: 'ok', text: 'Abandoned staged versions were removed.' },
  'nothing-to-clean': { kind: 'warn', text: 'Nothing to clean up: no staged version is older than the retention period.' },
};

const ATTENTION_LABELS = { invalid: 'Needs attention', missing: 'Missing' };
const STAGED_LABELS = { processing: 'AI refreshing keywords', ready: 'Ready to approve', failed: 'Keyword refresh failed' };

// The Attention page (roadmap Phase 8): every doc in a problem state with the
// reason, files the scan rejected, staged replacements, and the rescan and cleanup buttons.
export function adminAttentionRouter({ pool, config, needAdmin }) {
  const router = Router();

  const audit = (req, action, summary) =>
    recordAudit(pool, { actor: req.session.username, action, summary, ip: req.ip });

  router.get('/', needAdmin, async (req, res) => {
    const { docs, files } = await listAttention(pool);
    const staged = await listStaged(pool);
    res.render('admin/attention', {
      title: 'Attention',
      notice: noticeFrom(NOTICES, req),
      docs: docs.map((d) => ({
        id: d.id,
        slug: d.slug,
        title: d.title,
        published: Boolean(d.published),
        kind: d.attention,
        label: ATTENTION_LABELS[d.attention] ?? d.attention,
        reason: d.attention_reason ?? '',
        since: d.attention_at ?? '',
      })),
      files: files.map((f) => ({ name: f.file_name, kind: f.kind, docId: f.doc_id, reason: f.reason, since: f.detected_at })),
      staged: staged.map((d) => ({
        id: d.id,
        slug: d.slug,
        title: d.title,
        at: d.staged_at,
        statusLabel: STAGED_LABELS[d.staged_status] ?? d.staged_status,
      })),
      scan: await getReconcileState(pool),
      intervalMinutes: config.worker.reconcileIntervalMinutes,
      stagedRetentionDays: config.worker.stagedRetentionDays,
    });
  });

  router.post('/rescan', needAdmin, verifyCsrf, async (req, res) => {
    const result = await reconcile(pool, config, { trigger: 'manual' });
    if (result.skipped) return res.redirect(303, '/admin/attention?msg=busy');
    await audit(req, 'reconcile.rescan', `Rescanned the docs directory: ${result.read} read, ${result.updated} updated, ${result.flagged} flagged.`);
    res.redirect(303, '/admin/attention?msg=rescanned');
  });

  router.post('/cleanup', needAdmin, verifyCsrf, async (req, res) => {
    const result = await cleanupStaged(pool, config);
    if (result.discarded + result.orphans === 0) return res.redirect(303, '/admin/attention?msg=nothing-to-clean');
    await audit(req, 'staging.cleanup', `Removed ${result.discarded} abandoned staged version${result.discarded === 1 ? '' : 's'} and ${result.orphans} stray staging file${result.orphans === 1 ? '' : 's'}.`);
    res.redirect(303, '/admin/attention?msg=cleaned');
  });

  return router;
}
