#!/usr/bin/env bash
set -euo pipefail

if [ -x /usr/local/bin/k3s-uninstall.sh ]; then
  sudo /usr/local/bin/k3s-uninstall.sh
else
  echo "k3s-uninstall.sh introuvable; k3s ne semble pas installe via l'installateur officiel."
fi
