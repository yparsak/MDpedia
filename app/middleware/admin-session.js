import { FIELD, tokensEqual } from '../services/csrf.js';
import {
  COOKIE_NAME,
  parseCookies,
  loadSession,
  clearSessionCookie,
} from '../services/sessions.js';

// Admin pages hold private data and per-session tokens, so no browser or proxy
// may keep a copy. This is also what stops the Back button showing an admin
// page after logout.
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

// Looks the session up and exposes it. Never rejects: whether a session is
// required is decided by requireAdmin. The template locals are set field by
// field, so a request object never reaches a template (brainstorm 5.7).
export function loadAdminSession({ pool, config }) {
  return async (req, res, next) => {
    req.sessionToken = parseCookies(req.headers.cookie)[COOKIE_NAME];
    req.session = await loadSession(pool, config, req.sessionToken);
    res.locals.admin = req.session ? { username: req.session.username } : null;
    res.locals.csrfToken = req.session ? req.session.csrfToken : null;
    next();
  };
}

export function requireAdmin({ config }) {
  return (req, res, next) => {
    if (req.session) return next();
    // A cookie that no longer maps to a live session means it expired or was ended.
    const hadCookie = Boolean(req.sessionToken);
    if (hadCookie) clearSessionCookie(res, config);
    res.redirect(303, hadCookie ? '/admin/login?msg=expired' : '/admin/login');
  };
}

// For POST routes behind requireAdmin.
export function verifyCsrf(req, res, next) {
  if (tokensEqual(req.body?.[FIELD], req.session?.csrfToken)) return next();
  res.status(403).render('403', { title: 'Request refused' });
}
