// The admin account. One admin in v1 (brainstorm section 7), but the table is a
// normal users table so a second factor or a second admin does not need a rewrite.

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export async function findByUsername(pool, username) {
  const [rows] = await pool.query(
    'SELECT id, username, password_hash FROM admin_users WHERE username = ?',
    [username],
  );
  return rows[0] ?? null;
}

export async function listAdmins(pool) {
  const [rows] = await pool.query('SELECT id, username FROM admin_users ORDER BY id');
  return rows;
}

export async function recordLogin(pool, adminId) {
  await pool.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?', [adminId]);
}

export async function setPassword(pool, adminId, passwordHash) {
  await pool.query('UPDATE admin_users SET password_hash = ?, password_changed_at = NOW() WHERE id = ?', [
    passwordHash,
    adminId,
  ]);
}

// Used by scripts/create-admin.js. Creates the admin, or resets the password if
// the user name exists, and in that case ends every session of that admin.
// Returns { id, created }.
export async function createOrReset(pool, username, passwordHash) {
  const existing = await findByUsername(pool, username);
  if (existing) {
    await setPassword(pool, existing.id, passwordHash);
    await pool.query('DELETE FROM sessions WHERE admin_id = ?', [existing.id]);
    return { id: existing.id, created: false };
  }
  const [result] = await pool.query('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [
    username,
    passwordHash,
  ]);
  return { id: result.insertId, created: true };
}
