#!/usr/bin/env bash
# MDpedia backup. Run it by hand with the
# external drive plugged in:   make backup     or     bash scripts/backup.sh
#
# Copies three things to BACKUP_TARGET/mdpedia/<YYYYMMDD-HHMMSS>/ :
#   docs/              the Markdown directory (DOCS_DIR): the canonical data
#   categories.yaml    the category tree with its ids (rewritten from the database first)
#   <db>.sql           a dump of the project database
#
# Rules it keeps:
#   - It refuses to write unless BACKUP_TARGET is a mounted filesystem (an unplugged
#     drive leaves an empty directory on the SD card, which would look like success)
#     and that filesystem is not the one the docs live on.
#   - It copies into a ".partial-" folder, verifies every file against its source, and only
#     then renames the folder. A failed or interrupted run never leaves a half backup that looks whole.
#   - The "last backup" time (DATA_DIR/last-backup.txt on this machine, and the backup_status
#     table the dashboard reads) is written only after that verification. A failed run
#     records the failure but never moves the last-success time.
#   - It never reports success when it did not succeed: the exit status is 0 only for a verified backup.
#
# Settings come from .env (BACKUP_TARGET, BACKUP_KEEP, and the usual DB_* and *_DIR);
# a value set in the environment for this run wins over the file. To restore, see docs/OPERATIONS.md.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "BACKUP FAILED: $ENV_FILE not found. Copy .env.example and fill it in." >&2
  exit 1
fi

cli_target="${BACKUP_TARGET-}"
cli_keep="${BACKUP_KEEP-}"
cli_require_mount="${BACKUP_REQUIRE_MOUNT-}"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "$cli_target" ] && BACKUP_TARGET="$cli_target"
[ -n "$cli_keep" ] && BACKUP_KEEP="$cli_keep"
[ -n "$cli_require_mount" ] && BACKUP_REQUIRE_MOUNT="$cli_require_mount"

BACKUP_KEEP="${BACKUP_KEEP:-5}"
BACKUP_REQUIRE_MOUNT="${BACKUP_REQUIRE_MOUNT:-true}"

DB_CLIENT="$(command -v mariadb 2>/dev/null || command -v mysql 2>/dev/null || echo mariadb)"
DUMP_BIN="$(command -v mariadb-dump 2>/dev/null || command -v mysqldump 2>/dev/null || echo mariadb-dump)"

LOCK_DIR=""
PARTIAL=""
WORK=""

