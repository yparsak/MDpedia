-- Undoes 011. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database. Undo 012 first.

DROP TABLE IF EXISTS doc_vectors;

DELETE FROM schema_migrations WHERE version = '011_vectors';
