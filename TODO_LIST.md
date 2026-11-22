# MDpedia TODO list

Work that was deliberately left out of the first version, in the order I recommend doing it. Nothing here blocks normal use. The schema and file layout were kept free of anything that would get in the way. Background is in `mdpedia-project-brainstorm.md` section 10 and `roadmap.md` section 5.

## Before wider use

### 1. Finish the launch checklist
The checklist in `roadmap.md` section 6 should be fully ticked before the wiki is relied on: category tree seeded, a 30 to 50 query search test set written and run, a full backup and restore drill completed, `make check-raw-tags` reviewed, and the firewall confirmed. Note: the last Phase 11 test run (`Phase11_fail.txt`) recorded two XSS corpus failures, fixed in the "Fixing XSS corpus" commit. Re-run `make test` to confirm a clean pass.

### 2. Add a LICENSE
The repository has none, so others have no right to use or modify it. Choose one and add it. This matters most if the project stays public on GitHub.

### 3. HTTPS for the admin area
**Why:** admin passwords and session cookies currently cross the network in clear text.
**What:** put a reverse proxy (Caddy or nginx) with a certificate in front, set `TRUST_PROXY` and `COOKIE_SECURE=true`, re-enable HSTS and `upgrade-insecure-requests` in `app/app.js`, and document the setup in `docs/OPERATIONS.md`.

### 4. Version history and undo
**Why:** an approved replacement or bulk AI edit cannot currently be rolled back except from a backup.
**What:** keep each document's earlier versions, either by committing to a git repository in `DOCS_DIR` (fixed identity, `execFile` with fixed arguments) or by archive and trash folders. Add a history view, a restore action and rollback of replacements. This also unlocks permanent delete (next item).

### 5. Permanent delete
**Why:** documents can only be unpublished, so unwanted content stays on disk.
**What:** a delete action with a confirmation that names what is lost, shipped together with item 4 so it can be undone. Remove the file, the row, its links, vectors and terms.

### 6. Automated backups
**Why:** the backup is manual and the dashboard only warns when it is stale.
**What:** a systemd timer (or cron) running `make backup` nightly with the drive left plugged in. Keep the "refuses to run if not mounted" rule and the stale warning.

## Next features

### 7. Images and attachments
**What:** raster formats only (PNG, JPEG, WebP, GIF), stored by id outside the docs directory, size-limited, SVG rejected. Allow `<img>` only for app-served ids in the sanitizer, add an upload control, and include the files in backups and reconciliation.

### 8. Insert-link picker
**What:** a search box in the editor that finds a document and inserts `[[slug]]` for the admin, so slugs need not be remembered.

### 9. Bulk category move and merge
**What:** "move all documents from category A to B" and "merge A into B", with a dry-run listing, backup-age warning and audit entry. Today documents must be reassigned one at a time.

### 10. In-browser editing
**What:** edit a document's Markdown in the admin UI with a live preview, going through the same checks as an upload. Today changes mean uploading a replacement or editing the file on disk.

### 11. Chunked AI processing for large documents
**What:** split documents above the upload cap or the model's practical limit, extract per chunk and merge the results. Raise `MAX_UPLOAD_BYTES` only after this exists.

## Search and AI improvements

### 12. Decide the future of vector search
Phase 11 is an admin-only lab. Once the comparison page has scored the test set both ways, decide whether to:
- blend keyword and vector rankings with Reciprocal Rank Fusion;
- chunk bodies by heading for finer matches;
- offer a public semantic search page. This needs rate limiting and caching first, because it triggers model inference on every query.

Contingencies, only if the in-process model proves unusable on the host: Ollama with `nomic-embed-text` (768 dimensions, needs a migration and full re-embed), then an admin-only embedding API.

### 13. Chat front end for bulk AI edit
**What:** a conversational helper that drafts the instruction and scope for `/admin/edit`, then hands off to the existing dry run and per-document review.

## Maintenance and quality

### 14. Continuous integration
**What:** a GitHub Actions workflow running `make lint`, `make test` (with a MariaDB 11.8 service), `make check-raw-tags` and `make audit` on every push.

### 15. Automated browser tests
**What:** the smoke test in `roadmap.md` section 4 is manual. Automate the key paths (log in, upload, review, publish, search, replace) with Playwright.

### 16. Optional admin SPA
Only if the server-rendered admin proves too limiting. Reader pages stay server-rendered.
