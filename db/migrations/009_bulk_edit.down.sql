-- Undoes 009. Destructive: for the test database, or after a dump.
-- `make rollback-one` runs it only against the test database.

DROP TABLE IF EXISTS edit_batch_docs;
DROP TABLE IF EXISTS edit_batches;

-- Edit jobs have no meaning without the tables above.
DELETE FROM jobs WHERE type = 'edit';

DELETE FROM schema_migrations WHERE version = '009_bulk_edit';
