# MDpedia technical specification

This is the technical reference for MDpedia: what it is made of, how to install it, how to run and maintain it, and how it works internally. For a general introduction, see [README.md](README.md). Planned work is in [TODO_LIST.md](TODO_LIST.md).

Related documents:

- [docs/OPERATIONS.md](docs/OPERATIONS.md): service install, release, backup, restore and warning handling in full
- [db/README.md](db/README.md): the SQL workflow
- [samples/README.md](samples/README.md): the test fixtures
- [roadmap.md](roadmap.md): the build order and per-phase test checklists
- [mdpedia-project-brainstorm.md](mdpedia-project-brainstorm.md): the decision log

## 1. Overview

MDpedia is a server-rendered Node.js web application. An administrator uploads Markdown documents. An optional AI step extracts search metadata (keywords, key phrases, synonyms, questions, a summary and category suggestions). An administrator reviews and approves, and the document becomes visible to anonymous readers.

Two rules shape the whole design:

1. **The files are canonical.** Each document is `<slug>.md` in `DOCS_DIR`. The database is an index that can be rebuilt from the files, plus the data that has no file (accounts, logs, jobs, categories).
2. **No external AI at read time.** Readers' searches use only the database. AI calls happen at upload, replace and bulk edit, and always behind an admin action.

## 2. Architecture

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 or later, ES modules |
| Web framework | Express 5, EJS templates (server-rendered, no SPA) |
| Database | MariaDB (InnoDB, FULLTEXT search; 11.7 or later for vectors) via `mysql2` |
| Markdown | `unified`: remark (GFM, math) to rehype (KaTeX, highlight.js, slug and autolink headings), sanitized with `rehype-sanitize` |
| Validation | `zod` (AI output, configuration) |
| Security headers | `helmet` with a strict Content Security Policy |
| Uploads | `multer` |
| Embeddings (optional) | `@huggingface/transformers`, model `bge-small-en-v1.5` (384 dimensions), in a worker thread |

### 2.1 Source layout

```
app/
  server.js          entry point: config, pool, workers, graceful shutdown
  app.js             Express app: middleware order, security headers, routers
  config.js          reads and validates .env
  db.js, logger.js   connection pool, JSON logging
  middleware/        admin session, backup-age notice, upload receiver
  routes/            reader.js, search.js, status.js and admin-*.js
  services/          all business logic (docs, categories, search, AI, jobs, ...)
  views/             EJS templates (reader pages, admin/, partials/)
  public/            CSS and small client scripts (no inline JS allowed)
db/
  migrations/        numbered up and down SQL files (000 to 012)
  schema.sql         generated snapshot of the current schema
  seed/              example category tree and search test set
deploy/              systemd unit, journald size cap, firewall script
docs/OPERATIONS.md   operations manual
scripts/             backup, create-admin, export-categories, mock AI server, checks
samples/             fixtures for manual and automated tests
test/                node:test suites
```

### 2.2 Processes

Everything runs in one Node process:

- the web server;
- the **AI worker**, a polling loop on the `jobs` table (`JOB_POLL_INTERVAL_SECONDS`), enabled only when `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` are set;
- the **reconciler**, which compares files with the database (`RECONCILE_INTERVAL_MINUTES`);
- the **maintenance** job, which prunes old rows at start and every six hours;
- the **embedding worker thread**, only when `EMBED_PROVIDER=transformersjs`.

### 2.3 Security model

- Admin-only login with `scrypt` password hashing (parameters stored with each hash), a minimum length (`PASSWORD_MIN_LENGTH`), a common-password check and login rate limiting. Sessions are server-side, with idle and absolute timeouts.
- CSRF tokens on every state-changing admin request.
- Document HTML is rendered from Markdown and sanitized; raw HTML and `<img>` are not allowed. Templates use escaped output; every raw `<%-` must be on a reviewed allowlist (`make check-raw-tags`).
- CSP: scripts `'self'` only, no inline script or event handlers, `frame-ancestors 'none'`.
- Rate limits on search, page views and admin writes.
- Audit log of admin actions. The search log stores no IP address or session.
- Documents are sent to the configured AI provider, so do not store secrets or personal data in them.
- Traffic is plain HTTP by design for now (see [TODO_LIST.md](TODO_LIST.md)). Run it on a trusted network or behind a TLS-terminating reverse proxy, and set `TRUST_PROXY` and `COOKIE_SECURE` accordingly.

## 3. Data model

Documents are Markdown files with YAML front matter:

