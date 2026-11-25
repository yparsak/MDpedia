#!/usr/bin/env bash
# MDpedia installer for Debian, Ubuntu and Raspberry Pi OS.
#
#   bash install.sh                      check the requirements, then install the latest release
#   bash install.sh --install-prereqs    also install what is missing (Node.js, MariaDB, build tools)
#   bash install.sh --help
#
# It downloads the latest GitHub release into ~/src/MDpedia, installs the Node
# dependencies and writes .env with generated secrets. It does not create the
# database: the last step offers to run scripts/setup-db.sh, which does.
#
# Run it as your normal user, not as root. It asks for sudo only where needed.

set -euo pipefail

APP_NAME="MDpedia"
APP_OWNER="yparsak"
GIT_API="https://api.github.com/repos"

NODE_MAJOR=22            # installed by --install-prereqs; the app needs 20 or later
MIN_NODE=20
MARIADB_SERIES=11.8      # installed by --install-prereqs; the app needs 11.7 or later (vectors)
MIN_MARIADB=11.7

SRC_PATH="${SRC_PATH:-$HOME/src}"
APP_PATH="$SRC_PATH/$APP_NAME"
DATA_DIR="/srv/MDpedia-data"

INSTALL_PREREQS=0
ASSUME_YES=0

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: bash install.sh [options]

  --install-prereqs   install missing Node.js $NODE_MAJOR, MariaDB $MARIADB_SERIES and build tools with apt
  --data-dir DIR      where documents are stored (default $DATA_DIR)
  -y, --yes           answer yes to every question
  -h, --help          show this help

The app is installed in \$SRC_PATH/$APP_NAME (default ~/src/$APP_NAME).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-prereqs) INSTALL_PREREQS=1 ;;
    --data-dir)        [[ $# -ge 2 ]] || die "--data-dir needs a directory"; DATA_DIR="$2"; shift ;;
    -y|--yes)          ASSUME_YES=1 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# Yes/no question. Without a terminal the answer is no, unless --yes was given.
ask() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ -t 0 ]] || return 1
  local reply
  read -r -p "$1 [Y/n] " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# True when version $1 is at least version $2.
version_ge() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" == "$2" ]]
}

# ------------------------------------------------------------------ preflight

[[ "$(uname -s)" == "Linux" ]] || die "This installer is for Linux. See SPEC.md section 5 for the manual steps."
[[ $EUID -ne 0 ]] || die "Run this as your normal user, not as root, so the app files are yours. It uses sudo when needed."

if [[ -d "$APP_PATH" ]]; then
  say "Path: $APP_PATH"
  die "Application directory found. Remove or rename it to reinstall."
fi

OS_ID=""; OS_CODENAME=""; OS_LIKE=""
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"; OS_CODENAME="${VERSION_CODENAME:-}"; OS_LIKE="${ID_LIKE:-}"
fi
IS_DEBIAN=0
if [[ "$OS_ID $OS_LIKE" =~ (debian|ubuntu) ]] && command -v apt-get >/dev/null 2>&1; then IS_DEBIAN=1; fi

# ------------------------------------------------------------ requirement check

APT_PKGS=()
NEED_NODE=0
NEED_MARIADB=0

add_pkg() {
  local p
  for p in "${APT_PKGS[@]:-}"; do [[ "$p" == "$1" ]] && return 0; done
  APT_PKGS+=("$1")
}

mariadb_server_version() {
  local bin
  bin="$(PATH="$PATH:/usr/sbin:/usr/local/sbin" command -v mariadbd || PATH="$PATH:/usr/sbin:/usr/local/sbin" command -v mysqld || true)"
  [[ -n "$bin" ]] || return 1
  "$bin" --version 2>/dev/null | sed -n 's/.*Ver \([0-9][0-9.]*\).*/\1/p' | head -n 1
}

