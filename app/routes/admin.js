import express, { Router } from 'express';
import { loadAdminSession, noStore, requireAdmin, verifyCsrf } from '../middleware/admin-session.js';
import { FIELD, makeLoginToken, verifyLoginToken } from '../services/csrf.js';
import { createThrottle } from '../services/throttle.js';
import { recordAudit, listAudit } from '../services/audit.js';
import { categoryStats } from '../services/categories.js';
import { countByStatus } from '../services/docs.js';
import { noticeFrom } from '../services/notices.js';
import { pageCount, parsePage } from '../services/pagination.js';
import { getStatus } from '../services/status.js';
import { countUnresolved } from '../services/wiki-links.js';
import { adminCategoriesRouter } from './admin-categories.js';
import { adminDocsRouter } from './admin-docs.js';
import { adminLinksRouter } from './admin-links.js';
import { adminSearchRouter } from './admin-search.js';
import { findByUsername, normalizeUsername, recordLogin, setPassword } from '../services/admins.js';
import { hashPassword, passwordProblems, verifyAgainstDummy, verifyPassword } from '../services/passwords.js';
import {
  clearSessionCookie,
  createSession,
  destroyAllForAdmin,
  destroySessionByToken,
  purgeDead,
  setSessionCookie,
} from '../services/sessions.js';

const AUDIT_PAGE_SIZE = 50;

// Messages that may be shown after a redirect. Only these keys are honoured, so
// a crafted ?msg= can never put text of its own on the page.
const NOTICES = {
  'logged-out': { kind: 'ok', text: 'You have been logged out.' },
  expired: { kind: 'warn', text: 'Your session has ended. Log in again to continue.' },
  'password-changed': { kind: 'ok', text: 'Password changed. Any other sessions were logged out.' },
};

