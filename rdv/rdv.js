/* Rendez-vous — la brique côté navigateur.
 *
 * Trouve chaque [data-rdv], y construit un calendrier de créneaux, un
 * formulaire, et parle au serveur par son API. Sans ce script, le lien de
 * repli reste affiché : jamais un trou dans la page.
 *
 * Le point à ne pas défaire : les créneaux arrivent en UTC et sont REGROUPÉS
 * PAR JOUR ICI, dans le fuseau du visiteur, jamais côté serveur. Regrouper
 * côté serveur oblige à connaître le fuseau du visiteur avant de lister, et
 * range les créneaux de fin de soirée sur le mauvais jour dès que le visiteur
 * n'est pas dans le fuseau du propriétaire.
 */
(function () {
  'use strict';

  if (!window.fetch || !window.Intl || !Intl.DateTimeFormat.prototype.formatToParts) return;

  var JOUR = 86400000;
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var JOURS_COURTS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];

  // --- Dates dans un fuseau ------------------------------------------------

  var formateurs = {};
  function formateur(fuseau) {
    if (!formateurs[fuseau]) {
      formateurs[fuseau] = new Intl.DateTimeFormat('en-US', {
        timeZone: fuseau, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    }
    return formateurs[fuseau];
  }

  // « AAAA-MM-JJ » et « HH:MM » d'un instant, dans un fuseau.
  function local(instant, fuseau) {
    var p = {};
    formateur(fuseau).formatToParts(new Date(instant)).forEach(function (x) { p[x.type] = x.value; });
    return { date: p.year + '-' + p.month + '-' + p.day, heure: p.hour + ':' + p.minute };
  }

  function heureLisible(hm) {
    return hm.replace(':', ' h ');
  }

  function dateLisible(dateTexte) {
    var m = dateTexte.split('-').map(Number);
    var d = new Date(Date.UTC(m[0], m[1] - 1, m[2]));
    var js = (d.getUTCDay() + 6) % 7;
    return ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'][js] + ' ' + m[2] + ' ' + MOIS[m[1] - 1];
  }

  function nomFuseau(fuseau) {
    try {
      var p = new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, timeZoneName: 'long' }).formatToParts(new Date());
      for (var i = 0; i < p.length; i++) if (p[i].type === 'timeZoneName') return p[i].value;
    } catch (e) { /* ignoré */ }
    return fuseau;
  }

  function fuseauNavigateur() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }

  function listeFuseaux(actuel, proprietaire) {
    var base = ['Indian/Reunion', 'Europe/Paris', 'Indian/Mauritius', 'Indian/Mayotte', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne', 'Pacific/Noumea', 'Pacific/Tahiti', 'Europe/Brussels', 'Europe/Zurich', 'America/Montreal', 'Africa/Casablanca', 'UTC'];
    var tous = base.slice();
    if (Intl.supportedValuesOf) { try { tous = Intl.supportedValuesOf('timeZone'); } catch (e) { /* ignoré */ } }
    [actuel, proprietaire].forEach(function (f) { if (f && tous.indexOf(f) < 0) tous.unshift(f); });
    return tous;
  }

  // --- Fabrique d'éléments -------------------------------------------------

  function el(tag, attrs, enfants) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    (enfants || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  // --- Le composant --------------------------------------------------------

  function Rdv(racine) {
    this.racine = racine;
    this.api = (racine.getAttribute('data-rdv') || '').replace(/\/$/, '');
    this.deplacer = racine.getAttribute('data-rdv-deplacer') || null;
    this.fuseau = fuseauNavigateur();
    this.creneaux = [];
    this.parJour = {};
    this.reglages = null;
    this.jour = null;
    this.choisi = null;
    this.mois = null; // { annee, mois } affiché
    racine.setAttribute('data-rdv-actif', '');
    racine.innerHTML = '';
    this.statut = el('p', { 'class': 'rdv__statut', role: 'status', 'aria-live': 'polite' });
    this.corps = el('div', { 'class': 'rdv__corps' });
    racine.appendChild(this.corps);
    racine.appendChild(this.statut);
    this.charger();
  }

  Rdv.prototype.dire = function (message, erreur) {
    this.statut.textContent = message || '';
    this.statut.classList.toggle('rdv__statut--erreur', Boolean(erreur));
  };

  // Toute erreur ressort avec un message en français : le navigateur, lui,
  // ne sait dire que « Failed to fetch », et c'est ce que verrait le visiteur.
  var MESSAGES = {
    reseau: 'Impossible de joindre le service de rendez-vous. Vérifiez votre connexion, ou réessayez dans un instant.',
    reponse: 'Le service de rendez-vous a répondu quelque chose d’inattendu. Réessayez dans un instant.',
    inconnu: 'Une erreur est survenue. Réessayez dans un instant.'
  };
  Rdv.prototype.requete = function (chemin, options) {
    return fetch(this.api + chemin, options).catch(function () {
      var e = new Error(MESSAGES.reseau); e.type = 'reseau'; throw e;
    }).then(function (rep) {
      return rep.json().catch(function () { return null; }).then(function (json) {
        if (!rep.ok) {
          var e = new Error((json && json.message) || (rep.status >= 500 ? MESSAGES.reponse : MESSAGES.inconnu));
          e.type = (json && json.erreur) || 'http_' + rep.status;
          throw e;
        }
        if (!json) { var e2 = new Error(MESSAGES.reponse); e2.type = 'reponse'; throw e2; }
        return json;
      });
    });
  };

  Rdv.prototype.charger = function () {
    var self = this;
    // Une page ouverte comme un fichier (double-clic sur index.html) a une
    // origine « null » : le navigateur refuse toute réponse du serveur. Le
    // dire vaut mieux qu'un message réseau qui ferait chercher ailleurs.
    if (window.location.protocol === 'file:' && this.api) {
      this.dire('Cette page est ouverte comme un fichier, et le calendrier a besoin d’être servi par un site (http ou https). Ouvrez-la depuis un serveur local, ou passez par le lien ci-dessus.', true);
      this.corps.innerHTML = '';
      this.corps.appendChild(el('a', { 'class': 'rdv__repli', href: this.api + '/', text: 'Ouvrir la page de réservation' }));
      return;
    }
    this.dire('Chargement des disponibilités…');
    var maintenant = Date.now();
    var horizon = 31;
    this.requete('/api/reglages').then(function (r) {
      self.reglages = r;
      horizon = Math.min(62, r.horizonJours || 30) + 1;
      var q = '?de=' + encodeURIComponent(new Date(maintenant).toISOString()) + '&a=' + encodeURIComponent(new Date(maintenant + horizon * JOUR).toISOString());
      if (self.deplacer) q += '&sauf=' + encodeURIComponent(self.deplacer);
      return self.requete('/api/creneaux' + q);
    }).then(function (r) {
      self.creneaux = r.creneaux.map(function (s) { return Date.parse(s); });
      self.regrouper();
      self.dire('');
      self.rendreCalendrier();
    }).catch(function (e) {
      self.dire(e.message, true);
      self.corps.innerHTML = '';
      self.corps.appendChild(el('a', { 'class': 'rdv__repli', href: self.api + '/', text: 'Ouvrir la page de réservation' }));
    });
  };

  // Regroupe les instants UTC par date locale du visiteur.
  Rdv.prototype.regrouper = function () {
    var self = this;
    this.parJour = {};
    this.creneaux.forEach(function (t) {
      var l = local(t, self.fuseau);
      (self.parJour[l.date] = self.parJour[l.date] || []).push({ instant: t, heure: l.heure });
    });
    var jours = Object.keys(this.parJour).sort();
    if (!this.jour || !this.parJour[this.jour]) this.jour = jours[0] || null;
    if (!this.mois) {
      var premier = (this.jour || local(Date.now(), this.fuseau).date).split('-');
      this.mois = { annee: Number(premier[0]), mois: Number(premier[1]) };
    }
  };

  Rdv.prototype.rendreCalendrier = function () {
    var self = this;
    this.corps.innerHTML = '';
    this.choisi = null;

    var jours = Object.keys(this.parJour).sort();
    if (!jours.length) {
      this.corps.appendChild(el('p', { 'class': 'rdv__vide', text: 'Aucun créneau disponible pour le moment. Réessayez dans quelques jours.' }));
      return;
    }

    // Le mois --------------------------------------------------------------
    var annee = this.mois.annee, mois = this.mois.mois;
    var titre = el('h3', { 'class': 'rdv__mois', text: MOIS[mois - 1] + ' ' + annee });
    var premierJour = jours[0].slice(0, 7), dernierJour = jours[jours.length - 1].slice(0, 7);
    var cle = annee + '-' + String(mois).padStart(2, '0');
    var nav = el('div', { 'class': 'rdv__nav' }, [
      el('button', { 'class': 'rdv__fleche', type: 'button', 'aria-label': 'Mois précédent', text: '‹', disabled: cle <= premierJour ? '' : null, onclick: function () { self.changerMois(-1); } }),
      titre,
      el('button', { 'class': 'rdv__fleche', type: 'button', 'aria-label': 'Mois suivant', text: '›', disabled: cle >= dernierJour ? '' : null, onclick: function () { self.changerMois(1); } })
    ]);

    var grille = el('div', { 'class': 'rdv__grille', role: 'grid' });
    JOURS_COURTS.forEach(function (j) { grille.appendChild(el('span', { 'class': 'rdv__entete', text: j })); });
    var decalage = (new Date(Date.UTC(annee, mois - 1, 1)).getUTCDay() + 6) % 7;
    for (var v = 0; v < decalage; v++) grille.appendChild(el('span', { 'class': 'rdv__case rdv__case--vide' }));
    var nbJours = new Date(Date.UTC(annee, mois, 0)).getUTCDate();
    for (var d = 1; d <= nbJours; d++) {
      var date = cle + '-' + String(d).padStart(2, '0');
      var dispo = Boolean(this.parJour[date]);
      grille.appendChild(el('button', {
        'class': 'rdv__case' + (dispo ? ' rdv__case--dispo' : '') + (date === this.jour ? ' rdv__case--choisi' : ''),
        type: 'button', text: String(d), disabled: dispo ? null : '',
        'aria-pressed': date === this.jour ? 'true' : 'false',
        'aria-label': dateLisible(date) + (dispo ? ', ' + this.parJour[date].length + ' créneaux' : ', aucun créneau'),
        onclick: (function (date) { return function () { self.jour = date; self.rendreCalendrier(); }; })(date)
      }));
    }

    // Les créneaux du jour ----------------------------------------------------
    var liste = el('div', { 'class': 'rdv__creneaux' });
    if (this.jour) {
      liste.appendChild(el('h4', { 'class': 'rdv__jour', text: dateLisible(this.jour) }));
      var boutons = el('div', { 'class': 'rdv__heures' });
      this.parJour[this.jour].forEach(function (c) {
        boutons.appendChild(el('button', {
          'class': 'rdv__heure', type: 'button', text: heureLisible(c.heure),
          onclick: function () { self.choisi = c.instant; self.rendreFormulaire(); }
        }));
      });
      liste.appendChild(boutons);
    }

    // Le fuseau -------------------------------------------------------------
    var select = el('select', { 'class': 'rdv__fuseau', 'aria-label': 'Fuseau horaire' });
    listeFuseaux(this.fuseau, this.reglages && this.reglages.fuseau).forEach(function (f) {
      select.appendChild(el('option', { value: f, text: f.replace(/_/g, ' '), selected: f === self.fuseau ? '' : null }));
    });
    select.addEventListener('change', function () {
      self.fuseau = select.value;
      self.jour = null; self.mois = null;
      self.regrouper();
      self.rendreCalendrier();
    });
    var pied = el('p', { 'class': 'rdv__pied' }, [
      'Heures affichées : ' + nomFuseau(this.fuseau) + '. ',
      el('label', { 'class': 'rdv__fuseau-label' }, ['Changer : ', select])
    ]);

    this.corps.appendChild(el('div', { 'class': 'rdv__colonnes' }, [
      el('div', { 'class': 'rdv__calendrier' }, [nav, grille]),
      liste
    ]));
    this.corps.appendChild(pied);
  };

  Rdv.prototype.changerMois = function (delta) {
    var m = this.mois.mois + delta, a = this.mois.annee;
    if (m < 1) { m = 12; a--; } else if (m > 12) { m = 1; a++; }
    this.mois = { annee: a, mois: m };
    // Sélectionne le premier jour disponible du mois affiché.
    var cle = a + '-' + String(m).padStart(2, '0');
    var jours = Object.keys(this.parJour).sort().filter(function (j) { return j.indexOf(cle) === 0; });
    this.jour = jours[0] || this.jour;
    this.rendreCalendrier();
  };

  Rdv.prototype.rendreFormulaire = function () {
    var self = this;
    var l = local(this.choisi, this.fuseau);
    var quand = dateLisible(l.date) + ' à ' + heureLisible(l.heure) + ' (' + nomFuseau(this.fuseau) + ')';
    this.corps.innerHTML = '';

    var retour = el('button', { 'class': 'rdv__retour', type: 'button', text: '‹ Choisir un autre créneau', onclick: function () { self.rendreCalendrier(); } });
    var resume = el('p', { 'class': 'rdv__resume' }, [
      el('strong', { text: quand }),
      this.reglages ? ' · ' + this.reglages.duree + ' min' : ''
    ]);

    if (this.deplacer) {
      var confirmer = el('button', { 'class': 'rdv__envoyer', type: 'button', text: 'Déplacer le rendez-vous à ce créneau' });
      confirmer.addEventListener('click', function () {
        confirmer.disabled = true;
        self.dire('Déplacement en cours…');
        self.requete('/api/reservations/' + encodeURIComponent(self.deplacer) + '/deplacement', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ debut: new Date(self.choisi).toISOString() })
        }).then(function (r) {
          // La page du nouveau rendez-vous dit tout ; l'ancienne n'a plus de raison d'être affichée.
          self.dire('Rendez-vous déplacé. Redirection…');
          self.racine.dispatchEvent(new CustomEvent('rdv:deplace', { bubbles: true, detail: r }));
          window.location.assign(r.url);
        }).catch(function (e) { self.echec(e, confirmer); });
      });
      this.corps.appendChild(el('div', { 'class': 'rdv__formulaire' }, [retour, resume, confirmer]));
      return;
    }

    var champ = function (nom, label, type, attrs) {
      var entree = el(type === 'textarea' ? 'textarea' : 'input', Object.assign({ 'class': 'rdv__entree', name: nom, id: 'rdv-' + nom }, type === 'textarea' ? { rows: 4 } : { type: type }, attrs || {}));
      return el('label', { 'class': 'rdv__champ', 'for': 'rdv-' + nom }, [el('span', { 'class': 'rdv__label', text: label }), entree]);
    };
    var radio = function (valeur, label, coche) {
      return el('label', { 'class': 'rdv__option' }, [
        el('input', { 'class': 'rdv__radio', type: 'radio', name: 'format', value: valeur, checked: coche ? '' : null }),
        el('span', { text: label })
      ]);
    };

    var form = el('form', { 'class': 'rdv__formulaire', novalidate: '' }, [
      retour,
      resume,
      el('fieldset', { 'class': 'rdv__formats' }, [
        el('legend', { 'class': 'rdv__label', text: 'Comment préférez-vous échanger ?' }),
        radio('visio', 'En visio (un lien vous sera envoyé)', true),
        radio('telephone', 'Par téléphone (on vous appelle)')
      ]),
      champ('nom', 'Votre nom', 'text', { autocomplete: 'name', required: '' }),
      champ('email', 'Votre e-mail', 'email', { autocomplete: 'email', required: '', inputmode: 'email' }),
      champ('telephone', 'Votre téléphone', 'tel', { autocomplete: 'tel', inputmode: 'tel', placeholder: '06 92 00 00 00' }),
      champ('message', 'En deux mots, de quoi voulez-vous parler ? (facultatif)', 'textarea', {}),
      /* Pot de miel : invisible pour une personne, rempli par les robots.
         Le champ ne s'appelle PAS « entreprise » : ce mot figure dans les motifs
         d'autofill « nom de societe » de Chrome, et `autocomplete=off` est ignore
         pour les fiches contact. Le navigateur le remplissait donc tout seul, et
         le serveur renvoyait un faux succes a un visiteur bien reel. */
      el('p', { 'class': 'rdv__hp', 'aria-hidden': 'true' }, [el('label', {}, ['Ne remplissez pas ce champ : ', el('input', { name: 'ne-pas-remplir', tabindex: '-1', autocomplete: 'off' })])]),
      el('button', { 'class': 'rdv__envoyer', type: 'submit', text: 'Confirmer le rendez-vous' })
    ]);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var d = {};
      ['format', 'nom', 'email', 'telephone', 'message', 'ne-pas-remplir'].forEach(function (k) {
        var champ = form.querySelector('[name="' + k + '"]:checked, [name="' + k + '"]:not([type=radio])');
        d[k] = champ ? champ.value.trim() : '';
      });
      if (!d.nom) return self.dire('Indiquez votre nom.', true);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) return self.dire('Indiquez une adresse e-mail valide.', true);
      if (d.format === 'telephone' && !d.telephone) return self.dire('Indiquez le numéro auquel vous appeler.', true);
      d.debut = new Date(self.choisi).toISOString();
      d.fuseau = self.fuseau;
      var bouton = form.querySelector('.rdv__envoyer');
      bouton.disabled = true;
      self.dire('Réservation en cours…');
      self.requete('/api/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d)
      }).then(function (r) {
        self.dire('');
        self.rendreSucces(r, quand, false, d);
      }).catch(function (e) { self.echec(e, bouton); });
    });

    this.corps.appendChild(form);
    var premier = form.querySelector('[name="nom"]');
    if (premier) premier.focus();
  };

  // Un créneau pris entre-temps : on recharge les disponibilités.
  Rdv.prototype.echec = function (e, bouton) {
    var self = this;
    if (bouton) bouton.disabled = false;
    if (e.type === 'creneau_indisponible') {
      this.dire('Ce créneau vient d\'être pris. Voici les créneaux encore disponibles.', true);
      this.jour = null; this.mois = null;
      this.charger();
      return;
    }
    this.dire(e.message, true);
  };

  Rdv.prototype.rendreSucces = function (r, quand, deplace, d) {
    this.corps.innerHTML = '';
    var lignes = [
      el('h3', { 'class': 'rdv__titre-succes', text: deplace ? 'Rendez-vous déplacé' : 'Rendez-vous confirmé' }),
      el('p', {}, [el('strong', { text: quand })]),
      d ? el('p', { text: (d.format === 'visio' ? 'Un lien de visio' : 'Un rappel') + ' vous attend dans votre boîte : ' + d.email + '.' }) : null,
      r.lienVisio ? el('p', {}, ['Lien de visio : ', el('a', { href: r.lienVisio, text: r.lienVisio })]) : null,
      el('p', { 'class': 'rdv__gerer' }, ['Pour annuler ou déplacer : ', el('a', { href: r.url, text: 'gérer ce rendez-vous' }), '.'])
    ];
    this.corps.appendChild(el('div', { 'class': 'rdv__succes' }, lignes));
    this.racine.dispatchEvent(new CustomEvent('rdv:reserve', { bubbles: true, detail: r }));
  };

  // --- Initialisation --------------------------------------------------------

  function init(racine) {
    if (!racine || racine.hasAttribute('data-rdv-actif')) return null;
    return new Rdv(racine);
  }
  function initTout(base) {
    var liste = (base || document).querySelectorAll('[data-rdv]');
    for (var i = 0; i < liste.length; i++) init(liste[i]);
  }

  window.Rdv = { init: init, initTout: initTout };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { initTout(); });
  else initTout();
})();
