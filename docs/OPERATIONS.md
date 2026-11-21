# MDpedia operations

How to run MDpedia on the Pi: install it as a service, release a new version, back it up and restore it, and what to do when the dashboard shows a warning. Commands run in the app directory unless they start with `sudo`.

Paths used below: the app in `/srv/MDpedia/app-current`, the data in `/srv/MDpedia-data` (`DOCS_DIR`, `STAGING_DIR`, `DATA_DIR`), the backup drive mounted at `/mnt/backup`. Change them to match your `.env` and `deploy/wiki.service`.

## 1. Install as a service

One time, as root:

```bash
sudo useradd --system --home /srv/MDpedia --shell /usr/sbin/nologin MDpedia
sudo chown -R MDpedia:MDpedia /srv/MDpedia /srv/MDpedia-data
sudo chmod 600 /srv/MDpedia/app-current/.env && sudo chown MDpedia:MDpedia /srv/MDpedia/app-current/.env

# edit WorkingDirectory, ExecStart (command -v node) and ReadWritePaths first
sudo install -m 644 deploy/wiki.service /etc/systemd/system/wiki.service
sudo systemctl daemon-reload
sudo systemctl enable --now wiki
systemctl status wiki
journalctl -u wiki -f          # the JSON log lines
```

`deploy/wiki.service` runs the app as the non-root, non-login `MDpedia` user, restarts it after a crash or a kill (`Restart=on-failure`, 5 seconds apart), starts it at boot, and limits what it can touch: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, and write access only to the data directory. The app code and `.env` are read-only to it. Settings come from `.env` through dotenv, not from systemd.

**Journal size cap**, so logs do not fill or wear the SD card:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo install -m 644 deploy/journald-wiki.conf /etc/systemd/journald.conf.d/wiki.conf
sudo systemctl restart systemd-journald
journalctl --disk-usage
```

**Firewall**, matched to `PORT` in `.env`. The script prints the `ufw` commands first; `--apply` runs them:

```bash
bash deploy/firewall.sh 192.168.1.0/24            # read the steps
bash deploy/firewall.sh 192.168.1.0/24 --apply
```

Also: no port-forward to the Pi on the router, and UPnP off. If `PORT` changes, run the script again and delete the old rule (`sudo ufw status numbered`, `sudo ufw delete N`).

## 2. Release steps

1. Take a backup first (section 3) and check the dashboard shows it is fresh.
2. On your development machine: `make lint`, `make test`, `make check-raw-tags`, `make audit`. All must pass; review any `<%-` that `check-raw-tags` lists.
3. Copy the new version into place (keep the old directory until the smoke test passes). Keep `.env`.
4. `npm ci --omit=dev` (or `npm install --omit=dev` if there is no lock file).
5. `make migrate-status`, then `make migrate`. It dumps the database to `backups/` first, then applies the pending SQL files. The app never migrates itself, and `/admin/status` says which file is missing if you forget.
6. `sudo systemctl restart wiki`, then `make health` and `systemctl status wiki`.
7. Work down `make smoke` in the browser (about ten minutes).
8. Problems: stop the service, restore the old directory and, if a migration ran, the dump from step 5 (section 4), then start it again.

## 3. Backups

What is backed up: the Markdown directory (the canonical data), `categories.yaml` (the category tree with its ids), and a dump of the project database (search log, job history, accounts and the index live only there).

**Drive.** Format it ext4 (not exFAT or NTFS) so permissions work. Mount it by UUID at `/mnt/backup`, with `nofail` so the Pi still boots without it:

```
# /etc/fstab
UUID=<from blkid>  /mnt/backup  ext4  defaults,nofail  0  2
```

Set `BACKUP_TARGET=/mnt/backup` in `.env`. The mount directory itself lives on the SD card and is empty when the drive is out, which is exactly the trap the script guards against.

**Run it**, with the drive plugged in and mounted:

```bash
make backup           # or: bash scripts/backup.sh
echo $?               # 0 only for a verified backup
```

It does this, in order, and stops at the first failure:

1. Refuses unless `BACKUP_TARGET` is a mounted filesystem, is not the disk the documents are on, and is writable. An unplugged drive gives `BACKUP FAILED: the backup drive is not mounted ...` and exit status 1. Nothing is written.
2. Rewrites `categories.yaml` from the database, so the copy is current.
3. Dumps the database (`--single-transaction --routines --events`) and checks the dump finished.
4. Copies everything into `BACKUP_TARGET/mdpedia/.partial-<timestamp>/`, then compares every copied file with its source.
5. Renames the folder to `BACKUP_TARGET/mdpedia/<YYYYMMDD-HHMMSS>/` (with a `MANIFEST.txt`).
6. Only then records the time: `DATA_DIR/last-backup.txt` on the Pi and the `backup_status` table. A failed run records the failure (shown on `/admin/maintenance`) and leaves the last-success time alone.
7. Removes older backups beyond `BACKUP_KEEP` (default 5). Only folders named like a timestamp are touched.

A backup on a drive that is always plugged in shares the Pi's failure modes (surge, theft, fire, a slip of `rm`). Rotate the drive or keep a second copy elsewhere if the content matters.

**Dashboard.** "Last backup: N days ago" turns into a warning at `BACKUP_STALE_DAYS` days or more (default 7; `0` always warns). The same age is shown before bulk import, bulk approve, bulk AI edits, retrying failed AI jobs, and category changes (reorder, edit, move, delete). `/admin/maintenance` shows the details and the last failed attempt.

## 4. Restore

**The restore drill** (do it once before launch, and after any change to the backup): restore into a second database and a scratch directory, run a second copy of the app on another port, and compare. The live wiki is not touched.

```bash
BK=/mnt/backup/mdpedia/<timestamp>        # the backup to test
R=/srv/MDpedia-restore
mkdir -p $R/docs $R/staging
cp -a $BK/docs/. $R/docs/
cp $BK/categories.yaml $R/

