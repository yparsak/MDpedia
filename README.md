# MDpedia

A Markdown wiki for a Raspberry Pi: math rendering, keyword search, and AI-assisted metadata.

- `roadmap.md`: the build order and the test checklist for each phase.
- `mdpedia-project-brainstorm.md`: the decision log behind it.
- `db/README.md`: the SQL workflow.
- `samples/README.md`: the test fixtures.

## Quick start (through Phase 7)

```bash
cp .env.example .env     # fill in DB_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
chmod 600 .env
mkdir -p /srv/MDpedia-data/docs /srv/MDpedia-data/staging   # your DOCS_DIR and STAGING_DIR: one filesystem, writable by the app user
make env-check
make install
make migrate-status
make migrate      # applies 000 to 007 (takes a dump first)
make admin        # creates the admin; also resets the password
make start
```

Optional, for a starting category tree: `cp db/seed/categories_seed.example.sql db/seed/categories_seed.sql`,
edit it, then `make seed-categories`.

Then open `http://<pi-address>:3000/admin` and log in.

- Readers: `/` lists published documents and the top-level categories. A document lives at
  `/wiki/<category path>/<slug>` (just `/wiki/<slug>` with no category); `/doc?id=<id>` redirects to
  it, and so does a stale path. `/category/<path>` browses a category like a folder.
- Admin: `/admin/docs` lists documents, `/admin/docs/new` uploads one. A new upload
  is saved unpublished; open it, check the preview, and publish it.
- Categories: `/admin/categories` is the tree editor (at most three levels). A document gets up
  to three categories on its admin page, the first being the primary; they are saved in its front
  matter as ids. `categories.yaml` in `DATA_DIR` is rewritten on every change.
- Search: the box in every page header sends a plain GET to `/search?q=...`. Words match as prefixes,
  `"quoted phrases"` stay together, and all words are required first; with fewer than
  `SEARCH_PARTIAL_THRESHOLD` such results it falls back to any word and says "partial matches".
  Title, summary, body and the doc's keywords, key phrases, synonyms and questions are searched, weighted
  by `SEARCH_WEIGHT_*` (0 switches a source off). Each doc's keywords are edited on its admin page and
  saved in its front matter. `RATE_SEARCH_PER_MIN` limits searches per IP.
- Search tuning: `/admin/search` reports zero-result and no-click queries over 30 days (the log keeps
  no IP or session and is pruned after `SEARCH_LOG_RETENTION_DAYS`); `/admin/search/eval` runs a test
  set (template: `db/seed/search_test_set.example.json`) and reports the zero-result rate and how often
  the expected doc is in the top 3.
- Wiki links: `[[slug]]` and `[[slug|display text]]` link one document to another. The target is trimmed
  and lowercased, and matched against the slug (never the title). A link to a published doc becomes
  `/doc?id=<id>` and shows the target's title unless display text is given. A link to a doc that does not
  exist, or is not published, is drawn as a marked dead span for everyone and never shows the title.
  `[[links]]` inside code spans, code blocks and Markdown links are left alone. The HTML is stored, so
  publishing, unpublishing or retitling a doc renders the docs that link to it again (at most 200).
  Each published doc lists "What links here". `/admin/links` and the dashboard report unresolved links,
  and a doc's admin page shows its own links. The admin lists show each slug with a Copy button, and a
  `slug:` in the front matter of an upload is used when it is free.
- AI extraction: with `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` set (any OpenAI-compatible Chat Completions
  endpoint), an upload is queued and moves Uploaded, Processing, Ready for review. The worker runs in the
  web process and fills the doc's keywords, key phrases, synonyms, questions and summary (a hand-edited
  summary is kept), stores suggested categories and proposals for new ones (neither is applied), and writes
  an `ai:` block (provider, model, prompt version, date) to the front matter. Limits: `AI_CALL_TIMEOUT_SECONDS`,
  `AI_MAX_ATTEMPTS` (transient errors only, with backoff), `AI_DAILY_CAP` (every call counts), `AI_CONCURRENCY`,
  `AI_CIRCUIT_BREAKER_FAILURES` (the queue then pauses until you press Resume) and `AI_MAX_TOKENS`.
  Jobs left running by a crash are re-queued at startup; finished jobs are deleted after `JOB_RETENTION_DAYS`.
  With the AI not configured, uploads skip the queue and are "Ready for review" at once.
- AI pages: `/admin/ai` (AI Lab: test the connection, run the model over a doc or a file and see the
  validated output; nothing is saved) and `/admin/jobs` (queue, retry, dismiss, resume). The dashboard shows
  calls used today and a banner when the queue is paused.
- Review and approval: nothing is visible to readers until you approve it. `/admin/review` is the queue
  (documents awaiting review, an "Unpublished" filter, pending category proposals, failed jobs). A document's
  review screen (`/admin/review/<id>`) edits the AI's summary, keywords, synonyms and questions, picks up to
  three categories (the first is primary) and accepts, renames or rejects proposed new categories; approving
  writes the categories and `published: true` to the front matter and publishes. "Approve selected" and
  "Approve all ready" list what they will approve first and hold back documents with exceptions (undecided
  proposals, unresolved links, raw HTML, oversize). A `categories: [math/calculus]` line in an upload files
  the document under a category that exists (paths are slugs joined with `/`); anything unmatched becomes a
  proposal and is never created automatically.
- Bulk import: `/admin/import` takes many `.md` files (up to `BULK_MAX_FILES`), asks you to confirm the number
  of AI calls (granting a one-time allowance above `AI_DAILY_CAP` if needed), then imports them with `-2`
  style suffixes for taken slugs. A file that fails (oversize, bad encoding, bad front matter) is skipped and
  listed in the import report, which also shows each document's slug and exceptions.
- `/admin/status` is the Phase 0 status page (it was `/` before Phase 2). `/healthz` is unchanged.
- Each document is stored as `<slug>.md` in `DOCS_DIR`, with `id`, `slug`, `title`,
  `published`, `categories` (ids) and, when set, `keywords`, `key_phrases`, `synonyms` and `questions` in its front matter. The file is canonical; the database is an index.
- In documents, write currency as `\$5`: a bare `$` starts an equation.

Run `make` with no argument for every target.
