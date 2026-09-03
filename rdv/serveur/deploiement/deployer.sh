#!/usr/bin/env bash
# Déploie le module sur le VPS depuis ce poste : copie le dossier rdv/, puis
# construit et relance le conteneur. Idempotent.
#
#   bash serveur/deploiement/deployer.sh phenomene@217.160.247.47
#
# Prérequis sur le VPS, une fois (voir serveur/deploiement/README.md) :
# /srv/rdv/.env rempli, /srv/rdv/donnees/reglages.json, et le Caddy de
# Phénomène qui importe /srv/caddy-sites/*.caddy.
set -euo pipefail

HOTE="${1:?usage : deployer.sh utilisateur@hote}"

# tar via ssh plutôt que rsync : rien à installer d'aucun côté, et pas de
# chemin Windows à faire avaler à rsync. Le nouveau dossier remplace l'ancien
# d'un coup, une fois entièrement copié.
cd "$(dirname "$0")/../.."
ssh "$HOTE" 'rm -rf /srv/rdv/app.nouveau && mkdir -p /srv/rdv/app.nouveau'
tar -cz --exclude node_modules --exclude donnees --exclude '.env' --exclude '.claude' . \
  | ssh "$HOTE" 'tar -xz -C /srv/rdv/app.nouveau && rm -rf /srv/rdv/app.ancien && { [ -d /srv/rdv/app ] && mv /srv/rdv/app /srv/rdv/app.ancien || true; } && mv /srv/rdv/app.nouveau /srv/rdv/app'

ssh "$HOTE" bash -s <<'DISTANT'
set -euo pipefail
cd /srv/rdv/app
sudo install -d -o 1000 -g 1000 /srv/rdv/donnees
# Jamais --remove-orphans ni `down` ici : voir l'avertissement dans docker-compose.yml.
docker compose -f serveur/deploiement/docker-compose.yml --env-file /srv/rdv/.env up -d --build
sudo install -m 644 serveur/deploiement/rdv.caddy /srv/caddy-sites/rdv.caddy
docker exec deploiement-caddy-1 caddy reload --config /etc/caddy/Caddyfile
sleep 2
docker exec rdv wget -qO- http://127.0.0.1:3000/sante && echo
DISTANT
