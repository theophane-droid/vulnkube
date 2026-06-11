# Déploiement avec ansible


## Installation de ansible et du rôle

```
pipx install ansible
ansible-galaxy collection install git+https://github.com/k3s-io/k3s-ansible.git
```

## Edition de l'inventaire Kubernetes

L'inventaire est prévu pour un déploiement de k3s en local et en single-node,
 à ajuster en fonction du déploiement souhaité.

## Installation de k3s

```
ansible-playbook k3s.orchestration.site -i inventory.yml -K
```


