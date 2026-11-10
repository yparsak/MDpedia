-- Undoes 005. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS doc_links;
DELETE FROM schema_migrations WHERE version = '005_links';
