#!/usr/bin/env bash
set -euo pipefail

RELEASE="${RELEASE:-airops}"
NAMESPACE="${NAMESPACE:-airops}"

helm uninstall "$RELEASE" --namespace "$NAMESPACE"
