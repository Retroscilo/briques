/* Grille interactive — comportement.

   Superpose des cases transparentes sur une grille peinte en CSS, et allume
   celle qui se trouve sous le pointeur. Sans ce fichier, la grille reste
   visible : seules les cases disparaissent.

   ── Le point à ne pas défaire ─────────────────────────────────────────────
   Le survol est écouté sur la ZONE (le conteneur), pas sur les cases, et le
   calque est en pointer-events: none. C'est contre-intuitif, et c'est
   pourtant tout l'intérêt : dans un hero, le titre et les blocs de contenu
   sont des boîtes pleine largeur posées par-dessus. Une écoute sur les cases
   ne se déclencherait que dans les rares zones qu'aucun contenu ne couvre —
   l'effet aurait l'air cassé. On écoute donc le conteneur entier et on
   retrouve la case par le calcul.

   Corollaire : les coordonnées du pointeur sont dans le repère de l'écran,
   les cases dans celui du SVG, qui est penché. getScreenCTM().inverse() fait
   la conversion, inclinaison comprise — rien à inverser à la main.

   ── Emploi ────────────────────────────────────────────────────────────────
     <div class="grille-zone">
       <div class="grille" data-grille><div class="grille__lignes"></div></div>
       … votre contenu …
     </div>

   L'initialisation est automatique. Pour une zone qui n'est pas le parent
   direct : data-grille-zone=".mon-selecteur". Pour créer une grille sur un
   élément ajouté après coup : Grille.init(element).

   ── Ce qui est délibérément absent ────────────────────────────────────────
   Rien n'est créé sur écran tactile : le survol n'y existe pas, et il serait
   absurde d'y poser un millier de nœuds SVG pour rien. Les transitions
   tombent sous prefers-reduced-motion (dans grille.css). */

(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var PAS_DEFAUT = 32;

  function init(layer) {
    if (!layer || layer.dataset.grillePosee === 'oui') { return; }
    if (!global.matchMedia) { return; }

    /* Pas de survol sur un écran tactile : on s'arrête avant de créer quoi
       que ce soit. */
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) { return; }

    var selecteur = layer.getAttribute('data-grille-zone');
    var zone = selecteur ? document.querySelector(selecteur) : layer.parentElement;
    if (!zone) { return; }

    layer.dataset.grillePosee = 'oui';

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'grille__cases');
    layer.appendChild(svg);

    var pas = PAS_DEFAUT;
    var cols = -1;
    var lignes = -1;
    var courante = null;
    var attente = false;

    /* Le pas vient de la feuille de style, pas d'une constante ici : une
       seule source de vérité, et une media query qui change --grille-pas est
       suivie sans rien toucher au JavaScript. */
    function lirePas() {
      var brut = getComputedStyle(layer).getPropertyValue('--grille-pas');
      var valeur = parseFloat(brut);
      return valeur > 0 ? valeur : PAS_DEFAUT;
    }

    function construire() {
      attente = false;
      pas = lirePas();

      var c = Math.ceil(layer.offsetWidth / pas);
      var l = Math.ceil(layer.offsetHeight / pas);
      if (c === cols && l === lignes) { return; }
      cols = c;
      lignes = l;
      courante = null;

      /* Pas de viewBox : une unité SVG vaut un pixel CSS, donc les cases
         tombent exactement sur les lignes peintes par le dégradé. */
      var lot = document.createDocumentFragment();
      for (var i = 0; i < c * l; i++) {
        var rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String((i % c) * pas));
        rect.setAttribute('y', String(Math.floor(i / c) * pas));
        rect.setAttribute('width', String(pas));
        rect.setAttribute('height', String(pas));
        lot.appendChild(rect);
      }
      svg.textContent = '';
      svg.appendChild(lot);
    }

    function caseSous(clientX, clientY) {
      var ctm = svg.getScreenCTM();
      if (!ctm) { return -1; }
      var m = ctm.inverse();
      var x = clientX * m.a + clientY * m.c + m.e;
      var y = clientX * m.b + clientY * m.d + m.f;
      var cx = Math.floor(x / pas);
      var cy = Math.floor(y / pas);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= lignes) { return -1; }
      return cy * cols + cx;
    }

    function allumer(index) {
      if (index === courante) { return; }
      if (courante !== null && svg.childNodes[courante]) {
        svg.childNodes[courante].classList.remove('is-on');
      }
      courante = index >= 0 ? index : null;
      if (courante !== null && svg.childNodes[courante]) {
        svg.childNodes[courante].classList.add('is-on');
      }
    }

    zone.addEventListener('pointermove', function (event) {
      if (event.pointerType && event.pointerType !== 'mouse') { return; }
      allumer(caseSous(event.clientX, event.clientY));
    });

    zone.addEventListener('pointerleave', function () {
      allumer(-1);
    });

    /* Une seule reconstruction par image, quel que soit le nombre
       d'événements de redimensionnement reçus entre-temps. */
    function programmer() {
      if (attente) { return; }
      attente = true;
      requestAnimationFrame(construire);
    }

    construire();

    if (global.ResizeObserver) { new ResizeObserver(programmer).observe(layer); }
    else { global.addEventListener('resize', programmer); }
  }

  function initTout(racine) {
    var cibles = (racine || document).querySelectorAll('[data-grille]');
    for (var i = 0; i < cibles.length; i++) { init(cibles[i]); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initTout(); });
  } else {
    initTout();
  }

  global.Grille = { init: init, initTout: initTout };
})(window);
