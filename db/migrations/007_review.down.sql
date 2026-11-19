-- Undoes 007. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS import_batch_items;
DROP TABLE IF EXISTS import_batches;

ALTER TABLE ai_state DROP COLUMN IF EXISTS extra_calls;
ALTER TABLE category_proposals DROP COLUMN IF EXISTS source_value;
ALTER TABLE docs
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS size_bytes;

DELETE FROM schema_migrations WHERE version = '007_review';
