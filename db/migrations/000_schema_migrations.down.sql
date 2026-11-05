-- Undoes 000. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS schema_migrations;
