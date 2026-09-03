# Déployer le serveur

Un conteneur Docker derrière un Caddy déjà en place. Les instructions
supposent un VPS où un autre compose tient les ports 80 et 443 avec Caddy,
sur le réseau Docker `deploiement_default` ; adaptez les deux noms dans
`docker-compose.yml` sinon.

## Une fois : préparer le VPS

1. **Le DNS.** Un enregistrement `A rdv.exemple.re → IP du VPS` chez le
   registraire. Caddy obtient le certificat tout seul dès que le nom résout.

2. **Le Caddy existant importe un dossier de sites.** Dans son Caddyfile,
   sous le bloc d'options globales :

   ```
   import /etc/caddy-sites/*.caddy
   ```

   et dans son compose, un volume de plus sur le service Caddy :

   ```yaml
   - /srv/caddy-sites:/etc/caddy-sites:ro
   ```

   Un motif qui ne correspond à aucun fichier n'est pas une erreur pour
   Caddy : le dossier peut rester vide jusqu'au premier déploiement.

3. **Les dossiers et les secrets.**

   ```bash
   sudo install -d -o $USER /srv/rdv /srv/caddy-sites
   sudo install -d -o 1000 -g 1000 /srv/rdv/donnees   # l'utilisateur node du conteneur
   cp env.exemple /srv/rdv/.env && chmod 600 /srv/rdv/.env
   cp reglages.exemple.json /srv/rdv/donnees/reglages.json
   ```

   Remplissez `/srv/rdv/.env` : adresse publique, origines du site, nom et
   e-mail du propriétaire, identifiants Google, SMTP, clé d'administration
   (`openssl rand -base64 32`). Ajustez `reglages.json` : fuseau, horaires,
   durée, marges, préavis, exceptions. Le serveur relit ce fichier toutes
   les heures ; un fichier invalide est ignoré et signalé dans le journal.

4. **Google Cloud.** Un projet, l'API Google Calendar activée, un écran de
   consentement de type externe passé en statut **In production** (en
   Testing, le jeton expire au bout de 7 jours), un client OAuth
   « application Web » avec pour URI de redirection
   `https://rdv.exemple.re/google/retour`. Reportez l'identifiant et le
   secret dans `.env`, et mettez dans `GOOGLE_CALENDRIER` l'adresse du
   compte Google lui-même : l'alias « primary » n'est pas accepté par
   l'appel freebusy avec les accès restreints que le module demande.

## Déployer, et redéployer

Depuis ce dépôt, sur le poste de travail :

```bash
bash serveur/deploiement/deployer.sh utilisateur@vps
```

Le script copie `rdv/` dans `/srv/rdv/app`, construit l'image, relance le
conteneur, dépose `rdv.caddy` dans `/srv/caddy-sites/`, recharge Caddy et
interroge `/sante`. Il est idempotent.

## Une fois : autoriser Google

Ouvrez, avec la clé de `.env` :

```
https://rdv.exemple.re/google/connexion?cle=<CLE_ADMIN>
```

Google demande l'autorisation, une fois, pour le compte dont l'agenda fait
foi. L'avertissement « application non vérifiée » est normal : continuez.
Ensuite `/sante` répond `"google": "autorise"`.

## Vérifier

- `https://rdv.exemple.re/sante` → `{"ok":true,"google":"autorise","smtp":true}`
- `https://rdv.exemple.re/` → la page de réservation.
- `docker logs rdv` → le journal du serveur ; la table `journal` de la base
  garde le détail par réservation.

## Sauvegarder

Tout est dans `/srv/rdv/donnees` : la base `rdv.sqlite` (avec ses fichiers
`-wal` et `-shm`) et `reglages.json`. Une copie de ce dossier suffit ; pour
une copie cohérente pendant que le serveur tourne :

```bash
docker exec rdv node -e "new (require('node:sqlite').DatabaseSync)('/donnees/rdv.sqlite').exec(\"VACUUM INTO '/donnees/sauvegarde.sqlite'\")"
```

## Réglages

`reglages.json`, toutes les clés facultatives :

| Clé | Défaut | Rôle |
|---|---|---|
| `fuseau` | `Indian/Reunion` | Le fuseau dans lequel les horaires sont écrits. |
| `duree` | 30 | Durée d'un rendez-vous, minutes. |
| `pas` | 30 | Écart entre deux créneaux proposés. |
| `margeAvant`, `margeApres` | 15 | Temps libre exigé avant et après un rendez-vous. |
| `preavisMinutes` | 1440 | Délai minimal entre maintenant et un créneau. |
| `horizonJours` | 30 | Jusqu'où on peut réserver. |
| `maxParJour` | 4 | Plafond de rendez-vous par jour ; 0 pour aucun. |
| `confirmationAutomatique` | `true` | `false` : la réservation attend, l'événement Google n'est pas créé (validation manuelle à venir). |
| `rappelsMinutes` | `[1440, 60]` | Rappels au visiteur, minutes avant. |
| `conservationJours` | 365 | Purge des réservations passées. |
| `titre` | « Premier échange » | Nom du rendez-vous, dans l'agenda et les mails. |
| `horaires` | lun.–ven. 9–12, 14–17 | `[{ jours: [1..5], debut: "09:00", fin: "12:00" }]`, 0 = dimanche. |
| `exceptions` | `[]` | `[{ date: "2026-12-25", plages: [] }]` ferme ; `plages: [{ debut, fin }]` remplace la journée. |
