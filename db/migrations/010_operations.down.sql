-- Undoes 010. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS maintenance_runs;
DROP TABLE IF EXISTS backup_status;

DELETE FROM schema_migrations WHERE version = '010_operations';
