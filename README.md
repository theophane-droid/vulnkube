# VulnKube AirOps

Ce depot contient un lab Kubernetes local pour entrainer une blue-team a investiguer des attaques web dans un environnement kube.

Le lab deploie une application de controle de vols aeriens nommee AirOps avec :

- PostgreSQL
- Redis
- API GraphQL
- Frontend
- Caddy en reverse proxy
- MinIO comme bucket S3 compatible

Le chart Helm contient volontairement des vulnerabilites applicatives pour generer des traces d'investigation blue-team. Les scenarios sont documentes dans [docs/scenarios-blue-team.md](docs/scenarios-blue-team.md).

## Cluster local

Depuis un terminal local avec acces `sudo` :

```bash
chmod +x scripts/install-local-k3s.sh scripts/uninstall-local-k3s.sh
./scripts/install-local-k3s.sh
```

Le script installe les paquets Arch necessaires sans lancer de full upgrade, installe k3s comme service systemd, copie `/etc/rancher/k3s/k3s.yaml` vers `~/.kube/config`, puis attend que le noeud `local-k3s` soit `Ready`.

Si tu veux eviter toute installation Pacman, verifie toi-meme que `curl`, `iptables-nft`, `iproute2`, `conntrack-tools` et `socat` sont presents, puis lance :

```bash
INSTALL_SYSTEM_DEPS=0 ./scripts/install-local-k3s.sh
```

## Installation Helm du lab

Pre-requis :

- `helm`
- `kubectl`
- `docker`, `podman` ou `nerdctl` pour builder les images locales

Si `helm` n'est pas installe et que tu veux eviter Pacman :

```bash
./scripts/install-helm-local.sh
export PATH="$HOME/.local/bin:$PATH"
```

Build et import des images dans k3s :

```bash
./scripts/build-local-images.sh
```

Deploiement :

```bash
./scripts/deploy-airops.sh
```

Acces par defaut :

```bash
kubectl -n airops get pods
open http://127.0.0.1:30080
```

Ingress Traefik :

```bash
open http://localhost
open http://airops.localtest.me
```

Si `http://localhost` redirige vers HTTPS ou n'affiche pas l'interface, ta machine resout probablement `localhost` en IPv6 (`::1`) avant `127.0.0.1`. Pour ce lab local, tu peux forcer `localhost` cote IPv4 :

```bash
sudo ./scripts/fix-localhost-ipv4.sh
```

Le NodePort direct reste disponible sur `http://127.0.0.1:30080`.

## Utilisation Kubernetes

```bash
export KUBECONFIG="$HOME/.kube/config"
kubectl get nodes
k9s
```

## Desinstallation du lab

```bash
./scripts/uninstall-airops.sh
```

## Desinstallation k3s

```bash
./scripts/uninstall-local-k3s.sh
```
