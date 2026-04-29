#!/usr/bin/env bash
set -euo pipefail

HOSTS_FILE="/etc/hosts"

if [ "$(id -u)" -ne 0 ]; then
  echo "Relance avec sudo: sudo $0" >&2
  exit 1
fi

cp "$HOSTS_FILE" "${HOSTS_FILE}.vulnkube.bak"

tmp="$(mktemp)"
awk '
  $1 == "::1" {
    keep = ""
    for (i = 2; i <= NF; i++) {
      if ($i != "localhost") keep = keep " " $i
    }
    if (keep != "") print $1 keep
    next
  }
  $1 == "127.0.0.1" {
    seen_v4 = 1
    has_localhost = 0
    for (i = 2; i <= NF; i++) if ($i == "localhost") has_localhost = 1
    if (has_localhost) print
    else print $0 " localhost"
    next
  }
  { print }
  END {
    if (!seen_v4) print "127.0.0.1 localhost"
  }
' "$HOSTS_FILE" > "$tmp"

cat "$tmp" > "$HOSTS_FILE"
rm -f "$tmp"

echo "OK: localhost pointe maintenant vers 127.0.0.1 avant IPv6 pour ce lab."
echo "Backup: ${HOSTS_FILE}.vulnkube.bak"
