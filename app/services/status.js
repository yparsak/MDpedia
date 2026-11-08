// Database reachability and schema version. The app never changes the schema
// itself (roadmap section 2): it only compares schema_migrations with the
// migrations it expects and says which SQL file is missing.

const PROBE_TIMEOUT_MS = 5000;

// Add one entry per phase, in order. The version is the file name without .sql.
export const EXPECTED_MIGRATIONS = ['000_schema_migrations', '001_admin', '002_documents', '003_categories', '004_search'];

const versionNumber = (name) => Number.parseInt(name.split('_')[0], 10);

export const EXPECTED_SCHEMA_VERSION = Math.max(...EXPECTED_MIGRATIONS.map(versionNumber));

// Resolves to a plain object and never throws, so every caller can render it.
//   db:     'ok' | 'unreachable'
//   schema: 'ok' | 'behind' | 'unknown'   (unknown when the database is unreachable)
export async function getStatus(pool) {
  let serverVersion;
  try {
    const [rows] = await pool.query({ sql: 'SELECT VERSION() AS v', timeout: PROBE_TIMEOUT_MS });
    serverVersion = rows[0].v;
  } catch (err) {
    return unreachable(err);
  }

  let applied = [];
  try {
    const [rows] = await pool.query({ sql: 'SELECT version FROM schema_migrations', timeout: PROBE_TIMEOUT_MS });
    applied = rows.map((r) => r.version);
  } catch (err) {
    // A fresh database has no schema_migrations table yet, which means "behind".
    if (err.code !== 'ER_NO_SUCH_TABLE') return unreachable(err);
  }

  const missing = EXPECTED_MIGRATIONS.filter((m) => !applied.includes(m)).map((m) => `${m}.sql`);
  const appliedNumbers = applied.map(versionNumber).filter(Number.isFinite);

  return {
    db: 'ok',
    serverVersion,
    schema: missing.length === 0 ? 'ok' : 'behind',
    schemaVersion: appliedNumbers.length ? Math.max(...appliedNumbers) : null,
    expectedVersion: EXPECTED_SCHEMA_VERSION,
    missing,
  };
}

function unreachable(err) {
  return {
    db: 'unreachable',
    errorCode: err.code || 'UNKNOWN',
    serverVersion: null,
    schema: 'unknown',
    schemaVersion: null,
    expectedVersion: EXPECTED_SCHEMA_VERSION,
    missing: [],
  };
}

// For /healthz: true only if the database answers a trivial query.
export async function databaseAnswers(pool) {
  try {
    await pool.query({ sql: 'SELECT 1', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
