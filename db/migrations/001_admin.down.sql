-- Undoes 001. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS admin_users;
DELETE FROM schema_migrations WHERE version = '001_admin';
