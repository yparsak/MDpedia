import { Router } from 'express';
import { databaseAnswers } from '../services/status.js';

// The status page moved to /admin/status in Phase 2, when "/" became the reader
// home page. Only the public health probe stays here.
// `loops` is the heartbeat monitor (services/loops.js); without one only the
// database is checked.
export function statusRouter({ pool, loops = null }) {
  const router = Router();

  // 200 only if the database answers and every background loop that was started
  // is alive. It exposes no other detail (brainstorm 5.17): not which check failed.
  router.get('/healthz', async (req, res) => {
    const ok = (await databaseAnswers(pool)) && (loops === null || loops.allAlive());
    res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'fail' });
  });

  return router;
}
