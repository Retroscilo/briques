# Grille interactive

Une grille de fond dont la case sous le pointeur s'allume, puis s'éteint en
traînée. De temps en temps, une case s'allume aussi toute seule. Pensée pour
un hero, un bandeau, une section de tête.

- **Deux fichiers**, `grille.css` et `grille.js`. Rien à installer, rien à
  compiler, aucune dépendance.
- **Dégradation propre** : sans JavaScript, la grille reste peinte en CSS.
  Seules les cases allumées disparaissent.
- **~300 lignes** commentaires compris.

## Emploi

Copiez les deux fichiers, liez-les, et écrivez ce balisage :

```html
<link rel="stylesheet" href="grille.css" />

<section class="hero grille-zone">
  <div class="grille" data-grille aria-hidden="true">
    <div class="grille__lignes"></div>
  </div>

  <h1>Votre titre</h1>
  <p>Votre contenu, par-dessus la grille.</p>
</section>

<script src="grille.js"></script>
```

C'est tout. L'initialisation est automatique au chargement.

### Ce que fait chaque classe

| Classe | Rôle |
|---|---|
| `.grille-zone` | Le conteneur. Il capte le survol et porte les variables. |
| `.grille` | Le calque penché, plus grand que la zone. Ne capte jamais le pointeur. |
| `.grille__lignes` | Les lignes, peintes en CSS. Présentes sans JavaScript. |
| `.grille__cases` | Le SVG des cases. Créé par `grille.js`, absent sans lui. |

`.grille-zone` reçoit `position: relative` et `overflow: hidden` depuis
`grille.css` — sans quoi le calque penché déborderait.

## Réglages

Toutes les variables se posent sur `.grille-zone`, sur `:root`, ou sur une
classe modificatrice. Aucune ne demande de toucher au JavaScript.

| Variable | Défaut | Effet |
|---|---|---|
| `--grille-pas` | `32px` | Le pas de la grille. Lu par le JS : une seule source de vérité. |
| `--grille-trait` | `rgba(20, 17, 15, 0.055)` | La couleur des lignes. |
| `--grille-case` | `rgba(222, 74, 21, 0.1)` | La case sous le pointeur. |
| `--grille-inclinaison` | `-12deg` | `0deg` pour une grille droite. |
| `--grille-debord` | `32%` | Débord haut et bas, pour que le biais ne laisse pas d'angles vides. |
| `--grille-allumage` | `200ms` | Voir la note ci-dessous : ne descendez pas trop. |
| `--grille-extinction` | `900ms` | La longueur de la traînée. |
| `--grille-scintillement` | `1400ms` | Une case s'allume seule, en moyenne toutes les… (l'intervalle varie de moitié). `0` coupe le scintillement. |
| `--grille-lucioles` | `3` | Combien de cases peuvent briller seules en même temps. |
| `--grille-tenue` | `600ms` | Le temps qu'une case seule reste allumée avant de s'éteindre. |

```css
.hero--sobre {
  --grille-inclinaison: 0deg;
  --grille-pas: 22px;
  --grille-case: rgba(20, 110, 190, 0.16);
}
```

### Attributs

- `data-grille` — marque le calque à initialiser. Obligatoire.
- `data-grille-zone=".selecteur"` — si la zone de survol n'est pas le parent
  direct du calque.

### API

```js
Grille.init(element);     // un calque ajouté après le chargement
Grille.initTout(racine);  // tous les [data-grille] sous `racine`
```

Un calque déjà initialisé est ignoré : les deux appels sont sans danger.

## Le point à ne pas défaire

**Le survol est écouté sur la zone, pas sur les cases**, et le calque est en
`pointer-events: none`.

C'est contre-intuitif, et c'est pourtant tout l'intérêt. Dans un hero, le
titre et les blocs de contenu sont des boîtes pleine largeur posées par-dessus
la grille. Une écoute sur les cases ne se déclencherait que dans les rares
zones qu'aucun contenu ne couvre : l'effet aurait l'air cassé, en marchant par
endroits seulement.

On écoute donc le conteneur entier, et on retrouve la case par le calcul.
Comme le calque est penché, les coordonnées de l'écran ne sont pas celles du
SVG : `getScreenCTM().inverse()` fait la conversion, inclinaison comprise.

Si vous refaites ce composant de mémoire, c'est la partie que vous perdrez.

## Détails d'implémentation

- **Les cases du survol ne sont pas créées sur écran tactile.** Le survol
  n'y existe pas ; poser un millier de nœuds SVG pour rien serait absurde.
  Test : `(hover: hover) and (pointer: fine)`.
- **Le scintillement** n'a besoin que de quelques rectangles, réutilisés et
  déplacés à la demande dans un second calque : il tourne aussi au doigt. Il
  se suspend quand l'onglet est caché ou la grille hors de l'écran, et
  l'intervalle est irrégulier — régulier, ça ferait métronome.
- **`prefers-reduced-motion`** coupe les transitions et le scintillement.
- **Redimensionnement** : `ResizeObserver`, une reconstruction par image via
  `requestAnimationFrame`, et rien du tout si le nombre de cases n'a pas changé.
- **Pas de `viewBox`** : une unité SVG vaut un pixel CSS, donc les cases
  tombent exactement sur les lignes peintes par le dégradé.
- **`--grille-allumage`** est à 200 ms et non 60 : en dessous de ~150 ms la
  courbe d'easing n'a pas le temps de s'exprimer, l'effet bascule en
  tout-ou-rien et l'adoucissement est perdu.

## Démonstration

Ouvrez `demo.html` — deux grilles côte à côte, la seconde ne différant que par
quatre variables CSS.

## Compatibilité

Navigateurs à feuilles de style modernes : `ResizeObserver`, `PointerEvent`,
propriétés personnalisées. Le JavaScript est en ES5 (`var`, pas de fonctions
fléchées), sans transpilation nécessaire. Sur un navigateur trop ancien, la
grille reste peinte et le script s'arrête sans erreur.
