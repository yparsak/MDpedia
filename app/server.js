import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, loadConfig, summarize } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
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
const app = createApp({ config, pool });

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
});

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
