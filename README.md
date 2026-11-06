# MDpedia

A Markdown wiki for a Raspberry Pi: math rendering, keyword search, and AI-assisted metadata.

- `roadmap.md`: the build order and the test checklist for each phase.
- `mdpedia-project-brainstorm.md`: the decision log behind it.
- `db/README.md`: the SQL workflow.
- `samples/README.md`: the test fixtures.

## Quick start (through Phase 2)

```bash
cp .env.example .env     # fill in DB_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
chmod 600 .env
mkdir -p /srv/MDpedia-data/docs /srv/MDpedia-data/staging   # your DOCS_DIR and STAGING_DIR: one filesystem, writable by the app user
make env-check
make install
make migrate-status
make migrate      # applies 000 to 002 (takes a dump first)
make admin        # creates the admin; also resets the password
make start
```

Then open `http://<pi-address>:3000/admin` and log in.

- Readers: `/` lists published documents, `/wiki/<slug>` and `/doc?id=<id>` show one.
- Admin: `/admin/docs` lists documents, `/admin/docs/new` uploads one. A new upload
  is saved unpublished; open it, check the preview, and publish it.
- `/admin/status` is the Phase 0 status page (it was `/` before Phase 2). `/healthz` is unchanged.
- Each document is stored as `<slug>.md` in `DOCS_DIR`, with `id`, `slug`, `title` and
  `published` in its front matter. The file is canonical; the database is an index.
- In documents, write currency as `\$5`: a bare `$` starts an equation.

Run `make` with no argument for every target.
