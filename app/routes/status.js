import { Router } from 'express';
import { getStatus, databaseAnswers } from '../services/status.js';

// Phase 0 home page: proves the config, the database connection and the schema
// version. Phase 2 replaces "/" with the reader home page and moves this under /admin.
export function statusRouter({ pool, version, env }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const status = await getStatus(pool);
    const healthy = status.db === 'ok' && status.schema === 'ok';

    // Built field by field: request objects never go into render options (brainstorm 5.7).
    res.status(healthy ? 200 : 503).render('status', {
      title: 'Wiki status',
      version,
      env,
      status: {
        db: status.db,
        serverVersion: status.serverVersion,
        schema: status.schema,
        schemaVersion: status.schemaVersion,
        expectedVersion: status.expectedVersion,
        missing: status.missing,
      },
    });
  });

  // 200 only if the database answers. It exposes no other detail (brainstorm 5.17).
  // The worker-alive check is added in Phase 10, when a worker exists.
  router.get('/healthz', async (req, res) => {
    const ok = await databaseAnswers(pool);
    res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'fail' });
  });

  return router;
}
