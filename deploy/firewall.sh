#!/usr/bin/env bash
# Firewall rules for MDpedia with ufw:
# allow SSH and the wiki's PORT from the LAN only, deny everything else inbound.
#
# By default it only PRINTS the commands, so you can read them first.
#   bash deploy/firewall.sh 192.168.1.0/24            show the steps
#   bash deploy/firewall.sh 192.168.1.0/24 --apply    run them (with sudo)
#
# The argument is your LAN in CIDR form (`ip -4 addr` shows it). PORT is read from
# .env, so the rule always matches the app; run this again after changing PORT,
# and remove the old rule (`sudo ufw status numbered`, then `sudo ufw delete N`).
# Also: no port-forward to the Pi on the router, and UPnP off.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
LAN="${1:-}"
MODE="${2:-print}"

if [ -z "$LAN" ] || ! printf '%s' "$LAN" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$'; then
  echo "usage: bash deploy/firewall.sh <LAN in CIDR form, e.g. 192.168.1.0/24> [--apply]" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE not found: PORT is read from it." >&2
  exit 1
fi

# Only PORT is read, not the whole file.
PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]"'"'")"
PORT="${PORT:-3000}"
case "$PORT" in '' | *[!0-9]*) echo "PORT in $ENV_FILE is not a number: $PORT" >&2; exit 1 ;; esac

commands=(
  "ufw default deny incoming"
  "ufw default allow outgoing"
  "ufw allow from $LAN to any port 22 proto tcp comment 'ssh from the LAN'"
  "ufw allow from $LAN to any port $PORT proto tcp comment 'MDpedia'"
  "ufw enable"
  "ufw status verbose"
)

echo "LAN $LAN, wiki port $PORT (from $ENV_FILE). Outbound stays open: the AI provider is reached over the internet."
for c in "${commands[@]}"; do
  if [ "$MODE" = "--apply" ]; then
    echo "+ sudo $c"
    # shellcheck disable=SC2086
    eval "sudo $c" || exit 1
  else
    echo "  sudo $c"
  fi
done
[ "$MODE" = "--apply" ] || echo "Nothing was changed. Add --apply to run these."
