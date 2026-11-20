-- Undoes 008. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS reconcile_state;
DROP TABLE IF EXISTS file_issues;

ALTER TABLE docs
  DROP INDEX IF EXISTS idx_docs_staged,
  DROP INDEX IF EXISTS idx_docs_attention;

ALTER TABLE docs
  DROP COLUMN IF EXISTS staged_size,
  DROP COLUMN IF EXISTS staged_hash,
  DROP COLUMN IF EXISTS staged_status,
  DROP COLUMN IF EXISTS staged_at,
  DROP COLUMN IF EXISTS attention_at,
  DROP COLUMN IF EXISTS attention_reason,
  DROP COLUMN IF EXISTS attention,
  DROP COLUMN IF EXISTS file_mtime_ms,
  DROP COLUMN IF EXISTS file_size;

DELETE FROM schema_migrations WHERE version = '008_replace';
