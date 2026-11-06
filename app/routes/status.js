import { Router } from 'express';
import { databaseAnswers } from '../services/status.js';

// The status page moved to /admin/status in Phase 2, when "/" became the reader
// home page. Only the public health probe stays here.
export function statusRouter({ pool }) {
  const router = Router();

  // 200 only if the database answers. It exposes no other detail (brainstorm 5.17).
  // The worker-alive check is added in Phase 10, when a worker exists.
  router.get('/healthz', async (req, res) => {
    const ok = await databaseAnswers(pool);
    res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'fail' });
  });

  return router;
}
