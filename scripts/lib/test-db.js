// The guard for tests that need a real database (brainstorm 5.18). They run
// only against a database whose name ends in `_test`, and they never read the
// project's DB_NAME: the name comes from TEST_DB_NAME, which `make test` sets
// to the test database. `make test-db-reset` builds that database from the
// migrations.
//
//   TEST_DB_NAME unset          the database tests are skipped (plain `npm test` still passes)
//   TEST_DB_NAME=MDpedia_test   they run
//   TEST_DB_NAME=MDpedia        refused: the run stops with an error before any connection is made

import { loadEnvFile, loadConfig } from '../../app/config.js';
import { createPool } from '../../app/db.js';

export const TEST_DB_SUFFIX = '_test';

// Throws unless the name ends in `_test` (and is more than the suffix alone).
export function assertTestDatabaseName(name) {
  const value = String(name ?? '');
  if (!/^[A-Za-z0-9_]+$/.test(value) || !value.endsWith(TEST_DB_SUFFIX) || value.length <= TEST_DB_SUFFIX.length) {
    throw new Error(
      `Refusing to run: the test database name must end in "${TEST_DB_SUFFIX}" (got "${value}"). ` +
        'Tests never touch the project database. Set TEST_DB_NAME=MDpedia_test and run `make test-db-reset` first.',
    );
  }
  return value;
}

// Resolves to null when TEST_DB_NAME is unset, else { pool, config, name }. The
// credentials come from .env, the database name from TEST_DB_NAME only.
export function openTestDatabase(env = process.env) {
  if (!env.TEST_DB_NAME) return null;
  const name = assertTestDatabaseName(env.TEST_DB_NAME);
  loadEnvFile();
  const result = loadConfig({ ...process.env, DB_NAME: name });
  if (!result.ok) throw new Error(`Cannot read .env for the database tests: ${result.errors.join('; ')}`);
  if (result.config.db.name !== name) throw new Error('The test database name did not reach the configuration.');
  return { pool: createPool({ ...result.config.db, name }), config: result.config, name };
}