check_requirements() {
  APT_PKGS=(); NEED_NODE=0; NEED_MARIADB=0
  local pair cmd pkg

  say "Checking requirements"
  for pair in curl:curl tar:tar make:build-essential g++:build-essential openssl:openssl zstd:zstd; do
    cmd="${pair%%:*}"; pkg="${pair##*:}"
    if command -v "$cmd" >/dev/null 2>&1; then
      say "  [>] $cmd"
    else
      say "  [X] $cmd is missing"
      add_pkg "$pkg"
    fi
  done

  local node_v=""
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    node_v="$(node -v | sed 's/^v//')"
  fi
  if [[ -z "$node_v" ]]; then
    say "  [X] Node.js $MIN_NODE or later (with npm) is missing"; NEED_NODE=1
  elif version_ge "$node_v" "$MIN_NODE"; then
    say "  [>] Node.js $node_v"
  else
    say "  [X] Node.js $node_v is older than $MIN_NODE"; NEED_NODE=1
  fi

  local db_v
  db_v="$(mariadb_server_version || true)"
  if [[ -z "$db_v" ]]; then
    say "  [X] MariaDB server is missing"; NEED_MARIADB=1
  elif version_ge "$db_v" "$MIN_MARIADB"; then
    say "  [>] MariaDB $db_v"
  else
    say "  [X] MariaDB $db_v is older than $MIN_MARIADB"
    die "Migrations 011 and 012 (vector search) need MariaDB $MIN_MARIADB or later. Upgrade MariaDB yourself (a database upgrade is not something this script does for you), then run it again."
  fi
}

# ---------------------------------------------------------------- prerequisites

