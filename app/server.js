import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, loadConfig, summarize } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { createWorker } from './services/ai-worker.js';
import { createReconciler } from './services/reconcile.js';
import { createLoopMonitor } from './services/loops.js';
import { createMaintenance } from './services/maintenance.js';
import { runSelfCheck } from './services/selfcheck.js';
import { log, errorFields } from './logger.js';

const { version } = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

const { envPath, found } = loadEnvFile();
const result = loadConfig();

if (!result.ok) {
  console.error(`\nMDpedia cannot start. Fix these values in ${envPath}${found ? '' : ' (file not found)'}:\n`);
  for (const message of result.errors) console.error(`  - ${message}`);
  console.error('');
  process.exit(1);
}

const { config } = result;
const pool = createPool(config.db);
const loops = createLoopMonitor();
const app = createApp({ config, pool, loops });
const worker = createWorker({ pool, config, loops });
const maintenance = createMaintenance({ pool, config });
const reconciler = createReconciler({ pool, config });

console.log(`\nMDpedia ${version}`);
for (const line of summarize(config)) console.log(`  ${line}`);
console.log('');

const server = app.listen(config.server.port, config.server.host, async () => {
  console.log(`Listening on http://${config.server.host}:${config.server.port}\n`);
  console.log('Self-check:');
  for (const { level, text } of await runSelfCheck(pool, config)) {
    console.log(`  [${level}] ${text}`);
  }
  console.log('');
  // After the self-check, so a database that is down or behind is reported first.
  // The worker does nothing unless the AI is configured.
  await worker.start();
  // The file wins: edits made over SSH reach the database here, now and every RECONCILE_INTERVAL_MINUTES.
  await reconciler.start();
});

// Pruning (search log, audit log, finished jobs) runs at start and every six hours,
// and by hand from /admin/maintenance. A failure is logged and the app carries on.
maintenance.start();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.server.port} is already in use. Change PORT in ${envPath} or stop the other process.`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(`HOST ${config.server.host} is not an address of this machine. Check HOST in ${envPath}.`);
  } else {
    console.error(`Could not start the server: ${err.message}`);
  }
  process.exit(1);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  server.close(async () => {
    try {
      // Aborts calls in flight and puts their jobs back before the pool closes.
      reconciler.stop();
      maintenance.stop();
      await worker.stop();
      await pool.end();
    } catch (err) {
      log.error('error closing the database pool', errorFields(err));
    }
    process.exit(0);
  });
  // Do not hang forever on keep-alive connections.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
