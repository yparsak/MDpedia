// Startup self-check (roadmap section 1, point 5). Prints clear messages and
// never stops the app: a database that is down or behind is shown on the status
// page, not a reason to crash.

import fs from 'node:fs/promises';
import { getStatus } from './status.js';

async function checkDirectory(label, dir) {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return { level: 'warn', text: `${label}: ${dir} exists but is not a directory`, dev: null };
    await fs.access(dir, fs.constants.W_OK);
    return { level: 'ok', text: `${label}: ${dir} exists and is writable`, dev: stat.dev };
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'does not exist' : err.code === 'EACCES' ? 'is not writable by this user' : err.code;
    return { level: 'warn', text: `${label}: ${dir} ${why} (needed from Phase 2)`, dev: null };
  }
}

export async function runSelfCheck(pool, config) {
  const lines = [];
  const status = await getStatus(pool);

  if (status.db === 'unreachable') {
    lines.push({ level: 'warn', text: `database: cannot connect (${status.errorCode}). The status page will say so; the app keeps running.` });
  } else {
    lines.push({ level: 'ok', text: `database: connected, MariaDB ${status.serverVersion}` });
    if (status.schema === 'ok') {
      lines.push({ level: 'ok', text: `schema: version ${status.schemaVersion}, up to date` });
    } else {
      lines.push({ level: 'warn', text: `schema: database is behind. Missing ${status.missing.join(', ')}. Run: make migrate` });
    }

    try {
      const [rows] = await pool.query("SHOW VARIABLES LIKE 'innodb_ft_min_token_size'");
      const size = rows[0]?.Value;
      lines.push(
        size === '2'
          ? { level: 'ok', text: 'innodb_ft_min_token_size = 2' }
          : { level: 'warn', text: `innodb_ft_min_token_size = ${size ?? 'unknown'}, must be 2 before Phase 2 (brainstorm 5.2)` },
      );
    } catch {
      lines.push({ level: 'warn', text: 'innodb_ft_min_token_size: could not be read' });
    }
  }

  const docs = await checkDirectory('docs dir', config.paths.docs);
  const staging = await checkDirectory('staging dir', config.paths.staging);
  lines.push(docs, staging);
  if (docs.dev !== null && staging.dev !== null && docs.dev !== staging.dev) {
    lines.push({ level: 'warn', text: 'docs and staging are on different filesystems; the atomic rename in Phase 2 will fail' });
  }

  return lines;
}