const noticeFor = (req) => noticeFrom(NOTICES, req);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function adminRouter({ pool, config, version }) {
  const router = Router();
  const loginThrottle = createThrottle({ maxFails: config.rate.loginFailsPer15Min });
  // The change-password form also checks a password, so it gets the same limit.
  const passwordThrottle = createThrottle({ maxFails: config.rate.loginFailsPer15Min });

  router.use(noStore);
  router.use(express.urlencoded({ extended: false, limit: '10kb' }));
  router.use(loadAdminSession({ pool, config }));

  const needAdmin = requireAdmin({ config });
  const secret = config.session.secret;

  const renderLogin = (res, status, { error = null, username = '', notice = null } = {}) =>
    res.status(status).render('login', {
      title: 'Admin login',
      loginToken: makeLoginToken(secret),
      error,
      notice,
      username,
    });

  // ------------------------------------------------------------------ login

  router.get('/login', (req, res) => {
    if (req.session) return res.redirect(303, '/admin');
    renderLogin(res, 200, { notice: noticeFor(req) });
  });

  router.post('/login', async (req, res) => {
    if (!verifyLoginToken(secret, req.body?.[FIELD])) {
      return renderLogin(res, 403, { error: 'The form expired. Please try again.' });
    }

    const ip = req.ip;
    const username = normalizeUsername(req.body.username);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    const gate = loginThrottle.check(ip);
    if (gate.blocked) return tooManyAttempts(res, gate.retryAfterSeconds, username);

    const admin = username.length <= 64 ? await findByUsername(pool, username) : null;
    const valid = admin ? await verifyPassword(password, admin.password_hash) : await verifyAgainstDummy(password);

    if (!valid) {
      const failure = loginThrottle.recordFailure(ip);
      // The typed user name is only recorded when it is a real admin: someone
      // who pastes a password into the wrong box must not leave it in the log.
      await recordAudit(pool, {
        actor: admin ? admin.username : '(unknown user)',
        action: 'login.failure',
        summary: 'Login failed.',
        ip,
      });
      if (failure.justBlocked) {
        await recordAudit(pool, {
          actor: admin ? admin.username : '(unknown user)',
          action: 'login.blocked',
          summary: `Too many failed logins. This address is blocked for ${Math.round(failure.retryAfterSeconds / 60)} minutes.`,
          ip,
        });
        return tooManyAttempts(res, failure.retryAfterSeconds, username);
      }
      await sleep(failure.delayMs);
      return renderLogin(res, 401, { error: 'Invalid user name or password.', username });
    }

    loginThrottle.reset(ip);
    // A new session ID on every login; a session cookie sent with this request is ended.
    await destroySessionByToken(pool, req.sessionToken);
    await purgeDead(pool, config);
    const session = await createSession(pool, config, admin.id);
    setSessionCookie(res, config, session.token);
    await recordLogin(pool, admin.id);
    await recordAudit(pool, { actor: admin.username, action: 'login.success', summary: 'Logged in.', ip });
    res.redirect(303, '/admin');
  });

  function tooManyAttempts(res, retryAfterSeconds, username) {
    res.set('Retry-After', String(retryAfterSeconds));
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return renderLogin(res, 429, {
      error: `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      username,
    });
  }

  // ----------------------------------------------------------------- logout

  router.post('/logout', needAdmin, verifyCsrf, async (req, res) => {
    await destroySessionByToken(pool, req.sessionToken);
    clearSessionCookie(res, config);
    await recordAudit(pool, { actor: req.session.username, action: 'logout', summary: 'Logged out.', ip: req.ip });
    res.redirect(303, '/admin/login?msg=logged-out');
  });

  // -------------------------------------------------------------- dashboard

  router.get('/', needAdmin, async (req, res) => {
    const { rows } = await listAudit(pool, { limit: 5, offset: 0 });
    const docCounts = await countByStatus(pool);
    const categoryCounts = await categoryStats(pool);
    res.render('admin/dashboard', {
      title: 'Dashboard',
      notice: noticeFor(req),
      docCounts,
      categoryCounts,
      unresolvedLinks: await countUnresolved(pool),
      sessionExpires: req.session.expiresAt,
      idleMinutes: config.session.idleMinutes,
      recent: rows.map(auditRow),
    });
  });

  // -------------------------------------------------------------- audit log

  router.get('/audit', needAdmin, async (req, res) => {
    const page = parsePage(req.query.page);
    const { total, rows } = await listAudit(pool, {
      limit: AUDIT_PAGE_SIZE,
      offset: (page - 1) * AUDIT_PAGE_SIZE,
    });
    res.render('admin/audit', {
      title: 'Audit log',
      rows: rows.map(auditRow),
      page,
      pages: pageCount(total, AUDIT_PAGE_SIZE),
      total,
    });
  });

  // ----------------------------------------------------------------- status

  // The Phase 0 status page, moved here from "/" when the reader home page took over.
  router.get('/status', needAdmin, async (req, res) => {
    const status = await getStatus(pool);
    const healthy = status.db === 'ok' && status.schema === 'ok';

    // Built field by field: request objects never go into render options (brainstorm 5.7).
    res.status(healthy ? 200 : 503).render('status', {
      title: 'Wiki status',
      version,
      env: config.env,
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

  // -------------------------------------------------------------- documents

  router.use('/docs', adminDocsRouter({ pool, config, needAdmin }));

  // ------------------------------------------------------------- categories

  router.use('/categories', adminCategoriesRouter({ pool, config, needAdmin }));

  // ----------------------------------------------------------------- search

  router.use('/search', adminSearchRouter({ pool, config, needAdmin }));

  // ------------------------------------------------------------------ links

  router.use('/links', adminLinksRouter({ pool, needAdmin }));

  // -------------------------------------------------------- change password

  const renderPassword = (res, status, errors = []) =>
    res.status(status).render('admin/password', {
      title: 'Change password',
      errors,
      minLength: config.session.passwordMinLength,
    });

  router.get('/password', needAdmin, (req, res) => renderPassword(res, 200));

  router.post('/password', needAdmin, verifyCsrf, async (req, res) => {
    const { username, adminId } = req.session;
    const key = String(adminId);
    const gate = passwordThrottle.check(key);
    if (gate.blocked) {
      res.set('Retry-After', String(gate.retryAfterSeconds));
      return renderPassword(res, 429, ['Too many wrong current passwords. Try again later.']);
    }

    const str = (v) => (typeof v === 'string' ? v : '');
    const current = str(req.body.current_password);
    const next = str(req.body.new_password);
    const confirm = str(req.body.confirm_password);

    const admin = await findByUsername(pool, username);
    if (!admin || !(await verifyPassword(current, admin.password_hash))) {
      const failure = passwordThrottle.recordFailure(key);
      await recordAudit(pool, {
        actor: username,
        action: 'password.change_failed',
        summary: 'Password change refused: the current password was wrong.',
        ip: req.ip,
      });
      await sleep(failure.delayMs);
      return renderPassword(res, 400, ['The current password is not correct.']);
    }

    const problems = passwordProblems(next, { minLength: config.session.passwordMinLength, username });
    if (next !== confirm) problems.push('The new password and the confirmation do not match.');
    if (next === current) problems.push('The new password must differ from the current one.');
    if (problems.length > 0) return renderPassword(res, 400, problems);

    passwordThrottle.reset(key);
    await setPassword(pool, adminId, await hashPassword(next));
    // Every session ends, this one included, and a fresh one replaces it, so the
    // browser that changed the password stays logged in and every other one is out.
    await destroyAllForAdmin(pool, adminId);
    const session = await createSession(pool, config, adminId);
    setSessionCookie(res, config, session.token);
    await recordAudit(pool, {
      actor: username,
      action: 'password.change',
      targetType: 'admin',
      targetId: adminId,
      summary: 'Password changed. All other sessions ended.',
      ip: req.ip,
    });
    res.redirect(303, '/admin?msg=password-changed');
  });

  return router;
}

// Template rows are built field by field.
function auditRow(r) {
  return {
    time: r.created_at,
    actor: r.actor,
    action: r.action,
    target: r.target_type ? `${r.target_type}${r.target_id ? ` ${r.target_id}` : ''}` : '',
    summary: r.summary,
    ip: r.ip ?? '',
  };
}
