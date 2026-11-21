// How old the last backup is (brainstorm section 6). scripts/backup.sh records a
// success in the backup_status table and in DATA_DIR/last-backup.txt on the Pi,
// both only after a verified copy. The newer of the two wins, so a backup whose
// table update failed still counts. A failed attempt never moves the age.
//
// getBackupAge never throws: a missing table (migration not applied) or a down
// database reads as "no backup known", which is also what the warning says.

import fs from 'node:fs/promises';
import path from 'node:path';

export const BACKUP_FILE = 'last-backup.txt';
const SECONDS_PER_DAY = 86400;

// The file is `epoch=<seconds>` on one line, written by the script.
export function parseBackupFile(text) {
  const match = /^epoch=(\d{1,12})$/m.exec(String(text));
  return match ? Number(match[1]) : null;
}

// Pure: the numbers the pages show. Epochs are in seconds; successEpoch may be null.
export function describeBackup({ successEpoch, nowEpoch, staleDays }) {
  if (successEpoch === null || successEpoch === undefined) {
    return { known: false, days: 0, stale: true, staleDays };
  }
  const days = Math.floor(Math.max(0, nowEpoch - successEpoch) / SECONDS_PER_DAY);
  // "N days or more" is stale, so BACKUP_STALE_DAYS=0 always warns.
  return { known: true, days, stale: days >= staleDays, staleDays };
}

async function readTable(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT UNIX_TIMESTAMP(last_success_at) AS success_epoch, UNIX_TIMESTAMP(NOW()) AS now_epoch,
              last_success_at, last_attempt_at, last_result, last_message, last_target, docs_count, dump_bytes
         FROM backup_status WHERE id = 1`,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function readFileEpoch(config) {
  try {
    return parseBackupFile(await fs.readFile(path.join(config.paths.data, BACKUP_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// Resolves to { known, days, stale, staleDays, lastSuccessAt, lastAttemptAt,
// lastResult, lastMessage, target, docsCount, dumpBytes }.
export async function getBackupAge(pool, config) {
  const row = await readTable(pool);
  const fileEpoch = await readFileEpoch(config);
  const tableEpoch = row?.success_epoch === null || row?.success_epoch === undefined ? null : Number(row.success_epoch);
  const successEpoch = [tableEpoch, fileEpoch].filter((e) => e !== null).reduce((a, b) => Math.max(a, b), null);
  const nowEpoch = row?.now_epoch ? Number(row.now_epoch) : Math.floor(Date.now() / 1000);

  const fileIsNewer = fileEpoch !== null && (tableEpoch === null || fileEpoch > tableEpoch);
  return {
    ...describeBackup({ successEpoch, nowEpoch, staleDays: config.retention.backupStaleDays }),
    lastSuccessAt: fileIsNewer ? `${new Date(fileEpoch * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : (row?.last_success_at ?? ''),
    lastAttemptAt: row?.last_attempt_at ?? '',
    lastResult: row?.last_result ?? '',
    lastMessage: row?.last_message ?? '',
    target: row?.last_target ?? '',
    docsCount: row?.docs_count ?? null,
    dumpBytes: row?.dump_bytes === null || row?.dump_bytes === undefined ? null : Number(row.dump_bytes),
  };
}
