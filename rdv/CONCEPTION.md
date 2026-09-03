# Rendez-vous — conception

Module de prise de rendez-vous pour un indépendant : un seul agenda, un seul
propriétaire, des visiteurs qui réservent sans compte. Conçu en lisant
l'architecture de Cal.com (dépôt open source, licence AGPL : on s'en inspire,
on n'en copie rien) pour reprendre ce qui marche et éviter ce qui a produit
leurs bugs les plus persistants.

Document de conception, rédigé avant la première ligne de code et mis à jour
après. Les choix marqués **à confirmer** ont tous été validés le 3 septembre
2026 avec les valeurs proposées, confirmation automatique comprise.

## 1. Ce que fait le module, et ce qu'il ne fait pas

Fait :

- Affiche les créneaux libres du propriétaire sur les prochaines semaines,
  dans le fuseau horaire du visiteur.
- Enregistre une réservation : créneau, format (visio ou téléphone), nom,
  e-mail, téléphone, message.
- Crée l'événement dans le Google Calendar du propriétaire, avec un lien
  Google Meet si le format est visio.
- Envoie la confirmation au visiteur et au propriétaire, avec un fichier
  `.ics`, puis des rappels avant l'heure.
- Permet d'annuler ou de déplacer le rendez-vous depuis un lien reçu par
  mail, sans compte.

Ne fait pas, volontairement : plusieurs organisateurs, rendez-vous
récurrents, places multiples sur un même créneau, paiement, interface
d'administration. C'est là que Cal.com accumule ses tickets ouverts, et un
indépendant n'en a pas besoin. Les réglages se font dans un fichier.

## 2. Forme générale

```
rdv/
  README.md          la brique : balisage, variables CSS, le point à ne pas défaire
  CONCEPTION.md      ce document
  demo.html          calendrier fonctionnel avec créneaux factices, sans serveur
  rdv.css  rdv.js    la partie à copier dans un site
  serveur/           le service : API, créneaux, Google, mails, déploiement
```

Deux moitiés, séparées par une API HTTP :

- **La brique** (`rdv.css`, `rdv.js`) est un composant HTML natif au sens du
  dépôt : deux fichiers copiés dans le site, réglés par variables CSS, sans
  dépendance. Elle appelle l'API pour lister les créneaux et poser une
  réservation. Sans JavaScript, elle affiche un lien vers la page de
  réservation servie par le serveur : jamais un trou dans la page.
- **Le serveur** (`serveur/`) est un service Node 24 : un processus, une base
  SQLite, un conteneur Docker. Il sert aussi une page de réservation complète
  et autonome, utilisée pour le développement, pour la démo et comme
  solution de repli.

Sur synaps.re : le serveur répond sur `rdv.synaps.re`, la brique est posée
dans une page du site et appelle cette adresse. Tant que la brique n'est pas
validée, rien n'entre dans le dépôt du site.

## 3. Choix techniques

| Sujet | Choix | Pourquoi |
|---|---|---|
| Langage | JavaScript, Node 24 | Celui du site et de la brique ; une seule langue à maintenir. |
| Framework HTTP | Aucun, `node:http` | Une dizaine de routes ; un routeur maison de 40 lignes suffit et ne casse pas dans six mois. |
| Base | SQLite via `node:sqlite` | Intégré à Node 24 (release candidate), rien à compiler, un fichier à sauvegarder. Un seul processus écrit : c'est exactement le cas où SQLite excelle. |
| Google | API REST appelée avec `fetch` | Le SDK `googleapis` pèse 100 Mo pour trois appels : `freebusy`, `events.insert`, `events.patch`. |
| Mails | `nodemailer` en SMTP | **La seule dépendance npm.** Node ne parle pas SMTP nativement et un client maison serait le genre de code qui casse en silence. |
| Dates | Timestamps UTC + `Intl.DateTimeFormat` | Pas de bibliothèque de dates. Le fuseau n'intervient qu'aux deux extrémités : lire les horaires du propriétaire, afficher au visiteur. |
| Déploiement | Docker Compose, un service, un volume | Rejoint le réseau Docker du Caddy déjà en place sur le VPS. |

## 4. Modèle de données

Quatre tables SQLite, et un fichier. Les dates sont des entiers,
millisecondes UTC, sauf mention.

**`reglages.json`**, dans le dossier des données, pas en base : fuseau du
propriétaire, horaires hebdomadaires, exceptions datées, durée, marges,
préavis, horizon, rappels. Un fichier que le propriétaire édite à la main,
relu toutes les heures ; un fichier invalide est ignoré et signalé. Les
exceptions y sont des dates locales en texte (`2026-12-25`), **jamais des
datetimes UTC** : c'est la source des tickets Cal.com « l'exception
s'affiche la veille ».

**`reservations`** :

