-- Undoes 004. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS search_daily;
DROP TABLE IF EXISTS search_log;
DROP TABLE IF EXISTS doc_terms;
DELETE FROM schema_migrations WHERE version = '004_search';
