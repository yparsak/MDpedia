# MDpedia

A Markdown wiki for a Raspberry Pi: math rendering, keyword search, and AI-assisted metadata.

- `roadmap.md`: the build order and the test checklist for each phase.
- `mdpedia-project-brainstorm.md`: the decision log behind it.
- `db/README.md`: the SQL workflow.
- `samples/README.md`: the test fixtures.

## Quick start (through Phase 3)

```bash
cp .env.example .env     # fill in DB_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
chmod 600 .env
mkdir -p /srv/MDpedia-data/docs /srv/MDpedia-data/staging   # your DOCS_DIR and STAGING_DIR: one filesystem, writable by the app user
make env-check
make install
make migrate-status
make migrate      # applies 000 to 003 (takes a dump first)
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
- `/admin/status` is the Phase 0 status page (it was `/` before Phase 2). `/healthz` is unchanged.
- Each document is stored as `<slug>.md` in `DOCS_DIR`, with `id`, `slug`, `title`,
  `published` and `categories` (ids) in its front matter. The file is canonical; the database is an index.
- In documents, write currency as `\$5`: a bare `$` starts an equation.

Run `make` with no argument for every target.