```yaml
---
id: 42
slug: eigenvalues
title: Eigenvalues
published: true
categories: [3, 7]        # ids; the first is primary
keywords: [...]
key_phrases: [...]
synonyms: [...]
questions: [...]
ai: { provider, model, prompt_version, date }
---
```

Current schema (see `db/schema.sql`):

| Area | Tables |
|---|---|
| Core | `schema_migrations`, `admin_users`, `sessions`, `audit_log` |
| Documents | `docs`, `doc_terms`, `doc_links`, `file_issues`, `reconcile_state` |
| Categories | `categories`, `doc_categories`, `doc_category_suggestions`, `category_proposals` |
| Search | `search_log`, `search_daily` |
| AI and jobs | `jobs`, `ai_usage_daily`, `ai_state` |
| Import and edit | `import_batches`, `import_batch_items`, `edit_batches`, `edit_batch_docs` |
| Operations | `backup_status`, `maintenance_runs` |
| Vectors | `doc_vectors` (`VECTOR(384)`, with an optional vector index) |

The category tree is an adjacency list, at most three levels deep, and is mirrored to `categories.yaml` in `DATA_DIR` on every change.

## 4. Features and how they work

**Reader site.** `/` lists published documents and top categories. A document is at `/wiki/<category path>/<slug>`; `/doc?id=<id>` and stale paths redirect. `/category/<path>` browses like a folder. `/healthz` is the public health probe.

**Search.** `GET /search?q=...`. Words match as prefixes, `"quoted phrases"` stay together, and all words are required first. If fewer than `SEARCH_PARTIAL_THRESHOLD` results come back, it falls back to any word and labels results "partial matches". Title, summary, body and the metadata fields are weighted with `SEARCH_WEIGHT_*` (0 disables a source). The FULLTEXT index needs `innodb_ft_min_token_size=2` (checked by `make db-check`). `/admin/search` shows zero-result and no-click queries; `/admin/search/eval` scores a test set (template in `db/seed/search_test_set.example.json`).

**Wiki links.** `[[slug]]` and `[[slug|text]]` are matched against slugs, never titles. Links to missing or unpublished documents render as a marked dead span for everyone. Rendered HTML is stored, so publishing, unpublishing or retitling a document re-renders the documents that link to it (up to 200). Code spans, code blocks and Markdown links are left alone. `/admin/links` reports unresolved links.

**Math and code.** LaTeX via KaTeX (`$...$`, `$$...$$`); write a literal dollar as `\$`. Code via highlight.js.

**AI extraction.** An upload becomes a job: Uploaded, Processing, Ready for review. The provider is any OpenAI-compatible Chat Completions endpoint. Output is validated against a schema; a hand-edited summary is never overwritten; suggested categories and proposed new categories are stored but never applied automatically. Safeguards: per-call timeout, retries with backoff for transient errors only, a daily call cap, concurrency limit, and a circuit breaker that pauses the queue until an admin resumes it. Jobs interrupted by a crash are re-queued at start. With AI unconfigured, uploads skip the queue. `/admin/ai` (AI Lab) tests the connection and previews output without saving; `/admin/jobs` manages the queue.

**Review and approval.** Nothing is reader-visible until approved at `/admin/review/<id>`, where the admin edits the metadata, picks up to three categories and accepts, renames or rejects proposed categories. "Approve selected" and "Approve all ready" list what they will approve and hold back documents with exceptions (undecided proposals, unresolved links, raw HTML, oversize).

**Bulk import.** `/admin/import` takes up to `BULK_MAX_FILES` files, asks the admin to confirm the AI call count (with a one-time allowance above the daily cap if needed), then imports with `-2` style suffixes for taken slugs. Bad files are skipped and listed in the report.

**Replace.** `/admin/replace/<id>` stages the new version as `replace-<id>.md` in `STAGING_DIR`. Readers keep the old version while the AI refreshes the metadata. Approving swaps the file and updates the database in one transaction. Unapproved staged versions are removed after `STAGED_RETENTION_DAYS`.

**Bulk AI edit.** `/admin/edit` takes an instruction and a scope. A dry run lists documents, AI calls, headroom under the cap and backup age. The AI may only add text: a result that alters the original, fails the upload checks or fails the model's self-check (retried up to `BULK_EDIT_MAX_RETRIES`) marks the document "needs attention". Good results are staged and shown as a side-by-side diff to approve, hand-edit or reject. `make mock-ai` starts a stand-in provider for testing.