cleanup() {
  [ -n "$PARTIAL" ] && [ -d "$PARTIAL" ] && rm -rf -- "$PARTIAL"
  [ -n "$WORK" ] && [ -d "$WORK" ] && rm -rf -- "$WORK"
  [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'echo "BACKUP INTERRUPTED. Nothing was marked as backed up." >&2; exit 130' INT TERM

# Keeps only characters that are safe inside the SQL string below.
sanitize() { printf '%s' "$1" | tr -cd 'A-Za-z0-9 ._/(),:=-' | cut -c1-250; }

# Best effort: a down database must not hide the real failure.
run_sql() {
  [ -n "${DB_NAME:-}" ] || return 1
  MYSQL_PWD="${DB_PASSWORD:-}" "$DB_CLIENT" -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -u "${DB_USER:-}" "$DB_NAME" -e "$1" >/dev/null 2>&1
}

fail() {
  echo >&2
  echo "BACKUP FAILED: $1" >&2
  echo "Nothing was marked as backed up. The dashboard still shows the previous backup." >&2
  run_sql "UPDATE backup_status SET last_attempt_at = NOW(), last_result = 'failed', last_message = '$(sanitize "$1")' WHERE id = 1" || true
  exit 1
}

for key in BACKUP_TARGET DOCS_DIR DATA_DIR DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD; do
  if [ -z "${!key:-}" ]; then
    fail "$key is empty or missing in $ENV_FILE."
  fi
done

BACKUP_TARGET="${BACKUP_TARGET%/}"
case "$BACKUP_TARGET" in
  /*) ;;
  *) fail "BACKUP_TARGET must be an absolute path (got \"$BACKUP_TARGET\")." ;;
esac
[ -n "$BACKUP_TARGET" ] || fail "BACKUP_TARGET must not be the root directory."
case "$BACKUP_KEEP" in
  '' | *[!0-9]*) fail "BACKUP_KEEP must be a whole number (got \"$BACKUP_KEEP\")." ;;
esac
[ "$BACKUP_KEEP" -ge 1 ] || fail "BACKUP_KEEP must be at least 1."
[ -d "$DOCS_DIR" ] || fail "DOCS_DIR $DOCS_DIR does not exist."

is_mounted() {
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q "$1"
    return
  fi
  mount | grep -F -- " on $1 " >/dev/null 2>&1
}

device_of() { df -P "$1" 2>/dev/null | awk 'NR == 2 { print $1 }'; }

# ----------------------------------------------------------------- the drive

if [ "$BACKUP_REQUIRE_MOUNT" = "false" ]; then
  echo "WARNING: BACKUP_REQUIRE_MOUNT=false. The mount check is off. Use this only for a drill or a test, never for a real backup." >&2
  [ -d "$BACKUP_TARGET" ] || fail "BACKUP_TARGET $BACKUP_TARGET does not exist."
else
  [ -d "$BACKUP_TARGET" ] || fail "the backup drive is not available: $BACKUP_TARGET does not exist. Plug in and mount the drive."
  is_mounted "$BACKUP_TARGET" || fail "the backup drive is not mounted at $BACKUP_TARGET. Plug it in and mount it, then run the backup again. Nothing was written."
  target_device="$(device_of "$BACKUP_TARGET")"
  docs_device="$(device_of "$DOCS_DIR")"
  if [ -n "$target_device" ] && [ "$target_device" = "$docs_device" ]; then
    fail "$BACKUP_TARGET is on the same disk as the documents ($docs_device). That is not a backup."
  fi
fi

probe="$BACKUP_TARGET/.mdpedia-write-test.$$"
if ! touch "$probe" 2>/dev/null; then
  fail "cannot write to $BACKUP_TARGET (read-only, full, or wrong permissions)."
fi
rm -f "$probe"

DEST_ROOT="$BACKUP_TARGET/mdpedia"
mkdir -p "$DEST_ROOT" || fail "cannot create $DEST_ROOT."

# ----------------------------------------------------------------- one at a time

LOCK_DIR="$DATA_DIR/.backup.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_DIR=""
  fail "another backup seems to be running. If none is, remove $DATA_DIR/.backup.lock and try again."
fi

# Leftovers of a run that was killed hard.
for old in "$DEST_ROOT"/.partial-*; do
  [ -d "$old" ] && rm -rf -- "$old"
done

STAMP="$(date +%Y%m%d-%H%M%S)"
PARTIAL="$DEST_ROOT/.partial-$STAMP"
FINAL="$DEST_ROOT/$STAMP"
[ ! -e "$FINAL" ] || fail "$FINAL already exists. Wait a second and run again."
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdpedia-backup.XXXXXX")" || fail "cannot create a temporary directory."
mkdir -p "$PARTIAL/docs" || fail "cannot create $PARTIAL."

echo "Backing up to $FINAL"

# ----------------------------------------------------------------- categories

echo "  categories.yaml ..."
(cd "$ROOT" && node scripts/export-categories.js) || fail "could not rewrite categories.yaml from the database (is MariaDB running?)."
[ -s "$DATA_DIR/categories.yaml" ] || fail "$DATA_DIR/categories.yaml is missing or empty."

# ----------------------------------------------------------------- the dump

echo "  database dump ..."
DUMP_NAME="$DB_NAME.sql"
MYSQL_PWD="$DB_PASSWORD" "$DUMP_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  --single-transaction --routines --events "$DB_NAME" > "$WORK/$DUMP_NAME" 2> "$WORK/dump.err" \
  || fail "the database dump failed: $(head -c 200 "$WORK/dump.err")"
[ -s "$WORK/$DUMP_NAME" ] || fail "the database dump is empty."
grep -q 'Dump completed' "$WORK/$DUMP_NAME" || fail "the database dump is incomplete (no completion line)."

# ----------------------------------------------------------------- copy

echo "  documents ..."
if command -v rsync >/dev/null 2>&1; then
  rsync -a -- "$DOCS_DIR"/ "$PARTIAL/docs"/ || fail "copying the documents failed."
else
  cp -a "$DOCS_DIR"/. "$PARTIAL/docs"/ || fail "copying the documents failed."
fi
cp "$DATA_DIR/categories.yaml" "$PARTIAL/categories.yaml" || fail "copying categories.yaml failed."
cp "$WORK/$DUMP_NAME" "$PARTIAL/$DUMP_NAME" || fail "copying the dump failed."
sync

# ----------------------------------------------------------------- verify

echo "  verifying ..."
diff -rq -- "$DOCS_DIR" "$PARTIAL/docs" > "$WORK/diff.out" 2>&1 \
  || fail "the copied documents differ from the originals (were files edited during the copy?). $(head -c 200 "$WORK/diff.out")"
cmp -s "$DATA_DIR/categories.yaml" "$PARTIAL/categories.yaml" || fail "the copied categories.yaml differs from the original."
cmp -s "$WORK/$DUMP_NAME" "$PARTIAL/$DUMP_NAME" || fail "the copied dump differs from the original."

DOCS_COUNT="$(find "$PARTIAL/docs" -type f -name '*.md' | wc -l | tr -d ' ')"
DUMP_BYTES="$(wc -c < "$PARTIAL/$DUMP_NAME" | tr -d ' ')"
NOW_EPOCH="$(date +%s)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

{
  echo "MDpedia backup $STAMP"
  echo "taken (UTC)   $NOW_ISO"
  echo "documents     $DOCS_COUNT files from $DOCS_DIR"
  echo "database      $DB_NAME ($DUMP_BYTES bytes)"
  echo "categories    categories.yaml"
} > "$PARTIAL/MANIFEST.txt" || fail "cannot write the manifest."
sync

mv -- "$PARTIAL" "$FINAL" || fail "cannot move the finished backup into place."
PARTIAL=""

# ----------------------------------------------------------------- record

# Only now, after a verified copy: the time on this machine, then the database.
STATUS_TMP="$DATA_DIR/.last-backup.$$"
if printf 'epoch=%s\niso=%s\ntarget=%s\ndocs=%s\n' "$NOW_EPOCH" "$NOW_ISO" "$FINAL" "$DOCS_COUNT" > "$STATUS_TMP" \
  && mv -- "$STATUS_TMP" "$DATA_DIR/last-backup.txt"; then
  :
else
  rm -f "$STATUS_TMP"
  echo "WARNING: the backup is good, but $DATA_DIR/last-backup.txt could not be written." >&2
fi

if ! run_sql "UPDATE backup_status SET last_success_at = NOW(), last_attempt_at = NOW(), last_result = 'ok', last_message = 'Verified copy written.', last_target = '$(sanitize "$FINAL")', docs_count = $DOCS_COUNT, dump_bytes = $DUMP_BYTES WHERE id = 1"; then
  echo "WARNING: the backup is good, but the backup_status table was not updated (is migration 010 applied?). The dashboard falls back to last-backup.txt." >&2
fi

# ----------------------------------------------------------------- retention

# Keep the newest BACKUP_KEEP backups; only folders named like a timestamp are touched.
total="$(ls -1 "$DEST_ROOT" | grep -cE '^[0-9]{8}-[0-9]{6}$')"
if [ "$total" -gt "$BACKUP_KEEP" ]; then
  ls -1 "$DEST_ROOT" | grep -E '^[0-9]{8}-[0-9]{6}$' | sort | awk -v drop="$((total - BACKUP_KEEP))" 'NR <= drop' | while read -r old; do
    [ -n "$old" ] && rm -rf -- "${DEST_ROOT:?}/$old" && echo "  removed the old backup $old"
  done
fi

echo
echo "BACKUP OK: $FINAL"
echo "  $DOCS_COUNT documents, categories.yaml, $DB_NAME.sql ($DUMP_BYTES bytes), verified."
exit 0
