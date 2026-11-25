#!/usr/bin/env bash
# Creates the MDpedia database and user on the local MariaDB server, from the
# values in .env. Safe to run again: it only creates what is missing, and it
# resets the user's password to the one in .env.
#
#   sudo scripts/setup-db.sh                  database and user
#   sudo scripts/setup-db.sh --with-test-db   also <DB_NAME>_test, for `make test`
#
# It also makes sure innodb_ft_min_token_size is 2 (the default is 3), which
# must be true before `make migrate` creates the FULLTEXT index. If it has to
# change that, it writes a config file and restarts MariaDB.
#
# It connects as the MariaDB root account over the local socket, which is why
# it needs sudo. The app itself never sees that account.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
MIN_MARIADB=11.7
WITH_TEST_DB=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

for arg in "$@"; do
  case "$arg" in
    --with-test-db) WITH_TEST_DB=1 ;;
    -h|--help)      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "unknown option: $arg" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run this with sudo: sudo scripts/setup-db.sh"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Copy .env.example to .env first (install.sh does this)."

# Read single values without evaluating the file.
env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d "\"'\r"
}

DB_HOST="$(env_value DB_HOST)"; DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(env_value DB_PORT)"; DB_PORT="${DB_PORT:-3306}"
DB_NAME="$(env_value DB_NAME)"
DB_USER="$(env_value DB_USER)"
DB_PASSWORD="$(env_value DB_PASSWORD)"

[[ -n "$DB_NAME" && -n "$DB_USER" ]] || die "DB_NAME and DB_USER must be set in $ENV_FILE."
[[ -n "$DB_PASSWORD" ]] || die "DB_PASSWORD is empty in $ENV_FILE. Set a long random one, for example: openssl rand -hex 24"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ && "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] \
  || die "DB_NAME and DB_USER may contain only letters, digits and underscores."
[[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]] \
  || die "DB_HOST is $DB_HOST. This script sets up a database on this machine only; for a remote server, create the database and user there (db/README.md)."

CLIENT="$(command -v mariadb || command -v mysql || true)"
[[ -n "$CLIENT" ]] || die "No mariadb client found. Is MariaDB installed? (install.sh --install-prereqs installs it.)"

admin() { "$CLIENT" -N -B "$@"; }

wait_for_server() {
  local i
  for i in $(seq 1 30); do
    if admin -e 'SELECT 1' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "MariaDB is not answering on its local socket. Check: systemctl status mariadb"
}

restart_server() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart mariadb 2>/dev/null || systemctl restart mysql
  else
    die "Cannot restart MariaDB here (no systemctl). Restart it yourself, then run this script again."
  fi
}

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now mariadb >/dev/null 2>&1 || systemctl enable --now mysql >/dev/null 2>&1 || true
fi
wait_for_server

# ------------------------------------------------------- FULLTEXT token size

token_size() { admin -e "SHOW VARIABLES LIKE 'innodb_ft_min_token_size'" | awk '{print $2}'; }

if [[ "$(token_size)" != "2" ]]; then
  CONF_DIR=""
  for d in /etc/mysql/mariadb.conf.d /etc/my.cnf.d /etc/mysql/conf.d; do
    if [[ -d "$d" ]]; then CONF_DIR="$d"; break; fi
  done
  [[ -n "$CONF_DIR" ]] || die "Found no MariaDB config directory. Add 'innodb_ft_min_token_size=2' under [mysqld] yourself, restart MariaDB, and run this script again."
  say "Setting innodb_ft_min_token_size=2 in $CONF_DIR/99-mdpedia.cnf and restarting MariaDB"
  printf '[mysqld]\ninnodb_ft_min_token_size=2\n' > "$CONF_DIR/99-mdpedia.cnf"
  restart_server
  wait_for_server
  [[ "$(token_size)" == "2" ]] || die "innodb_ft_min_token_size is still $(token_size). Another config file may override $CONF_DIR/99-mdpedia.cnf."
fi
say "innodb_ft_min_token_size = 2"

# ------------------------------------------------------------ database and user

# Escape the password for a single-quoted SQL string.
q="'"
PW_SQL="${DB_PASSWORD//\\/\\\\}"
PW_SQL="${PW_SQL//$q/\\$q}"

DATABASES=("$DB_NAME")
[[ $WITH_TEST_DB -eq 1 ]] && DATABASES+=("${DB_NAME}_test")

SQL=""
for db in "${DATABASES[@]}"; do
  SQL+="CREATE DATABASE IF NOT EXISTS \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"$'\n'
done
# MariaDB treats localhost (socket) and 127.0.0.1 (TCP) as different accounts.
for host in localhost 127.0.0.1; do
  SQL+="CREATE USER IF NOT EXISTS '$DB_USER'@'$host' IDENTIFIED BY '$PW_SQL';"$'\n'
  SQL+="ALTER USER '$DB_USER'@'$host' IDENTIFIED BY '$PW_SQL';"$'\n'
  for db in "${DATABASES[@]}"; do
    SQL+="GRANT ALL PRIVILEGES ON \`$db\`.* TO '$DB_USER'@'$host';"$'\n'
  done
done
SQL+="FLUSH PRIVILEGES;"$'\n'

# Through stdin, so the password never appears in the process list.
printf '%s' "$SQL" | admin
say "Database ${DATABASES[*]} and user $DB_USER are ready"

# ----------------------------------------------------------------------- verify

VERSION="$(MYSQL_PWD="$DB_PASSWORD" "$CLIENT" -h 127.0.0.1 -P "$DB_PORT" -u "$DB_USER" -N -B "$DB_NAME" -e 'SELECT VERSION()' 2>/dev/null)" \
  || die "Created the user, but logging in as $DB_USER on 127.0.0.1:$DB_PORT failed. Check DB_PORT in $ENV_FILE."
say "Login as $DB_USER works. Server version $VERSION"

SERVER_NUM="$(printf '%s' "$VERSION" | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
if [[ -n "$SERVER_NUM" && "$(printf '%s\n%s\n' "$MIN_MARIADB" "$SERVER_NUM" | sort -V | head -n 1)" != "$MIN_MARIADB" ]]; then
  printf 'WARNING: MariaDB %s is older than %s. Migrations 011 and 012 (vector search) will fail.\n' "$SERVER_NUM" "$MIN_MARIADB" >&2
fi

say
say "Next: make env-check && make migrate && make admin"
