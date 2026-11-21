import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_FILE, describeBackup, getBackupAge, parseBackupFile } from '../app/services/backup-status.js';

const DAY = 86400;

test('days are whole days since the last success', () => {
  const now = 10 * DAY;
  assert.equal(describeBackup({ successEpoch: now - 3 * DAY - 100, nowEpoch: now, staleDays: 7 }).days, 3);
  assert.equal(describeBackup({ successEpoch: now - 60, nowEpoch: now, staleDays: 7 }).days, 0);
  assert.equal(describeBackup({ successEpoch: now + 500, nowEpoch: now, staleDays: 7 }).days, 0, 'a clock skew never gives a negative age');
});

test('stale is "N days or more", so BACKUP_STALE_DAYS=0 always warns', () => {
  const now = 100 * DAY;
  assert.equal(describeBackup({ successEpoch: now - 6 * DAY, nowEpoch: now, staleDays: 7 }).stale, false);
  assert.equal(describeBackup({ successEpoch: now - 7 * DAY, nowEpoch: now, staleDays: 7 }).stale, true);
  assert.equal(describeBackup({ successEpoch: now - 5, nowEpoch: now, staleDays: 0 }).stale, true);
});

test('no backup on record is unknown and stale', () => {
  assert.deepEqual(describeBackup({ successEpoch: null, nowEpoch: 5, staleDays: 7 }), { known: false, days: 0, stale: true, staleDays: 7 });
});

test('the file format is read, and rubbish is not', () => {
  assert.equal(parseBackupFile('epoch=1700000000\niso=2023-11-14T22:13:20Z\n'), 1700000000);
  assert.equal(parseBackupFile('epoch=abc'), null);
  assert.equal(parseBackupFile(''), null);
});

const config = (dataDir, staleDays = 7) => ({ paths: { data: dataDir }, retention: { backupStaleDays: staleDays } });

test('a missing table and a missing file read as no backup, without throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdpedia-backup-test-'));
  const pool = { query: async () => { throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' }); } };
  const age = await getBackupAge(pool, config(dir));
  assert.equal(age.known, false);
  assert.equal(age.stale, true);
  await fs.rm(dir, { recursive: true });
});

test('the newer of the table and the file wins; a failed attempt does not move the age', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdpedia-backup-test-'));
  const now = 1_800_000_000;
  const row = { success_epoch: now - 5 * DAY, now_epoch: now, last_success_at: '2026-01-01 10:00:00', last_attempt_at: '2026-01-06 10:00:00', last_result: 'failed', last_message: 'the backup drive is not mounted', last_target: null, docs_count: 12, dump_bytes: '999' };
  const pool = { query: async () => [[row]] };

  let age = await getBackupAge(pool, config(dir));
  assert.equal(age.days, 5);
  assert.equal(age.lastResult, 'failed');
  assert.equal(age.lastMessage, 'the backup drive is not mounted');
  assert.equal(age.dumpBytes, 999);

  await fs.writeFile(path.join(dir, BACKUP_FILE), `epoch=${now - 1 * DAY}\n`);
  age = await getBackupAge(pool, config(dir));
  assert.equal(age.days, 1, 'the file is newer than the table');
  await fs.rm(dir, { recursive: true });
});