**Reconciliation.** Files win. At start, every `RECONCILE_INTERVAL_MINUTES` and on "Rescan now", the docs directory is compared with the database by size and mtime, then body hash. Invalid front matter, a changed `id` or `slug`, or a missing file marks the document on `/admin/attention` while readers keep the last good version. A second file claiming an existing `id` or `slug` is rejected. A scan applies body, title, summary and search terms; `published` and `categories` stay under app control.

**Operations.** `/admin/maintenance` shows backup status and pruning tasks. The dashboard warns when the last backup is older than `BACKUP_STALE_DAYS`, and the same age is shown before risky bulk actions.

**Vector search (admin-only lab).** With `EMBED_PROVIDER=transformersjs`, each published document gets one vector built from its title, summary, keywords and questions, stored in `doc_vectors`. Vectors are queued as `embed` jobs on approval, replacement and metadata changes; `/admin/vectors` has "Rebuild all vectors" and a query lab showing nearest documents, SQL, query plan and timing, as an exact scan, through the vector index, or both. `/admin/vectors/compare` shows keyword and vector results side by side and scores the test set both ways. Nothing public uses vectors.

## 5. Installation

### 5.1 Requirements

- Linux host (any small server works), Node.js 20 or later, `make`
- MariaDB 10.5 or later; **11.7 or later** for migrations 011 and 012 (vectors)
- A dedicated database and user, and a data directory on one filesystem for the docs and staging folders
- Optional: an OpenAI-compatible AI endpoint; an external drive for backups; outbound access to Hugging Face once, for the embedding model

### 5.2 Database

Create the database and user as the MariaDB admin (full statements in [db/README.md](db/README.md)), and confirm `innodb_ft_min_token_size=2`. If `DB_HOST` is `localhost`, create the user for `@'localhost'` as well.

### 5.3 Application

```bash
cp .env.example .env            # set DB_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
chmod 600 .env
mkdir -p /srv/MDpedia-data/docs /srv/MDpedia-data/staging   # DOCS_DIR and STAGING_DIR, writable by the app user
make env-check
make install
make migrate-status
make migrate                    # takes a dump first, then applies 000 to 012
make admin                      # creates the admin; run again to reset the password
make start
```

Optional starting category tree: copy `db/seed/categories_seed.example.sql` to `db/seed/categories_seed.sql`, edit it, then `make seed-categories`.

Open `http://<host>:3000/admin` and log in. New uploads are saved unpublished: open the document, check the preview, and publish.

### 5.4 Run as a service

`deploy/wiki.service` is a hardened systemd unit (non-root user, `NoNewPrivileges`, `ProtectSystem=strict`, write access only to the data directory, restart on failure). `deploy/journald-wiki.conf` caps log size and `deploy/firewall.sh` restricts the port. Edit the paths, then follow section 1 of [docs/OPERATIONS.md](docs/OPERATIONS.md).

## 6. Configuration

All settings come from `.env` (loaded by dotenv, validated at start; the app refuses to start with a message listing every bad value). Changes need a restart. The annotated reference is [.env.example](.env.example). Groups:

