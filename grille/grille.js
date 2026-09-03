/* Grille interactive — comportement.

   Superpose des cases transparentes sur une grille peinte en CSS, et allume
   celle qui se trouve sous le pointeur. De temps en temps, une case s'allume
   aussi toute seule, puis s'éteint. Sans ce fichier, la grille reste
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
   Les cases du survol ne sont pas créées sur écran tactile : le survol n'y
   existe pas, et il serait absurde d'y poser un millier de nœuds SVG pour
   rien. Le scintillement, lui, y tourne : il n'a besoin que de quelques
   rectangles. Tout s'arrête sous prefers-reduced-motion. */

(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var PAS_DEFAUT = 32;

  function init(layer) {
    if (!layer || layer.dataset.grillePosee === 'oui') { return; }
    if (!global.matchMedia) { return; }

    var selecteur = layer.getAttribute('data-grille-zone');
    var zone = selecteur ? document.querySelector(selecteur) : layer.parentElement;
    if (!zone) { return; }

    layer.dataset.grillePosee = 'oui';

    var pas = PAS_DEFAUT;
    var cols = -1;
    var lignes = -1;

    /* Les réglages viennent de la feuille de style, pas de constantes ici :
       une seule source de vérité, et une media query qui change une variable
       est suivie sans rien toucher au JavaScript. */
    function lireNombre(nom, defaut) {
      var brut = getComputedStyle(layer).getPropertyValue(nom);
      var valeur = parseFloat(brut);
      return isNaN(valeur) ? defaut : valeur;
    }

    /* Vrai si la grille a changé de taille (en cases) depuis la dernière fois. */
    function mesurer() {
      pas = lireNombre('--grille-pas', PAS_DEFAUT);
      if (!(pas > 0)) { pas = PAS_DEFAUT; }
      var c = Math.ceil(layer.offsetWidth / pas);
      var l = Math.ceil(layer.offsetHeight / pas);
      if (c === cols && l === lignes) { return false; }
      cols = c;
      lignes = l;
      return true;
    }

    function rect(x, y) {
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(pas));
      r.setAttribute('height', String(pas));
      return r;
    }

    /* ── Survol ────────────────────────────────────────────────────────── */

    var survol = matchMedia('(hover: hover) and (pointer: fine)').matches;
    var svg = null;
    var courante = null;

    if (survol) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'grille__cases');
      layer.appendChild(svg);
    }

    /* Pas de viewBox : une unité SVG vaut un pixel CSS, donc les cases
       tombent exactement sur les lignes peintes par le dégradé. */
    function construireCases() {
      courante = null;
      var lot = document.createDocumentFragment();
      for (var i = 0; i < cols * lignes; i++) {
        lot.appendChild(rect((i % cols) * pas, Math.floor(i / cols) * pas));
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

    if (survol) {
      zone.addEventListener('pointermove', function (event) {
        if (event.pointerType && event.pointerType !== 'mouse') { return; }
        allumer(caseSous(event.clientX, event.clientY));
      });
      zone.addEventListener('pointerleave', function () {
        allumer(-1);
      });
    }

    /* ── Scintillement ─────────────────────────────────────────────────
       De temps en temps, une case s'allume seule puis s'éteint, comme si
       quelqu'un était passé. Un petit vivier de rectangles réutilisés et
       déplacés à la demande, dans un calque à part : rien à voir avec le
       millier de cases du survol, et ça tourne aussi sur écran tactile.
       Suspendu quand l'onglet est caché ou la grille hors de l'écran — une
       animation que personne ne voit ne doit rien coûter. */

    var lucioles = null;
    var vivier = [];
    var minuterie = null;
    var ongletVisible = !document.hidden;
    var dansEcran = true;

    function scintillementVoulu() {
      return lireNombre('--grille-scintillement', 0) > 0 &&
             !matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function luciole() {
      var r = rect(0, 0);
      r.occupe = false;
      lucioles.appendChild(r);
      vivier.push(r);
      return r;
    }

    function libre() {
      var voulu = Math.max(1, Math.round(lireNombre('--grille-lucioles', 3)));
      for (var i = 0; i < vivier.length; i++) {
        if (!vivier[i].occupe) { return vivier[i]; }
      }
      return vivier.length < voulu ? luciole() : null;
    }

    function scintiller() {
      minuterie = null;
      if (!scintillementVoulu()) { return; }
      var intervalle = lireNombre('--grille-scintillement', 1400);
      if (ongletVisible && dansEcran && cols > 0) {
        var r = libre();
        if (r) {
          r.setAttribute('x', String(Math.floor(Math.random() * cols) * pas));
          r.setAttribute('y', String(Math.floor(Math.random() * lignes) * pas));
          r.setAttribute('width', String(pas));
          r.setAttribute('height', String(pas));
          r.occupe = true;
          /* Seule la couleur est animée (transition: fill), pas la position :
             on peut déplacer la case et l'allumer dans la même foulée. */
          r.classList.add('is-on');
          var tenue = lireNombre('--grille-tenue', 600);
          var extinction = lireNombre('--grille-extinction', 900);
          setTimeout(function () { r.classList.remove('is-on'); }, tenue);
          setTimeout(function () { r.occupe = false; }, tenue + extinction);
        }
      }
      /* Un intervalle irrégulier : entre la moitié et une fois et demie la
         valeur réglée. Régulier, ça ferait métronome. */
      minuterie = setTimeout(scintiller, intervalle * (0.5 + Math.random()));
    }

    function lancerScintillement() {
      if (minuterie !== null || !scintillementVoulu()) { return; }
      if (!lucioles) {
        lucioles = document.createElementNS(NS, 'svg');
        lucioles.setAttribute('class', 'grille__cases grille__lucioles');
        layer.appendChild(lucioles);
      }
      minuterie = setTimeout(scintiller, 400);
    }

    document.addEventListener('visibilitychange', function () {
      ongletVisible = !document.hidden;
    });
    if (global.IntersectionObserver) {
      new IntersectionObserver(function (entrees) {
        dansEcran = entrees[0].isIntersecting;
      }).observe(zone);
    }

    /* ── Construction et redimensionnement ─────────────────────────────── */

    var attente = false;

    function construire() {
      attente = false;
      if (!mesurer()) { return; }
      if (survol) { construireCases(); }
    }

    /* Une seule reconstruction par image, quel que soit le nombre
       d'événements de redimensionnement reçus entre-temps. */
    function programmer() {
      if (attente) { return; }
      attente = true;
      requestAnimationFrame(construire);
    }

    construire();
    lancerScintillement();

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
