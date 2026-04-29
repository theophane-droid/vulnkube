#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="${RELEASE:-airops}"
NAMESPACE="${NAMESPACE:-airops}"

if ! command -v helm >/dev/null 2>&1; then
  echo "Helm est requis. Installe helm puis relance ce script." >&2
  exit 1
fi

helm upgrade --install "$RELEASE" "$ROOT_DIR/charts/airops" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$ROOT_DIR/charts/airops/values-local.yaml"

kubectl -n "$NAMESPACE" rollout restart deploy/"$RELEASE"-airops-api deploy/"$RELEASE"-airops-frontend deploy/"$RELEASE"-airops-caddy

kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-airops-api --timeout=180s
kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-airops-frontend --timeout=120s
kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-airops-caddy --timeout=120s

kubectl -n "$NAMESPACE" get pods -o wide
