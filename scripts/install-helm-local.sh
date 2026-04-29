#!/usr/bin/env bash
set -euo pipefail

HELM_VERSION="${HELM_VERSION:-v3.17.3}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$BIN_DIR"

tmpdir="$(mktemp -d)"
curl -sfL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" -o "$tmpdir/helm.tar.gz"
tar -xzf "$tmpdir/helm.tar.gz" -C "$tmpdir"
install -m 0755 "$tmpdir/linux-amd64/helm" "$BIN_DIR/helm"
rm -rf "$tmpdir"

if ! command -v helm >/dev/null 2>&1; then
  echo "$BIN_DIR n'est pas dans le PATH. Ajoute ceci a ton shell:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
else
  helm version --short
fi
