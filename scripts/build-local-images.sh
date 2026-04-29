#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_IMAGE="${API_IMAGE:-vulnkube/airops-api:local}"
FRONTEND_IMAGE="${FRONTEND_IMAGE:-vulnkube/airops-frontend:local}"

find_builder() {
  if command -v docker >/dev/null 2>&1; then
    echo docker
  elif command -v podman >/dev/null 2>&1; then
    echo podman
  elif command -v nerdctl >/dev/null 2>&1; then
    echo nerdctl
  else
    echo "docker, podman ou nerdctl est requis pour builder les images." >&2
    exit 1
  fi
}

import_into_k3s() {
  local image="$1"
  local archive="$2"

  if command -v k3s >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      k3s ctr -n k8s.io images rm "$image" >/dev/null 2>&1 || true
      k3s ctr -n k8s.io images import "$archive"
    else
      sudo k3s ctr -n k8s.io images rm "$image" >/dev/null 2>&1 || true
      sudo k3s ctr -n k8s.io images import "$archive"
    fi
  else
    echo "k3s introuvable; image non importee dans containerd: $image"
  fi
}

main() {
  local builder
  builder="$(find_builder)"

  "$builder" build -t "$API_IMAGE" "$ROOT_DIR/apps/api"
  "$builder" build -t "$FRONTEND_IMAGE" "$ROOT_DIR/apps/frontend"

  local tmpdir
  tmpdir="$(mktemp -d)"
  "$builder" save "$API_IMAGE" -o "$tmpdir/api.tar"
  "$builder" save "$FRONTEND_IMAGE" -o "$tmpdir/frontend.tar"

  import_into_k3s "$API_IMAGE" "$tmpdir/api.tar"
  import_into_k3s "$FRONTEND_IMAGE" "$tmpdir/frontend.tar"

  rm -rf "$tmpdir"
}

main "$@"
