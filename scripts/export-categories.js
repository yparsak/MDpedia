// Rewrites categories.yaml in DATA_DIR from the database, so a backup always
// holds the current tree even when no category was edited since the file was
// last written (a tree seeded with `make seed-categories` never wrote one).
// Run by scripts/backup.sh. Exit status 0 only when the file was written.

import { loadEnvFile, loadConfig } from '../app/config.js';
import { createPool } from '../app/db.js';
import { exportCategories } from '../app/services/categories-export.js';

loadEnvFile();
const result = loadConfig();
if (!result.ok) {
  console.error(`Cannot read .env: ${result.errors.join('; ')}`);
  process.exit(1);
}

const pool = createPool(result.config.db);
let written = false;
try {
  written = await exportCategories(pool, result.config);
} catch (err) {
  console.error(`Could not read the categories: ${err.message}`);
} finally {
  await pool.end();
}
process.exit(written ? 0 : 1);
