-- Undoes 002. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS docs;
DELETE FROM schema_migrations WHERE version = '002_documents';
