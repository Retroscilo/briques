# Rendez-vous

Un calendrier de prise de rendez-vous pour un indépendant : le visiteur
choisit un jour, une heure, laisse son nom, et reçoit une confirmation avec
un lien pour annuler ou déplacer. L'agenda Google du propriétaire fait foi
et reçoit l'événement, avec un lien Google Meet si c'est une visio.

Deux moitiés :

- **La brique**, `rdv.css` et `rdv.js` : deux fichiers à copier dans le
  site, réglés par variables CSS, sans dépendance. Sans JavaScript, un lien
  de repli reste affiché.
- **Le serveur**, dans `serveur/` : un service Node 24 avec une base SQLite,
  qui calcule les créneaux, parle à Google Calendar, envoie les mails.
  Déployé en Docker. Voir [`serveur/deploiement/README.md`](serveur/deploiement/README.md).

Le pourquoi de chaque choix est dans [`CONCEPTION.md`](CONCEPTION.md).

## Emploi

Copiez les deux fichiers, liez-les, et écrivez ce balisage. L'attribut
`data-rdv` porte l'adresse du serveur, sans barre finale :

```html
<link rel="stylesheet" href="rdv.css" />

<div class="rdv" data-rdv="https://rdv.exemple.re">
  <a class="rdv__repli" href="https://rdv.exemple.re/">Prendre rendez-vous</a>
</div>

<script src="rdv.js"></script>
```

C'est tout. L'initialisation est automatique au chargement. Le serveur doit
lister le site dans `SITE_ORIGINES`, sinon il refuse la réservation.

Pour la page « déplacer » d'un rendez-vous existant, ajoutez
`data-rdv-deplacer="<uid>"` : le calendrier propose les créneaux, sans
formulaire, et déplace le rendez-vous au clic. Le serveur s'en sert dans sa
propre page `/r/<uid>`.

### Ce que fait chaque classe

| Classe | Rôle |
|---|---|
| `.rdv` | Le conteneur. Porte les variables. Vidé et rempli par le script. |
| `.rdv__repli` | Le lien affiché sans JavaScript. |
| `.rdv__calendrier`, `.rdv__grille`, `.rdv__case` | Le mois, ses jours. `--dispo` sur un jour qui a des créneaux, `--choisi` sur le jour affiché. |
| `.rdv__creneaux`, `.rdv__heure` | Les heures du jour choisi. |
| `.rdv__formulaire`, `.rdv__champ`, `.rdv__entree`, `.rdv__option` | Le formulaire : format, nom, e-mail, téléphone, message. |
| `.rdv__succes` | La confirmation, avec le lien de gestion. |
| `.rdv__statut` | Les messages, en `aria-live`. `--erreur` quand c'en est une. |

## Réglages

Toutes les variables se posent sur `.rdv`, sur `:root`, ou sur une classe
modificatrice. La police est héritée de la page.

| Variable | Défaut | Effet |
|---|---|---|
| `--rdv-accent` | `#C34111` | Jour choisi, bouton d'envoi, liens, contours au survol. |
| `--rdv-accent-texte` | `#fff` | Le texte sur l'accent. |
| `--rdv-texte` | `#14110F` | Le texte. |
| `--rdv-texte-doux` | `rgba(20, 17, 15, 0.62)` | Les jours sans créneau, les notes. |
| `--rdv-fond` | `transparent` | Le fond du conteneur. |
| `--rdv-fond-case` | `rgba(20, 17, 15, 0.04)` | Le fond des jours disponibles. |
| `--rdv-trait` | `rgba(20, 17, 15, 0.16)` | Les contours. |
| `--rdv-rayon` | `6px` | Les arrondis. |
| `--rdv-erreur` | `#B3261E` | Les messages d'erreur. |
| `--rdv-largeur-calendrier` | `320px` | La colonne du mois ; en dessous de 640 px tout passe en une colonne. |

```css
.rdv--sombre {
  --rdv-texte: #F4F1E9;
  --rdv-texte-doux: rgba(244, 241, 233, 0.6);
  --rdv-trait: rgba(244, 241, 233, 0.2);
  --rdv-fond-case: rgba(244, 241, 233, 0.06);
}
```

### Événements

Le conteneur émet `rdv:reserve` après une réservation et `rdv:deplace` après
un déplacement, avec la réponse du serveur dans `detail` (`uid`, `url`,
`debut`, `fin`, `lienVisio`). Pratique pour une mesure d'audience.

### API

```js
Rdv.init(element);     // un conteneur ajouté après le chargement
Rdv.initTout(racine);  // tous les [data-rdv] sous `racine`
```

Un conteneur déjà initialisé est ignoré : les deux appels sont sans danger.

## Le point à ne pas défaire

**Les créneaux arrivent en UTC et sont regroupés par jour dans le
navigateur**, dans le fuseau du visiteur. Le serveur ne connaît pas ce fuseau
quand il liste ; il ne le reçoit qu'à la réservation, pour formater les mails.

Regrouper côté serveur semble plus simple, et c'est le piège : il faut alors
envoyer le fuseau du visiteur avant de lister, et le moindre décalage range
les créneaux de fin de soirée sur le mauvais jour dès que le visiteur n'est
pas dans le fuseau du propriétaire. C'est l'un des tickets les plus tenaces
de Cal.com. Ici, le serveur envoie des instants, le navigateur fait le reste
avec `Intl.DateTimeFormat`, et changer de fuseau dans le sélecteur ne
demande aucun appel réseau.

Si vous refaites ce composant de mémoire, c'est la partie que vous perdrez.

## Détails d'implémentation

- **Un seul appel réseau** au chargement : tous les créneaux de l'horizon
  (30 jours par défaut), soit quelques centaines d'instants. Le mois, le
  jour et le fuseau se changent sans recharger.
- **Un créneau pris entre-temps** renvoie `creneau_indisponible` : la brique
  le dit, recharge les disponibilités et revient au calendrier.
- **Le pot de miel** (`entreprise`) est placé hors écran, jamais en
  `display: none` : certains robots respectent ce dernier.
- **Le formulaire** valide avant d'envoyer, mais c'est le serveur qui fait
  foi : il revérifie tout, y compris que l'instant demandé est bien un
  créneau qu'il aurait proposé.
- **Fuseaux** : la liste vient d'`Intl.supportedValuesOf` quand le
  navigateur l'a, sinon d'une courte liste francophone. Le fuseau du
  propriétaire y figure toujours.

## Démonstration

Ouvrez `demo.html` : la brique y tourne sur un faux serveur en mémoire, avec
des créneaux générés pour les prochaines semaines. Aucun serveur à lancer.

## Compatibilité

Navigateurs modernes : `fetch`, `Intl.DateTimeFormat.formatToParts`,
`CustomEvent`, `:has()` pour l'accent sur l'option cochée (dégradation
propre sans). Le JavaScript est en ES5 sauf `padStart`, présent partout
depuis 2017. Sur un navigateur trop ancien, le lien de repli reste affiché.
