// The audit log (brainstorm section 7). Append-only: this module only inserts
// and reads, and nothing in the app updates or deletes rows. Pruning by age
// arrives in Phase 10.
//
// Never pass a password, a session ID, the API key or document text to
// recordAudit. Summaries are short sentences written by the caller.

import { log, errorFields } from '../logger.js';

const SUMMARY_MAX = 500;

// A failed audit write is logged but does not stop the action that was audited:
// a database hiccup must not lock the admin out of logging in or out.
export async function recordAudit(pool, { actor, action, targetType = null, targetId = null, summary = '', ip = null }) {
  try {
    await pool.query(
      'INSERT INTO audit_log (actor, action, target_type, target_id, summary, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [
        String(actor).slice(0, 64),
        String(action).slice(0, 64),
        targetType === null ? null : String(targetType).slice(0, 32),
        targetId === null ? null : String(targetId).slice(0, 64),
        String(summary).slice(0, SUMMARY_MAX),
        ip === null ? null : String(ip).slice(0, 45),
      ],
    );
    return true;
  } catch (err) {
    log.error('audit write failed', { action, ...errorFields(err) });
    return false;
  }
}

// Newest first. Times come back as strings in the database server's clock.
export async function listAudit(pool, { limit, offset }) {
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM audit_log');
  const [rows] = await pool.query(
    `SELECT id, created_at, actor, action, target_type, target_id, summary, ip
       FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return { total: Number(total), rows };
}
