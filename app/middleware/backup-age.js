import { getBackupAge } from '../services/backup-status.js';

// Puts the age of the last backup in the template locals as `backup`, for the
// pages that sit in front of a risky change (bulk import, bulk approve, bulk AI
// edits, retrying AI jobs, category changes) and for the maintenance page.
// Skipped without a session: a logged-out request costs no query.
export function loadBackupAge({ pool, config }) {
  return async (req, res, next) => {
    if (!req.session) return next();
    res.locals.backup = await getBackupAge(pool, config);
    next();
  };
}