# database (as the MariaDB admin; the dump holds no CREATE DATABASE)
sudo mariadb -e "CREATE DATABASE MDpedia_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON MDpedia_restore.* TO 'MDpedia_app'@'127.0.0.1';"
mariadb -h 127.0.0.1 -u MDpedia_app -p MDpedia_restore < $BK/MDpedia.sql

# a second .env: same file with these changed
cp .env .env.restore
#   DB_NAME=MDpedia_restore  DOCS_DIR=/srv/MDpedia-restore/docs  STAGING_DIR=/srv/MDpedia-restore/staging
#   DATA_DIR=/srv/MDpedia-restore  PORT=3100
ENV_FILE=.env.restore npm start           # in a second terminal
```

Then check: the document count and the category tree match (`/admin/docs`, `/admin/categories` on both ports); `diff categories.yaml` against the live `DATA_DIR`; press "Rescan now" on `/admin/attention` of the restored copy and it reports nothing; and every permalink resolves to the same address on both:

```bash
for id in $(mariadb -h 127.0.0.1 -u MDpedia_app -p -N -e "SELECT id FROM MDpedia.docs WHERE published = 1"); do
  a=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:3000/doc?id=$id" | sed 's#^http://[^/]*##')
  b=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:3100/doc?id=$id" | sed 's#^http://[^/]*##')
  [ "$a" = "$b" ] || echo "MISMATCH id $id: $a vs $b"