| Group | Keys |
|---|---|
| Server | `HOST`, `PORT`, `TRUST_PROXY`, `NODE_ENV` |
| Database | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` |
| Paths | `DOCS_DIR`, `STAGING_DIR`, `DATA_DIR` |
| Sessions | `SESSION_SECRET` (32+ chars), `COOKIE_SECURE`, `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`, `PASSWORD_MIN_LENGTH` |
| AI | `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_CALL_TIMEOUT_SECONDS`, `AI_MAX_TOKENS`, `AI_MAX_ATTEMPTS`, `AI_DAILY_CAP`, `AI_CONCURRENCY`, `AI_CIRCUIT_BREAKER_FAILURES` |
| Uploads and batches | `MAX_UPLOAD_BYTES`, `BULK_MAX_FILES`, `BULK_EDIT_MAX_DOCS`, `BULK_EDIT_MAX_RETRIES`, `BULK_EDIT_MAX_TOKENS` |
| Workers | `JOB_POLL_INTERVAL_SECONDS`, `RECONCILE_INTERVAL_MINUTES`, `JOB_RETENTION_DAYS`, `STAGED_RETENTION_DAYS` |
| Rate limits | `RATE_LOGIN_FAILS_PER_15MIN`, `RATE_SEARCH_PER_MIN`, `RATE_PAGES_PER_MIN`, `RATE_ADMIN_WRITES_PER_MIN` |
| Search | `SEARCH_RESULT_LIMIT`, `SEARCH_PAGE_SIZE`, `SEARCH_PARTIAL_THRESHOLD`, `SEARCH_LOG_RETENTION_DAYS`, `SEARCH_WEIGHT_*` |
| Retention and backup | `AUDIT_RETENTION_DAYS`, `BACKUP_STALE_DAYS`, `BACKUP_TARGET`, `BACKUP_KEEP` |
| Vectors | `EMBED_PROVIDER` (`none` by default), `EMBED_MODEL`, `EMBED_DTYPE`, `EMBED_DIMENSIONS`, `EMBED_POOLING`, `EMBED_DOC_PREFIX`, `EMBED_QUERY_PREFIX`, `EMBED_CACHE_DIR`, `EMBED_TIMEOUT_SECONDS` |

When a TLS-terminating proxy is placed in front of the app, set `COOKIE_SECURE=true` and `TRUST_PROXY` to match the proxy.

## 7. Maintenance

### 7.1 Make targets

Run `make` with no argument for the full list.

| Purpose | Targets |
|---|---|
| Setup and run | `install`, `env-check`, `start`, `dev`, `health`, `smoke`, `mock-ai` |
| Database | `db-check`, `db-shell`, `db-dump`, `migrate`, `migrate-status`, `migrate-one`, `rollback-one` (test DB only), `schema-dump`, `seed-categories`, `test-db-reset` |
| Operations | `admin`, `backup` |
| Quality | `test`, `test-quick`, `lint`, `audit`, `samples-verify`, `check-raw-tags` |

### 7.2 Releases

1. Take a backup and check the dashboard shows it is fresh.
2. On the development machine run `make lint`, `make test`, `make check-raw-tags` and `make audit`.
3. Copy the new version into place, keeping `.env` and the old directory until the smoke test passes.
4. `npm ci --omit=dev`.
5. `make migrate-status`, then `make migrate`. The app never migrates itself; `/admin/status` names any missing file.
6. `sudo systemctl restart wiki`, then `make health`.
7. Work through `make smoke` in a browser.
8. On problems, stop the service, restore the old directory and, if a migration ran, the dump from step 5.

### 7.3 Backups and restore

`make backup` (`scripts/backup.sh`) copies the docs, `categories.yaml` and a database dump into `BACKUP_TARGET/mdpedia/<timestamp>/`, keeps the newest `BACKUP_KEEP`, and refuses to run unless `BACKUP_TARGET` is a separate mounted filesystem. Backups are manual by design; the dashboard and risky bulk actions warn when the last one is stale. The embedding cache is disposable and not backed up. Full restore steps, including a drill into a second instance, are in [docs/OPERATIONS.md](docs/OPERATIONS.md) section 4.

### 7.4 Monitoring and housekeeping

- `GET /healthz` returns 200 only when the database answers and the worker loop is alive, and 503 otherwise, without saying which. `make health` calls it.
- Logs are JSON lines on stdout (`journalctl -u wiki -f` under systemd).
- Pruning runs at start and every six hours: search log (`SEARCH_LOG_RETENTION_DAYS`), audit log (`AUDIT_RETENTION_DAYS`) and finished jobs (`JOB_RETENTION_DAYS`).
- The dashboard warning table, with causes and fixes, is in [docs/OPERATIONS.md](docs/OPERATIONS.md) section 5.

### 7.5 Starting over

To clear all documents while keeping the admin and category tree, follow [purge_data.md](purge_data.md), which lists the tables to truncate and the directories to empty. Do not delete `DATA_DIR` itself, which may hold backups.

## 8. Testing

- `make test` drops and rebuilds `MDpedia_test` from the migrations, then runs `node --test` against it. Database tests read `TEST_DB_NAME` only and refuse any name not ending in `_test`.
- `make test-quick` runs without a database; database tests are skipped.
- `test/xss-corpus.test.js` is a fixed list of hostile inputs that must render inert. Add every real bug to it.
- `make check-raw-tags` and `make samples-verify` guard the templates and the fixtures.
- `make smoke` prints the browser checklist that is re-run after each change; `roadmap.md` has the per-phase checks.

## 9. Known limitations

- Plain HTTP unless fronted by a reverse proxy.
- One administrator workflow; no reader accounts.
- Text only: no images or attachments, and raw HTML is rejected.
- No version history or undo; documents are archived by unpublishing, not deleted.
- Documents over `MAX_UPLOAD_BYTES` (256 KB by default) are refused rather than split for the AI.
- Backups are manual.

See [TODO_LIST.md](TODO_LIST.md) for how each is planned to be addressed.
