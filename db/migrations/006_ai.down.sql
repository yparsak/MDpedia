-- Undoes 006. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

ALTER TABLE docs
  DROP COLUMN IF EXISTS ai_provider,
  DROP COLUMN IF EXISTS ai_model,
  DROP COLUMN IF EXISTS ai_prompt_version,
  DROP COLUMN IF EXISTS ai_at;

DROP TABLE IF EXISTS category_proposals;
DROP TABLE IF EXISTS doc_category_suggestions;
DROP TABLE IF EXISTS ai_state;
DROP TABLE IF EXISTS ai_usage_daily;
DROP TABLE IF EXISTS jobs;
DELETE FROM schema_migrations WHERE version = '006_ai';
