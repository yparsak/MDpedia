# Database

The app never changes the schema. SQL files do, and `make` runs them.

| Path | Purpose |
|---|---|
| `schema.sql` | The full current schema for a fresh install. Regenerated every phase with `make schema-dump`. |
| `migrations/NNN_name.sql` | One "up" file per phase. Each records itself in `schema_migrations`. |
| `migrations/NNN_name.down.sql` | Undoes that phase. Destructive. Test database only. |
| `seed/*.example.sql` | Templates to copy, edit and run (from Phase 3). |

All tables use `utf8mb4` with an explicit collation (`utf8mb4_unicode_ci`), so
`Limits` and `limits` collide in unique indexes, which is wanted for slugs.

## One-time setup (as the MariaDB admin)

```sql
CREATE DATABASE MDpedia      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE MDpedia_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'MDpedia_app'@'127.0.0.1' IDENTIFIED BY '<a password used nowhere else>';
GRANT ALL PRIVILEGES ON MDpedia.*      TO 'MDpedia_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON MDpedia_test.* TO 'MDpedia_app'@'127.0.0.1';
```

If `DB_HOST` is `localhost`, create the user `@'localhost'` as well, since MariaDB
treats the two host names as different accounts.

## What each `make` target runs

Every target loads `.env` first, so the host, port, user, password and database
name below come from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME`.
The password goes through `MYSQL_PWD`, not `-p`, so it stays out of `ps`.

```bash
# make db-check
MYSQL_PWD=... mariadb -h $DB_HOST -P $DB_PORT -u $DB_USER -e "SELECT VERSION();"
MYSQL_PWD=... mariadb -h $DB_HOST -P $DB_PORT -u $DB_USER $DB_NAME -e "SELECT MAX(version) FROM schema_migrations;"
MYSQL_PWD=... mariadb -h $DB_HOST -P $DB_PORT -u $DB_USER -e "SHOW VARIABLES LIKE 'innodb_ft_min_token_size';"

# make db-dump
MYSQL_PWD=... mariadb-dump -h $DB_HOST -P $DB_PORT -u $DB_USER --single-transaction --routines --events $DB_NAME > backups/$DB_NAME-<timestamp>.sql

# make migrate: db-dump, then for each file not yet in schema_migrations, in order:
MYSQL_PWD=... mariadb -h $DB_HOST -P $DB_PORT -u $DB_USER $DB_NAME < db/migrations/000_schema_migrations.sql

# make rollback-one F=000_schema_migrations.down.sql  (always against MDpedia_test)
MYSQL_PWD=... mariadb -h $DB_HOST -P $DB_PORT -u $DB_USER MDpedia_test < db/migrations/000_schema_migrations.down.sql

# make schema-dump
MYSQL_PWD=... mariadb-dump -h $DB_HOST -P $DB_PORT -u $DB_USER --no-data --skip-comments --skip-dump-date $DB_NAME > db/schema.sql
```

On MariaDB older than 10.5 the client is `mysql` and the dump tool is `mysqldump`;
the Makefile picks whichever is installed.

## Writing a migration

- File name `NNN_name.sql`, numbered in order, one per phase.
- Use `IF NOT EXISTS` where safe.
- End with `INSERT IGNORE INTO schema_migrations (version) VALUES ('NNN_name');`
  using the file name without `.sql`. The Makefile and the app both match on that exact string.
- Write the matching `NNN_name.down.sql`.
- Add `'NNN_name'` to `EXPECTED_MIGRATIONS` in `app/services/status.js`, so the app
  can tell when the database is behind.
- Regenerate `schema.sql` with `make schema-dump`.
