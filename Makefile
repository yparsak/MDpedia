# MDpedia: project tasks.
#
# Every target that touches the database reads credentials from .env, the same
# file the app reads (brainstorm 5.13). Nothing here changes the schema on its
# own: `make migrate` runs the numbered SQL files, which record themselves in
# schema_migrations. The app never migrates itself.
#
# Run `make` with no target for the list.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ---------------------------------------------------------------- environment

ENV_FILE      ?= .env
MIGRATION_DIR := db/migrations
SEED_DIR      := db/seed
BACKUP_DIR    ?= backups
SAMPLES_DIR   := samples

# Load .env into the recipe's shell. Values are not parsed by make, so a value
# containing #, spaces or quotes cannot break the Makefile.
LOAD_ENV := set -a; . ./$(ENV_FILE); set +a;

# MariaDB 10.5+ installs the client as `mariadb`; older builds only have `mysql`.
MARIADB_BIN ?= $(shell command -v mariadb 2>/dev/null || command -v mysql 2>/dev/null || echo mariadb)
DUMP_BIN    ?= $(shell command -v mariadb-dump 2>/dev/null || command -v mysqldump 2>/dev/null || echo mariadb-dump)

# MYSQL_PWD keeps the password out of the process list, unlike -p<password>.
# It is still visible to root in /proc, which is acceptable on a single-admin Pi.
DB := $(LOAD_ENV) MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER"
DUMP := $(LOAD_ENV) MYSQL_PWD="$$DB_PASSWORD" $(DUMP_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER"

# The test database. Destructive targets refuse to run against anything else.
TEST_DB ?= MDpedia_test

MAX_UPLOAD_BYTES_DEFAULT := 262144

.PHONY: help env-check install start dev lint audit test \
        db-check db-shell db-dump migrate migrate-status migrate-one rollback-one \
        schema-dump seed-categories test-db-reset \
        admin backup health smoke samples-verify check-raw-tags clean

# ----------------------------------------------------------------------- help

help:
	@echo "MDpedia targets"
	@echo
	@echo "  Setup"
	@echo "    make install           npm install"
	@echo "    make env-check         confirm .env exists and required keys are set"
	@echo
	@echo "  Run"
	@echo "    make start             npm start"
	@echo "    make dev               npm start with NODE_ENV=development"
	@echo "    make health            curl /healthz and print the result"
	@echo "    make smoke             the section 4 smoke test, as a checklist"
	@echo
	@echo "  Database"
	@echo "    make db-check          connect and print server version and schema version"
	@echo "    make db-shell          open a mariadb shell on the project database"
	@echo "    make db-dump           timestamped dump into $(BACKUP_DIR)/"
	@echo "    make migrate           dump, then apply every pending up-migration in order"
	@echo "    make migrate-status    list migration files against schema_migrations"
	@echo "    make migrate-one F=003_categories.sql"
	@echo "    make rollback-one F=003_categories.down.sql   (test database only)"
	@echo "    make schema-dump       regenerate db/schema.sql from the live database"
	@echo "    make seed-categories   run $(SEED_DIR)/categories_seed.sql"
	@echo "    make test-db-reset     drop and rebuild $(TEST_DB) from the migrations"
	@echo
	@echo "  Admin and operations"
	@echo "    make admin             create or reset the admin password"
	@echo "    make backup            run scripts/backup.sh"
	@echo
	@echo "  Checks"
	@echo "    make test              npm test (against the test database)"
	@echo "    make lint              eslint"
	@echo "    make audit             npm audit"
	@echo "    make samples-verify    confirm the test fixtures still hold their invariants"
	@echo "    make check-raw-tags    list every <%- raw-output tag in the templates"

# ----------------------------------------------------------------- environment

env-check:
	@test -f $(ENV_FILE) || { echo "ERROR: $(ENV_FILE) not found. Copy .env.example and fill it in."; exit 1; }
	@$(LOAD_ENV) \
	missing=""; \
	for key in DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD SESSION_SECRET DOCS_DIR STAGING_DIR DATA_DIR PORT; do \
	  if [ -z "$${!key}" ]; then missing="$$missing $$key"; fi; \
	done; \
	if [ -n "$$missing" ]; then echo "ERROR: empty or missing in $(ENV_FILE):$$missing"; exit 1; fi; \
	echo "$(ENV_FILE) OK. database=$$DB_NAME user=$$DB_USER docs=$$DOCS_DIR port=$$PORT"
	@$(LOAD_ENV) \
	if [ -n "$$AI_API_KEY" ]; then echo "AI provider: $$AI_PROVIDER model=$${AI_MODEL:-<unset>} key=set"; \
	else echo "AI provider: key not set (fine before Phase 6)"; fi

# ------------------------------------------------------------------- npm tasks

install:
	npm install

start: env-check
	npm start

dev: env-check
	NODE_ENV=development npm start

test:
	@test -f package.json || { echo "package.json does not exist yet"; exit 1; }
	npm test

lint:
	npx eslint .

audit:
	npm audit --omit=dev

# -------------------------------------------------------------------- database

db-check: env-check
	@$(DB) -N -B -e "SELECT CONCAT('server ', VERSION());" 2>/dev/null \
	  || { echo "ERROR: cannot connect. Is MariaDB running and are the .env credentials right?"; exit 1; }
	@$(LOAD_ENV) MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" -N -B "$$DB_NAME" \
	  -e "SELECT CONCAT('schema version ', COALESCE(MAX(version), 'none')) FROM schema_migrations;" 2>/dev/null \
	  || echo "schema version: schema_migrations not present (run make migrate)"
	@$(DB) -N -B -e "SHOW VARIABLES LIKE 'innodb_ft_min_token_size';" \
	  | awk '{ if ($$2 == 2) print "innodb_ft_min_token_size = 2 (correct)"; \
	          else print "WARNING: innodb_ft_min_token_size = " $$2 ". Must be 2 before Phase 2 creates the FULLTEXT index (brainstorm 5.2)." }'

db-shell: env-check
	$(DB) "$$DB_NAME"

db-dump: env-check
	@mkdir -p $(BACKUP_DIR)
	@$(LOAD_ENV) \
	out="$(BACKUP_DIR)/$$DB_NAME-$$(date +%Y%m%d-%H%M%S).sql"; \
	MYSQL_PWD="$$DB_PASSWORD" $(DUMP_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" \
	  --single-transaction --routines --events "$$DB_NAME" > "$$out" \
	  && echo "dump written: $$out ($$(wc -c < "$$out") bytes)"

migrate-status: env-check
	@$(LOAD_ENV) \
	applied=$$(MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" -N -B "$$DB_NAME" \
	          -e "SELECT version FROM schema_migrations;" 2>/dev/null); \
	for f in $(MIGRATION_DIR)/*.sql; do \
	  case "$$f" in *.down.sql) continue;; esac; \
	  v=$$(basename "$$f" .sql); \
	  if echo "$$applied" | grep -qx "$$v"; then echo "  applied  $$v"; else echo "  PENDING  $$v"; fi; \
	done

migrate: env-check db-dump
	@$(LOAD_ENV) \
	applied=$$(MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" -N -B "$$DB_NAME" \
	          -e "SELECT version FROM schema_migrations;" 2>/dev/null); \
	ran=0; \
	for f in $(MIGRATION_DIR)/*.sql; do \
	  case "$$f" in *.down.sql) continue;; esac; \
	  v=$$(basename "$$f" .sql); \
	  if echo "$$applied" | grep -qx "$$v"; then continue; fi; \
	  echo "applying $$v"; \
	  MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" "$$DB_NAME" < "$$f" \
	    || { echo "FAILED on $$v. The dump above is your way back."; exit 1; }; \
	  ran=$$((ran+1)); \
	done; \
	if [ "$$ran" -eq 0 ]; then echo "nothing pending"; else echo "$$ran migration(s) applied"; fi

migrate-one: env-check
	@test -n "$(F)" || { echo "usage: make migrate-one F=003_categories.sql"; exit 1; }
	@test -f $(MIGRATION_DIR)/$(F) || { echo "ERROR: $(MIGRATION_DIR)/$(F) not found"; exit 1; }
	@$(LOAD_ENV) MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" "$$DB_NAME" \
	  < $(MIGRATION_DIR)/$(F) && echo "applied $(F)"

# Down-migrations are destructive, so this refuses any database but the test one.
rollback-one:
	@test -n "$(F)" || { echo "usage: make rollback-one F=003_categories.down.sql"; exit 1; }
	@test -f $(MIGRATION_DIR)/$(F) || { echo "ERROR: $(MIGRATION_DIR)/$(F) not found"; exit 1; }
	@$(LOAD_ENV) MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" "$(TEST_DB)" \
	  < $(MIGRATION_DIR)/$(F) && echo "rolled back $(F) on $(TEST_DB)"

schema-dump: env-check
	@$(LOAD_ENV) \
	MYSQL_PWD="$$DB_PASSWORD" $(DUMP_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" \
	  --no-data --skip-comments --skip-dump-date "$$DB_NAME" > db/schema.sql \
	  && echo "db/schema.sql regenerated from $$DB_NAME"
	@$(LOAD_ENV) \
	MYSQL_PWD="$$DB_PASSWORD" $(DUMP_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" \
	  --no-create-info --skip-comments --skip-dump-date "$$DB_NAME" schema_migrations >> db/schema.sql \
	  && echo "schema_migrations rows appended"

seed-categories: env-check
	@test -f $(SEED_DIR)/categories_seed.sql \
	  || { echo "ERROR: $(SEED_DIR)/categories_seed.sql not found. Copy categories_seed.example.sql and edit it."; exit 1; }
	@$(LOAD_ENV) MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" "$$DB_NAME" \
	  < $(SEED_DIR)/categories_seed.sql && echo "category tree seeded"

test-db-reset:
	@echo "This drops and rebuilds $(TEST_DB). The project database is untouched."
	@$(LOAD_ENV) \
	MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" \
	  -e "DROP DATABASE IF EXISTS \`$(TEST_DB)\`; CREATE DATABASE \`$(TEST_DB)\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"; \
	for f in $(MIGRATION_DIR)/*.sql; do \
	  case "$$f" in *.down.sql) continue;; esac; \
	  echo "  $$(basename $$f)"; \
	  MYSQL_PWD="$$DB_PASSWORD" $(MARIADB_BIN) -h "$$DB_HOST" -P "$$DB_PORT" -u "$$DB_USER" "$(TEST_DB)" < "$$f" || exit 1; \
	done; \
	echo "$(TEST_DB) rebuilt"

# ------------------------------------------------------------ admin and operations

admin: env-check
	node scripts/create-admin.js

backup:
	bash scripts/backup.sh

health:
	@$(LOAD_ENV) \
	code=$$(curl -s -o /tmp/mdpedia-health.$$$$ -w '%{http_code}' "http://127.0.0.1:$$PORT/healthz" || echo 000); \
	echo "GET /healthz -> $$code"; cat /tmp/mdpedia-health.$$$$ 2>/dev/null; echo; rm -f /tmp/mdpedia-health.$$$$; \
	test "$$code" = "200"

smoke: health
	@echo
	@echo "Section 4 smoke test. Run these by hand in the browser after every phase:"
	@sed -n '/^## 4\. Smoke test/,/^## 5\./p' roadmap.md | grep -E '^[0-9]+\.' || echo "  (checklist not found in roadmap.md)"

# ----------------------------------------------------------------------- checks

# The fixtures encode invariants the phase tests depend on. If someone edits a
# sample and quietly breaks one, the phase test silently stops testing anything.
samples-verify:
	@if [ -f $(ENV_FILE) ]; then set -a; . ./$(ENV_FILE); set +a; fi; \
	cap=$${MAX_UPLOAD_BYTES:-$(MAX_UPLOAD_BYTES_DEFAULT)}; \
	fail=0; \
	echo "upload cap: $$cap bytes"; \
	for f in $(SAMPLES_DIR)/05-oversize.md $(SAMPLES_DIR)/20-bulk/12-oversize-in-bulk.md; do \
	  n=$$(wc -c < "$$f" | tr -d " "); \
	  if [ "$$n" -le "$$cap" ]; then echo "  FAIL $$f is $$n bytes, not over the $$cap cap"; fail=1; \
	  else echo "  ok   $$f is $$n bytes, over the cap"; fi; \
	done; \
	for f in $(SAMPLES_DIR)/01-plain.md $(SAMPLES_DIR)/02-math.md $(SAMPLES_DIR)/03-hostile.md; do \
	  n=$$(wc -c < "$$f" | tr -d " "); \
	  if [ "$$n" -ge "$$cap" ]; then echo "  FAIL $$f is $$n bytes, should be under the cap"; fail=1; \
	  else echo "  ok   $$f is $$n bytes, under the cap"; fi; \
	done; \
	if iconv -f UTF-8 -t UTF-8 $(SAMPLES_DIR)/04-bad-encoding.md >/dev/null 2>&1; then \
	  echo "  FAIL 04-bad-encoding.md is valid UTF-8; it must not be"; fail=1; \
	else echo "  ok   04-bad-encoding.md is not valid UTF-8"; fi; \
	if LC_ALL=C grep -q $$'\\x00' $(SAMPLES_DIR)/04b-null-byte.md 2>/dev/null; then \
	  echo "  ok   04b-null-byte.md contains a NUL byte"; \
	else echo "  FAIL 04b-null-byte.md has no NUL byte"; fail=1; fi; \
	n=$$(ls -1 $(SAMPLES_DIR)/20-bulk/*.md | wc -l | tr -d ' '); \
	if [ "$$n" = "12" ]; then echo "  ok   20-bulk/ holds 12 documents"; \
	else echo "  FAIL 20-bulk/ holds $$n documents, expected 12"; fail=1; fi; \
	t=$$(grep -h '^# ' $(SAMPLES_DIR)/20-bulk/10-logic-first.md $(SAMPLES_DIR)/20-bulk/11-logic-second.md | sort -u | wc -l | tr -d ' '); \
	if [ "$$t" = "1" ]; then echo "  ok   the two logic files still share a title"; \
	else echo "  FAIL the two logic files no longer share a title"; fail=1; fi; \
	exit $$fail

# Brainstorm 5.7: raw output is allowed only for sanitized document HTML and
# for includes. Review this list before every release.
check-raw-tags:
	@if [ -d app/views ]; then grep -rn '<%-' app/views || echo "  no raw-output tags found"; \
	else echo "  app/views does not exist yet"; fi

clean:
	rm -rf node_modules