done
```

Clean up afterwards: stop the second app, `DROP DATABASE MDpedia_restore;`, `rm -r /srv/MDpedia-restore .env.restore`.

**A real restore** (the database or the SD card is lost): reinstall the app and `.env`, create the database and user (`db/README.md`), restore the documents into `DOCS_DIR`, load the dump into the empty database, copy `categories.yaml` into `DATA_DIR`, start the service. The dump matters: it holds the document ids that permalinks (`/doc?id=`) use. Files alone are not enough, because a document is added by upload and reconciliation lists a file it does not know as "untracked" (an import would hand out new ids). The ids are in each file's front matter, so a future "rebuild the index from files" tool is possible, but it does not exist yet.

If only the dump is lost, restore the documents and categories from the drive anyway and pick the newest backup that has a dump.

## 5. When the dashboard shows a warning

| Warning | What it means | What to do |
|---|---|---|
| Last backup N days old (or "No backup has been recorded") | The newest verified backup is `BACKUP_STALE_DAYS` days old or more. | Plug in the drive, `make backup`. If it fails, read the message: not mounted, not writable, dump failed. |
| "The last attempt failed" under the backup | The latest `make backup` did not finish. The old backup stands. | Fix the cause in the message and run it again. |
| AI queue is paused | The circuit breaker tripped after repeated provider failures. | Fix the cause (key, URL, provider outage; `/admin/ai` tests the connection), then Resume on `/admin/jobs`, then retry the failed jobs. |
| Failed jobs | A job gave up after its attempts. | `/admin/jobs?status=failed`: read the message, retry or dismiss. |
| Cap reached: queued jobs wait | `AI_DAILY_CAP` calls used today. | Wait for tomorrow, or raise the cap in `.env` and restart. |
| Documents needing attention / rejected files | A file was edited into an invalid state, is missing, or claims another document's id or slug. | `/admin/attention`: fix or restore the file, then Rescan now. |
| Unresolved links | A `[[link]]` points to a missing or unpublished document. | `/admin/links`. |
| Schema behind (`/admin/status`) | A migration has not been applied. | `make migrate-status`, then `make migrate`. |
| A maintenance task shows "Failed" | Pruning hit a database error. | Check `journalctl -u wiki`; run it again from `/admin/maintenance`. |
| `/healthz` returns 503 (`make health`) | The database does not answer, or the worker loop has stopped waking up. | `systemctl status mariadb`; `journalctl -u wiki -n 100`; `sudo systemctl restart wiki` if the database is fine. |

## 6. Health check

`GET /healthz` answers 200 `{"status":"ok"}` only when the database answers and the worker loop is alive, and 503 `{"status":"fail"}` otherwise. It never says which check failed. The worker loop reports a heartbeat on every poll; it counts as dead after about a minute of silence (more if `JOB_POLL_INTERVAL_SECONDS` is large). With the AI not configured there is no worker loop, and only the database is checked. After MariaDB restarts the app recovers by itself and `/healthz` turns 200 again with no app restart. `make health` calls it.

## 7. Maintenance

The maintenance job runs at start and every six hours, and `/admin/maintenance` runs it by hand. It removes: search-log rows older than `SEARCH_LOG_RETENTION_DAYS` (default 90; the per-day totals in `search_daily` stay), audit entries older than `AUDIT_RETENTION_DAYS` (default 365), and finished (done) jobs older than `JOB_RETENTION_DAYS` (default 30; failed jobs stay until dismissed). Each task's last run, trigger, result and row count are kept in `maintenance_runs` and shown on the page; a manual run is written to the audit log.

### Vector search (Phase 11)

Off unless `EMBED_PROVIDER=transformersjs`. The model downloads from Hugging Face on first use into `EMBED_CACHE_DIR` (default `DATA_DIR/embed-cache`, inside the data directory the hardened service may write). The Pi needs outbound access to Hugging Face once. The cache is disposable and is not backed up; the vectors themselves are in the database dump. Check free memory (`free -h`) with MariaDB and the wiki running before enabling it. `doc_vectors` needs MariaDB 11.7 or later. After changing `EMBED_MODEL`, `EMBED_DTYPE`, `EMBED_POOLING` or `EMBED_DOC_PREFIX`, press "Rebuild all vectors" on `/admin/vectors`.

## 8. Tests

- `make test`: drops and rebuilds `MDpedia_test` from the migrations (`make test-db-reset`), then runs `npm test` against it with `TEST_DB_NAME=MDpedia_test`. This is the full run.
- `make test-quick`: `npm test` without a database; the tests that need one are skipped.
- The database tests (visibility) read the database name from `TEST_DB_NAME` only, never from `DB_NAME`, and refuse any name that does not end in `_test`: `TEST_DB_NAME=MDpedia npm test` stops with "Refusing to run", and `make test TEST_DB=MDpedia` refuses before it drops anything.
- The XSS corpus (`test/xss-corpus.test.js`) is a fixed list of hostile inputs that must render inert. Add every real bug found to it.
- `make check-raw-tags` lists every `<%-` in the templates and fails on any that is not an include or a reviewed use of sanitized document HTML. The allowlist is `scripts/lib/raw-tags.js`.
- `make samples-verify` checks the fixtures; `make lint` runs eslint.
