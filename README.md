# MDpedia

A Markdown wiki for a Raspberry Pi: math rendering, keyword search, and AI-assisted metadata.

- `roadmap.md`: the build order and the test checklist for each phase.
- `mdpedia-project-brainstorm.md`: the decision log behind it.
- `db/README.md`: the SQL workflow.
- `samples/README.md`: the test fixtures.

## Quick start (Phase 0)

```bash
cp .env.example .env     # fill in DB_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
chmod 600 .env
make env-check
make install
make migrate-status
make migrate
make start
```

Run `make` with no argument for every target.
