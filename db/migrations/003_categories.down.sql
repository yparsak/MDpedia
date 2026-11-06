-- Undoes 003. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS doc_categories;
DROP TABLE IF EXISTS categories;
DELETE FROM schema_migrations WHERE version = '003_categories';