| Colonne | Rôle |
|---|---|
| `uid` | Identifiant opaque, 22 caractères aléatoires. Porte les liens annuler / déplacer. |
| `debut`, `fin` | UTC. |
| `statut` | `confirmee`, `en_attente`, `annulee`. |
| `format` | `visio` ou `telephone`. |
| `nom`, `email`, `telephone`, `message` | Le visiteur. |
| `fuseau` | Fuseau du visiteur, pour formater ses mails. |
| `ical_uid`, `ical_sequence` | Identité stable de l'événement dans les `.ics` ; la séquence monte à chaque déplacement ou annulation. |
| `google_event_id`, `lien_visio` | Ce que Google a renvoyé. |
| `remplace` | `uid` de la réservation précédente en cas de déplacement. |
| `motif_annulation`, `annulee_le` | |
| `creee_le`, `ip_hachee` | Anti-abus et purge. |

Un index unique partiel sur `debut` restreint aux statuts actifs : deux
réservations vivantes ne peuvent pas commencer au même instant, quoi qu'il
arrive au-dessus. Cal.com n'a pas cette contrainte, et en paie le prix
(ticket #23974, double réservation toujours ouvert).

**`rappels`** : `reservation_uid`, `type`, `envoyer_a`, `envoye_le`. Une
boucle toutes les minutes envoie ce qui est dû. L'annulation supprime les
rappels en attente.

**`jetons_google`** : le jeton de rafraîchissement et l'accès courant avec
son expiration. Une ligne.

**`journal`** : ce qui s'est passé, pour comprendre après coup. Date, niveau,
message, `reservation_uid` facultatif. Purgé avec les réservations.

## 5. Calcul des créneaux

C'est le cœur, et c'est là que Cal.com a le plus corrigé. L'ordre des
opérations est celui-ci, et il ne change pas :

1. **Borner la fenêtre.** Début : maintenant plus le préavis minimal. Fin :
   maintenant plus l'horizon, en jours glissants.
2. **Construire les plages du propriétaire**, jour par jour, dans son fuseau.
   Pour chaque jour local de la fenêtre : si une exception existe pour cette
   date, elle remplace le jour ; sinon, les règles hebdomadaires du jour.
   Chaque plage devient un intervalle UTC. Le passage du jour local à
   l'instant UTC se fait par `Intl`, à partir de minuit local, jamais par
   addition de 24 heures : c'est ce qui casse aux changements d'heure.
3. **Collecter les occupations**, en UTC : les réservations `confirmee` et
   `en_attente` de la base, plus les périodes occupées renvoyées par Google
   (`freebusy`, par tranches de 90 jours au plus, limite de l'API). Chaque
   occupation est élargie des marges : avant et après, celles du réglage.
   Cal.com additionne les marges de l'événement existant et celles du
   nouveau ; avec un seul type de rendez-vous, une marge fixe des deux côtés
   revient au même et se lit mieux.
4. **Découper en candidats.** Dans chaque plage, un candidat tous les `pas`
   minutes à partir du **début de la plage**, pas de l'heure ronde
   suivante : Cal.com aligne sur l'heure pleine et une disponibilité à
   9 h 30 y perd son premier créneau (ticket #16302).
5. **Retenir** les candidats qu'aucune occupation élargie ne touche. C'est
   ce qui garde des heures rondes même quand une occupation Google se
   termine à 10 h 07 : on ne « recolle » pas au bout de l'occupation.
6. **Appliquer le plafond quotidien** : au-delà de N réservations sur une
   journée locale du propriétaire, la journée disparaît.
7. **Renvoyer les instants UTC.** Le regroupement par jour et le formatage
   se font chez le visiteur, dans son fuseau, avec `Intl`. Le serveur ne
   connaît jamais le fuseau du visiteur pour lister ; il le reçoit seulement
   à la réservation, pour les mails.

Les résultats de `freebusy` sont gardés 60 secondes en mémoire. La
réservation, elle, n'utilise jamais ce cache.

Tests écrits avant le code, sur des cas fixes : un propriétaire à
`Indian/Reunion` (sans heure d'été) et un autre à `Europe/Paris` autour des
deux bascules de mars et d'octobre ; une exception qui ferme un jour ; une
disponibilité commençant à 9 h 30 ; une occupation Google à cheval sur deux
plages ; une marge qui mange le dernier créneau du matin.

## 6. Réserver sans double réservation

Cal.com empile trois mécanismes dont aucun n'est un verrou, et garde un
ticket de double réservation ouvert. Avec un seul processus et SQLite, on
fait plus simple et plus sûr :

1. Le serveur reçoit la demande, valide les champs, et vérifie que
   l'instant demandé est bien un créneau qu'il aurait proposé maintenant
   (mêmes règles qu'au §5, sans cache).
2. Il interroge Google **en direct** sur ce seul intervalle.
3. `BEGIN IMMEDIATE` : la base est verrouillée en écriture. Vérification du
   chevauchement avec les réservations actives, insertion, `COMMIT`. Deux
   demandes simultanées sur le même créneau : la seconde attend, revérifie,
   et reçoit « ce créneau vient d'être pris, en voici d'autres ».
4. Seulement après : création chez Google, mails, rappels. Si Google échoue
   à cette étape, la réservation reste en base avec le champ
   `google_event_id` vide, un message dans le journal, et une nouvelle
   tentative une minute plus tard par la boucle des rappels. Le visiteur a
   son mail dans tous les cas.

Pas de réservation temporaire du créneau pendant que le visiteur remplit le
formulaire. Cal.com en a une, et c'est précisément le maillon qui a lâché
dans le ticket #23974. Pour un agenda d'indépendant, la collision pendant la
minute de saisie est rare, et le message de l'étape 3 la traite proprement.

Si Google ne répond pas à l'étape 2, la réservation est refusée avec un
message clair. Cal.com choisit l'inverse, laisser passer, et récolte des
doubles réservations. **À confirmer** : refuser me paraît le bon choix pour
une personne seule, mais c'est un choix.

## 7. Cycle de vie

- **Confirmation** : par défaut immédiate, statut `confirmee`. Un réglage
  permet `en_attente` avec validation par le propriétaire depuis son mail ;
  l'événement Google n'est créé qu'à la validation. **À confirmer** :
  confirmation automatique ou manuelle.
- **Mails** : le module envoie les siens, avec le `.ics` en pièce jointe,
  et demande à Google de ne pas envoyer d'invitation (`sendUpdates: none`)
  pour éviter le doublon. Le visiteur reçoit un mail à son nom ; le
  propriétaire reçoit une notification avec les mêmes liens. Expéditeur :
  la boîte du propriétaire, en SMTP authentifié.
- **`.ics`** : même `UID` pour la demande et l'annulation, `SEQUENCE`
  incrémentée, dates en UTC, `METHOD:REQUEST` puis `METHOD:CANCEL`. Le
  détail qui fait que Google et Outlook mettent à jour l'événement au lieu
  d'en créer un second.
- **Annulation** : page `/r/{uid}` depuis le lien du mail. Refusée si déjà
  annulée ou passée. Passe en `annulee`, supprime l'événement Google,
  supprime les rappels, envoie les deux mails d'annulation.
- **Déplacement** : même page, choix d'un nouveau créneau. Nouvelle ligne
  liée à l'ancienne par `remplace`, ancienne passée en `annulee`, même
  `ical_uid`, séquence +1, événement Google modifié en place (même
  identifiant, mêmes invités, même lien Meet).
- **Rappels** : e-mail 24 h avant et 1 h avant, au visiteur. **À
  confirmer** : lesquels, et si le propriétaire en veut aussi.
- **Limite connue** : une annulation faite directement dans Google Calendar
  n'est pas vue par le module. Le propriétaire annule depuis le lien de son
  mail de notification. Une synchronisation dans l'autre sens est possible
  plus tard, ce n'est pas du premier lot.

## 8. Google

- **Autorisation** : OAuth 2.0, compte du propriétaire seulement. Le module
  expose `/google/connexion` qui redirige vers Google, et `/google/retour`
  qui reçoit le code et stocke le jeton de rafraîchissement. À faire une
  fois. Le visiteur ne voit jamais Google.
- **Prérequis côté Google Cloud** : un projet, l'API Calendar activée, un
  client OAuth « application Web » dont l'URI de redirection est
  `https://rdv.synaps.re/google/retour`, et l'écran de consentement en
  statut **In production**. En statut Testing, Google fait expirer le jeton
  au bout de 7 jours (documentation OAuth, section « Refresh token
  expiration »). L'avertissement « application non vérifiée » s'affiche une
  fois, au propriétaire, à l'autorisation.
- **Appels** : `freebusy.query` pour les occupations ; `events.insert` avec
  `conferenceData.createRequest` pour obtenir un lien Meet quand le format
  est visio, et le visiteur en invité ; `events.patch` pour déplacer ;
  `events.delete` pour annuler. Le calendrier scruté et le calendrier de
  destination sont le même, le principal.
- **Ce qui ne bloque pas** : un événement marqué « disponible » dans Google
  n'apparaît pas dans `freebusy`, ni les journées entières marquées libres.
  À dire au propriétaire, c'est le comportement de Google, pas un bug.

## 9. La brique côté site

Balisage minimal :

```html
<link rel="stylesheet" href="rdv.css" />
<div class="rdv" data-rdv="https://rdv.synaps.re">
  <a class="rdv__repli" href="https://rdv.synaps.re/">Prendre rendez-vous</a>
</div>
<script src="rdv.js"></script>
```

Le script remplace le lien de repli par le calendrier : une grille de
jours, les créneaux du jour choisi dans le fuseau du navigateur (indiqué en
clair, avec possibilité d'en changer), puis le formulaire. La brique a ses
propres classes (`rdv__champ`, `rdv__entree`, `rdv__option`…), pot de miel
et statut `aria-live` compris : elle ne dépend d'aucune feuille de style du
site, c'est la règle du dépôt.

Variables CSS : couleurs d'accent et de fond, rayon, police, densité. Le
JavaScript ne se modifie pas, conformément à la règle du dépôt.

Le point à ne pas défaire, pour le README : **les créneaux arrivent en UTC
et sont regroupés par jour côté navigateur.** Regrouper côté serveur
oblige à connaître le fuseau du visiteur avant de lister, et fait apparaître
les créneaux de fin de soirée sur le mauvais jour dès que le visiteur n'est
pas dans le fuseau du propriétaire. C'est le ticket #15843 de Cal.com.

## 10. Serveur et déploiement

Routes :

| Méthode et chemin | Rôle |
|---|---|
| `GET /` | Page de réservation autonome. |
| `GET /api/creneaux?de=&a=` | Créneaux UTC entre deux dates, bornés à l'horizon. |
| `POST /api/reservations` | Réserver. |
| `GET /r/{uid}` | Page d'un rendez-vous : détails, annuler, déplacer. |
| `POST /api/reservations/{uid}/annulation` | Annuler. |
| `POST /api/reservations/{uid}/deplacement` | Déplacer. |
| `GET /google/connexion`, `GET /google/retour` | Autorisation, une fois. |
| `GET /sante` | Pour Caddy et la surveillance. |

Protection : pot de miel dans le formulaire (un robot reçoit un faux
succès), dix écritures par adresse IP et par heure, cent vingt lectures par
minute, taille des champs bornée, en-tête `Origin` vérifié sur les écritures
et CORS restreint au domaine du site.

Données personnelles : nom, e-mail, téléphone et message sont nécessaires au
rendez-vous ; l'adresse IP est hachée. Purge automatique des réservations
passées après une durée réglable, douze mois par défaut. La politique de
confidentialité du site devra le mentionner, dans le dépôt du site, au
moment de l'intégration.

Conteneur : image `node:24-alpine`, utilisateur non root, un volume pour la
base et les réglages, secrets dans un fichier d'environnement rempli par le
propriétaire : identifiants Google, SMTP, adresse d'expédition. Le dépôt ne
contient que `env.exemple` et `reglages.exemple.json`.

Routage : le Caddy du VPS appartient à un autre projet. Il reçoit une seule
modification, à faire une fois par un commit sur son dépôt : une ligne
`import` vers un dossier de sites hors de son arborescence, et le montage de
ce dossier. Le module y dépose son fichier de site, `rdv.caddy`, et demande
un rechargement. Vérifié dans la documentation Caddy : un `import` dont le
motif ne correspond à aucun fichier n'est pas une erreur.

## 11. Réglages à décider

Valeurs proposées, à confirmer avant de coder les tests :

| Réglage | Proposition |
|---|---|
| Durée du rendez-vous | 30 minutes, un seul type : « premier échange ». |
| Pas entre deux créneaux | 30 minutes. |
| Horaires | Lundi à vendredi, 9 h à 12 h et 14 h à 17 h, heure de La Réunion. |
| Marge avant et après | 15 minutes. |
| Préavis minimal | 24 heures. |
| Horizon | 30 jours glissants. |
| Plafond par jour | 4 rendez-vous. |
| Confirmation | Automatique. |
| Rappels | Visiteur : 24 h et 1 h avant. Propriétaire : aucun, Google le fait. |
| Conservation | 12 mois après le rendez-vous. |
| Google injoignable | Réservation refusée avec message. |

## 12. Ordre de réalisation

Une tranche fine de bout en bout d'abord, puis l'épaisseur :

1. Calcul des créneaux, pur, avec ses tests. Aucun réseau.
2. Base SQLite, réservation transactionnelle, tests de collision.
3. Serveur HTTP et page autonome : lister, réserver, sans Google ni mail.
   Vérifiable dans un navigateur.
4. Google : autorisation, `freebusy`, création d'événement. Vérifié sur
   l'agenda réel du propriétaire.
5. Mails et `.ics`, testés sur une boîte réelle, ouverture dans Gmail et
   Outlook.
6. Annulation, déplacement, rappels.
7. Conteneur, déploiement sur le VPS, sous-domaine, routage Caddy.
8. La brique `rdv.css` et `rdv.js`, sa démo, son README.
9. Intégration dans le site, hors de ce dépôt.