install_prereqs() {
  [[ $IS_DEBIAN -eq 1 ]] || die "--install-prereqs supports Debian, Ubuntu and Raspberry Pi OS only. Install the missing items yourself (SPEC.md section 5.1), then run this script again."

  say
  say "About to install with apt (uses sudo):"
  [[ ${#APT_PKGS[@]} -eq 0 ]] || say "  packages:  ${APT_PKGS[*]}"
  [[ $NEED_NODE -eq 0 ]]    || say "  Node.js $NODE_MAJOR from the NodeSource repository (deb.nodesource.com)"
  [[ $NEED_MARIADB -eq 0 ]] || say "  MariaDB $MARIADB_SERIES from the MariaDB Foundation repository (deb.mariadb.org)"
  ask "Continue?" || die "Cancelled."

  sudo -v
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -d -m 755 /etc/apt/keyrings

  if [[ $NEED_NODE -eq 1 ]]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    add_pkg nodejs
  fi

  if [[ $NEED_MARIADB -eq 1 ]]; then
    [[ "$OS_ID" == "debian" || "$OS_ID" == "ubuntu" ]] && [[ -n "$OS_CODENAME" ]] \
      || die "Cannot pick the MariaDB repository for '$OS_ID'. Install MariaDB $MIN_MARIADB or later yourself (https://mariadb.org/download/), then run this script again."
    sudo curl -fsSL https://mariadb.org/mariadb_release_signing_key.pgp -o /etc/apt/keyrings/mariadb-keyring.pgp
    sudo tee /etc/apt/sources.list.d/mariadb.sources >/dev/null <<EOF
X-Repolib-Name: MariaDB
Types: deb
URIs: https://deb.mariadb.org/${MARIADB_SERIES}/${OS_ID}
Suites: ${OS_CODENAME}
Components: main
Signed-By: /etc/apt/keyrings/mariadb-keyring.pgp
EOF
    add_pkg mariadb-server
  fi

  sudo apt-get update
  sudo apt-get install -y "${APT_PKGS[@]}"

  say
  check_requirements
  [[ ${#APT_PKGS[@]} -eq 0 && $NEED_NODE -eq 0 && $NEED_MARIADB -eq 0 ]] \
    || die "Some requirements are still missing after the install. Check the apt output above."
}

check_requirements
if [[ ${#APT_PKGS[@]} -gt 0 || $NEED_NODE -eq 1 || $NEED_MARIADB -eq 1 ]]; then
  if [[ $INSTALL_PREREQS -eq 1 ]]; then
    install_prereqs
  else
    say
    say "Some requirements are missing. To install them automatically (Debian, Ubuntu, Raspberry Pi OS):"
    say "  bash $0 --install-prereqs"
    say "Otherwise install them yourself (SPEC.md section 5.1) and run this script again."
    exit 1
  fi
fi

# ------------------------------------------------------------------ the release

CREATED_APP=0
DONE=0
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
  if [[ $CREATED_APP -eq 1 && $DONE -eq 0 ]]; then
    rm -rf "$APP_PATH"
    warn "Install did not finish. $APP_PATH was removed so you can run the script again."
  fi
}
trap cleanup EXIT

say
say "Looking up the latest release"
RESPONSE="$(curl -fsSL "$GIT_API/$APP_OWNER/$APP_NAME/releases/latest")" \
  || die "Could not reach GitHub, or no release exists yet. Check your connection (the API also rate-limits anonymous use)."
DOWNLOAD_URL="$(printf '%s' "$RESPONSE" | sed -n 's/.*"tarball_url": *"\([^"]*\)".*/\1/p' | head -n 1)"
TAG_NAME="$(printf '%s' "$RESPONSE" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
[[ -n "$DOWNLOAD_URL" && -n "$TAG_NAME" ]] || die "Could not read the release information from GitHub."

say "Downloading $APP_NAME $TAG_NAME"
curl -fL "$DOWNLOAD_URL" -o "$TMP_DIR/release.tar.gz"
mkdir "$TMP_DIR/src"
tar -zxf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR/src" --strip-components=1

mkdir -p "$SRC_PATH"
CREATED_APP=1
mv "$TMP_DIR/src" "$APP_PATH"
echo "Version: $TAG_NAME" > "$APP_PATH/version"

say "Installing Node dependencies"
cd "$APP_PATH"
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ------------------------------------------------------------- .env and folders

set_env() {
  local key="$1" value="$2" file="$APP_PATH/.env" escaped
  if grep -q "^$key=" "$file"; then
    escaped="$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')"
    sed -i.bak "s|^$key=.*|$key=$escaped|" "$file" && rm -f "$file.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

[[ -f "$APP_PATH/.env.example" ]] || die ".env.example is missing from the release."
cp "$APP_PATH/.env.example" "$APP_PATH/.env"
chmod 600 "$APP_PATH/.env"
set_env DB_PASSWORD "$(openssl rand -hex 24)"
set_env SESSION_SECRET "$(openssl rand -hex 32)"
set_env DATA_DIR "$DATA_DIR"
set_env DOCS_DIR "$DATA_DIR/docs"
set_env STAGING_DIR "$DATA_DIR/staging"
say "Wrote $APP_PATH/.env with a generated database password and session secret"

if ! mkdir -p "$DATA_DIR/docs" "$DATA_DIR/staging" 2>/dev/null; then
  say "Creating $DATA_DIR (uses sudo)"
  sudo mkdir -p "$DATA_DIR/docs" "$DATA_DIR/staging"
  sudo chown -R "$(id -un):$(id -gn)" "$DATA_DIR"
fi

DONE=1

# ------------------------------------------------------------------- next steps

say
say "$APP_NAME $TAG_NAME is installed in $APP_PATH"
say

DB_DONE=0
if ask "Create the MariaDB database and user now? (runs scripts/setup-db.sh with sudo)"; then
  sudo "$APP_PATH/scripts/setup-db.sh"
  DB_DONE=1
fi

say
say "Next:"
say "  cd $APP_PATH"
if [[ $DB_DONE -eq 0 ]]; then
  say "  sudo scripts/setup-db.sh     # create the database and user"
fi
say "  make env-check"
say "  make migrate                 # create the tables"
say "  make admin                   # create the admin login"
say "  ./mdpedia start              # then open http://<this host>:3000/admin"
say
say "Optional: add your AI provider key (AI_API_KEY, AI_MODEL) to $APP_PATH/.env"
