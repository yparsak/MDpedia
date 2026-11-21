import { Router } from 'express';
import { verifyCsrf } from '../middleware/admin-session.js';
import { recordAudit } from '../services/audit.js';
import { TASKS, lastRuns, runMaintenance } from '../services/maintenance.js';
import { noticeFrom } from '../services/notices.js';

const NOTICES = {
  ran: { kind: 'ok', text: 'Maintenance ran. The counts of removed rows are in the table below.' },
  failed: { kind: 'warn', text: 'Maintenance ran, but at least one task failed. See the table and the server log.' },
  busy: { kind: 'warn', text: 'Maintenance is already running. Reload this page in a moment.' },
};

// Maintenance page (roadmap Phase 10): the pruning tasks with their last run
// and what they removed, a button to run them now, and the backup status.
export function adminMaintenanceRouter({ pool, config, needAdmin }) {
  const router = Router();

  router.get('/', needAdmin, async (req, res) => {
    const last = await lastRuns(pool);
    res.render('admin/maintenance', {
      title: 'Maintenance',
      notice: noticeFrom(NOTICES, req),
      tasks: TASKS.map((task) => ({ key: task.key, label: task.label, rule: task.rule(config), last: last.get(task.key) ?? null })),
    });
  });

  router.post('/run', needAdmin, verifyCsrf, async (req, res) => {
    const { busy, results } = await runMaintenance(pool, config, { trigger: 'manual' });
    if (busy) return res.redirect(303, '/admin/maintenance?msg=busy');
    const pruned = results.reduce((sum, r) => sum + r.pruned, 0);
    const failed = results.filter((r) => r.status === 'failed').length;
    await recordAudit(pool, {
      actor: req.session.username,
      action: 'maintenance.run',
      summary: `Ran maintenance by hand: ${pruned} row${pruned === 1 ? '' : 's'} removed${failed > 0 ? `, ${failed} task${failed === 1 ? '' : 's'} failed` : ''}.`,
      ip: req.ip,
    });
    res.redirect(303, `/admin/maintenance?msg=${failed > 0 ? 'failed' : 'ran'}`);
  });

  return router;
}
