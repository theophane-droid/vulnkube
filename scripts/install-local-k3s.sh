#!/usr/bin/env bash
set -euo pipefail

K3S_NODE_NAME="${K3S_NODE_NAME:-local-k3s}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$HOME/.kube/config}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
INSTALL_SYSTEM_DEPS="${INSTALL_SYSTEM_DEPS:-1}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Commande manquante: $1" >&2
    exit 1
  fi
}

sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_arch_packages() {
  if [ "$INSTALL_SYSTEM_DEPS" = "0" ]; then
    echo "Installation Pacman ignoree: INSTALL_SYSTEM_DEPS=0."
    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    sudo_cmd pacman -S --needed --noconfirm \
      curl \
      iptables-nft \
      iproute2 \
      conntrack-tools \
      socat
  else
    echo "Pacman introuvable. Installe kubectl, k9s, curl, iptables, iproute2, conntrack et socat avec ton gestionnaire de paquets." >&2
    exit 1
  fi
}

install_k9s_user_binary() {
  if command -v k9s >/dev/null 2>&1; then
    echo "k9s est deja installe."
    return
  fi

  mkdir -p "$BIN_DIR"

  local tmpdir
  tmpdir="$(mktemp -d)"
  curl -sfL https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_amd64.tar.gz \
    -o "$tmpdir/k9s.tar.gz"
  tar -xzf "$tmpdir/k9s.tar.gz" -C "$tmpdir" k9s
  install -m 0755 "$tmpdir/k9s" "$BIN_DIR/k9s"
  rm -rf "$tmpdir"

  if ! command -v k9s >/dev/null 2>&1; then
    echo "$BIN_DIR n'est pas dans le PATH. Ajoute ceci a ton shell:" >&2
    echo "  export PATH=\"$BIN_DIR:\$PATH\"" >&2
  fi
}

install_kubectl_user_shim() {
  if command -v kubectl >/dev/null 2>&1; then
    echo "kubectl est deja installe."
    return
  fi

  mkdir -p "$BIN_DIR"
  cat >"$BIN_DIR/kubectl" <<'EOF'
#!/usr/bin/env sh
exec k3s kubectl "$@"
EOF
  chmod 0755 "$BIN_DIR/kubectl"

  if ! command -v kubectl >/dev/null 2>&1; then
    echo "$BIN_DIR n'est pas dans le PATH. Ajoute ceci a ton shell:" >&2
    echo "  export PATH=\"$BIN_DIR:\$PATH\"" >&2
  fi
}

install_k3s() {
  if command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet k3s; then
    echo "k3s est deja installe et actif."
    return
  fi

  local installer
  installer="$(mktemp)"
  curl -sfL https://get.k3s.io -o "$installer"
  sudo_cmd env \
    INSTALL_K3S_EXEC="server --node-name ${K3S_NODE_NAME} --write-kubeconfig-mode 644" \
    sh "$installer"
  rm -f "$installer"
}

configure_kubeconfig() {
  mkdir -p "$(dirname "$KUBECONFIG_PATH")"
  sudo_cmd cp /etc/rancher/k3s/k3s.yaml "$KUBECONFIG_PATH"

  if [ "$(id -u)" -ne 0 ]; then
    sudo_cmd chown "$(id -u):$(id -g)" "$KUBECONFIG_PATH"
  fi

  chmod 600 "$KUBECONFIG_PATH"
}

wait_for_cluster() {
  export KUBECONFIG="$KUBECONFIG_PATH"

  echo "Attente du noeud k3s..."
  kubectl wait --for=condition=Ready "node/${K3S_NODE_NAME}" --timeout=180s

  echo
  kubectl get nodes -o wide
  echo
  kubectl get pods -A
}

main() {
  need_cmd sudo

  install_arch_packages
  need_cmd curl
  install_k3s
  install_kubectl_user_shim
  install_k9s_user_binary
  configure_kubeconfig
  wait_for_cluster

  cat <<EOF

Installation terminee.

Kubeconfig:
  export KUBECONFIG=${KUBECONFIG_PATH}

Commandes utiles:
  kubectl get nodes
  k9s
  sudo systemctl status k3s
EOF
}

main "$@"
