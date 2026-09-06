// L'application HTTP : les routes, la validation, et l'enchaînement
// réservation → Google → mails → rappels. `serveur.js` la fait écouter ;
// les tests l'instancient sur un port libre.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ouvrir, CreneauPris, Introuvable, DejaAnnulee, DejaPassee } from './base.js';
import { calculerCreneaux, estProposable } from './creneaux.js';
import { Google, GoogleIndisponible } from './google.js';
import { Courrier, mailsConfirmation, mailsAnnulation, mailsDeplacement, mailRappel, decrireCreneau } from './courrier.js';
import { lireEnv, lireReglages, preparerDossier } from './config.js';

const ICI = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;
const JOUR = 86_400_000;

// --- Petits outils HTTP -----------------------------------------------------

export function echapper(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(res, code, corps) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corps));
}

function html(res, code, corps) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corps);
}

function rediriger(res, url) {
  res.writeHead(303, { Location: url });
  res.end();
}

function lireCorps(req, limite = 16_384) {
  return new Promise((resoudre, rejeter) => {
    const morceaux = [];
    let taille = 0;
    req.on('data', (m) => {
      taille += m.length;
      if (taille > limite) { rejeter(new Error('Corps trop volumineux')); req.destroy(); return; }
      morceaux.push(m);
    });
    req.on('end', () => resoudre(Buffer.concat(morceaux).toString('utf8')));
    req.on('error', rejeter);
  });
}

async function lireJson(req) {
  const brut = await lireCorps(req);
  if (!brut) return {};
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(brut));
  try { return JSON.parse(brut); } catch { throw new Erreur(400, 'json_invalide', 'Le corps de la requête n\'est pas du JSON.'); }
}

class Erreur extends Error {
  constructor(code, type, message) { super(message); this.http = code; this.type = type; }
}

// Un compteur par adresse et par fenêtre, en mémoire. Suffisant pour un
// module d'indépendant ; un redémarrage remet à zéro, ce n'est pas grave.
class Limiteur {
  constructor() { this.compteurs = new Map(); }
  autoriser(cle, max, fenetreMs, maintenant = Date.now()) {
    let c = this.compteurs.get(cle);
    if (!c || c.reset < maintenant) { c = { n: 0, reset: maintenant + fenetreMs }; this.compteurs.set(cle, c); }
    c.n++;
    if (this.compteurs.size > 10_000) this.compteurs.clear();
    return c.n <= max;
  }
}

// --- Gabarits ---------------------------------------------------------------

const gabarits = new Map();
function gabarit(nom) {
  if (!gabarits.has(nom)) gabarits.set(nom, readFileSync(join(ICI, 'pages', nom), 'utf8'));
  return gabarits.get(nom);
}

// Remplace {{cle}} par la valeur échappée, {{{cle}}} par la valeur brute.
function rendre(nom, valeurs) {
  return gabarit(nom)
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => valeurs[k] ?? '')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => echapper(valeurs[k] ?? ''));
}

// --- Validation -------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function texte(v, max, { requis = false, nom = 'champ' } = {}) {
  const s = String(v ?? '').trim();
  if (requis && !s) throw new Erreur(400, 'champ_manquant', `Le champ « ${nom} » est obligatoire.`);
  if (s.length > max) throw new Erreur(400, 'champ_trop_long', `Le champ « ${nom} » dépasse ${max} caractères.`);
  return s;
}

function fuseauValide(f, defaut) {
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: f }); return f; } catch { return defaut; }
}

function instant(v, nom = 'debut') {
  const t = typeof v === 'number' ? v : Date.parse(String(v ?? ''));
  if (!Number.isFinite(t)) throw new Erreur(400, 'date_invalide', `La date « ${nom} » est invalide.`);
  return t;
}

// --- L'application ----------------------------------------------------------

export function creerApplication(env = lireEnv(), { maintenant = () => Date.now(), limites = {} } = {}) {
  // Demandes d'écriture par adresse et par heure, lectures par minute.
  const LIMITE_ECRITURE = limites.ecriture ?? 10;
  const LIMITE_LECTURE = limites.lecture ?? 120;
  preparerDossier(env.donnees);
  const base = ouvrir(join(env.donnees, 'rdv.sqlite'));
  let reglages = lireReglages(env.donnees);
  const journal = (niveau, message, uid = null) => {
    base.journal(niveau, message, uid, maintenant());
    if (niveau === 'erreur') console.error(`[rdv] ${message}`);
  };
  const google = new Google(env.google, base, { urlPublique: env.urlPublique, journal });
  const courrier = new Courrier(env.smtp, { journal });
  const limiteur = new Limiteur();
  const ctx = () => ({ reglages, proprietaire: env.proprietaire, urlPublique: env.urlPublique });

  const hacherIp = (ip) => createHash('sha256').update(`${env.cleAdmin}|${ip}`).digest('base64url').slice(0, 16);

  // Les occupations connues sur une fenêtre : la base et Google.
  async function occupations(de, a, { frais = false, sauf = null } = {}) {
    const locales = base.occupations(de - JOUR, a + JOUR).filter((o) => o.uid !== sauf);
    const distantes = await google.occupations(de - JOUR, a + JOUR, { frais });
    return [...locales, ...distantes];
  }

  async function creneaux(de, a, { sauf = null } = {}) {
    const now = maintenant();
    return calculerCreneaux({
      reglages, maintenant: now, de, a,
      occupations: await occupations(de, a, { sauf }),
      parJour: base.parJour(reglages.fuseau, de - JOUR, a + JOUR),
    });
  }

  async function verifierProposable(debut, { sauf = null } = {}) {
    const now = maintenant();
    const fin = debut + reglages.duree * MINUTE;
    const ok = estProposable(debut, {
      reglages, maintenant: now,
      occupations: await occupations(debut, fin, { frais: true, sauf }),
      parJour: base.parJour(reglages.fuseau, debut - JOUR, fin + JOUR),
    });
    if (!ok) throw new Erreur(409, 'creneau_indisponible', 'Ce créneau n\'est plus disponible.');
    return fin;
  }

  // Après la mise en base : Google, mails, rappels. Aucune de ces étapes ne
  // remet en cause la réservation ; ce qui échoue est journalisé, et
  // l'événement Google sera retenté par la boucle de fond.
  async function apresReservation(r) {
    try {
      const { id, lienVisio } = await google.creerEvenement(r, reglages, env.proprietaire);
      if (id) { base.noterGoogle(r.uid, id, lienVisio); r = base.obtenir(r.uid); }
    } catch (e) {
      journal('erreur', `événement Google non créé, sera retenté : ${e.message}`, r.uid);
    }
    const mails = mailsConfirmation(r, ctx());
    await courrier.envoyer(mails.visiteur, r, ctx(), r.uid);
    await courrier.envoyer(mails.proprietaire, r, ctx(), r.uid);
    base.planifierRappels(r.uid, r.debut, reglages.rappelsMinutes ?? [], maintenant());
    return r;
  }

  async function annuler(uid, motif, { parLeProprietaire = false } = {}) {
    const r = base.annuler(uid, motif, maintenant());
    try { await google.supprimerEvenement(r); } catch (e) { journal('erreur', `événement Google non supprimé : ${e.message}`, uid); }
    const mails = mailsAnnulation(r, ctx(), { parLeProprietaire });
    await courrier.envoyer(mails.visiteur, r, ctx(), uid);
    await courrier.envoyer(mails.proprietaire, r, ctx(), uid);
    journal('info', 'annulation', uid);
    return r;
  }

  async function deplacer(uid, debut) {
    const ancienne = base.obtenir(uid);
    if (!ancienne) throw new Introuvable();
    const fin = await verifierProposable(debut, { sauf: uid });
    const nouvelle = base.deplacer(uid, { debut, fin, reglages, maintenant: maintenant() });
    try { await google.deplacerEvenement(nouvelle, reglages, env.proprietaire); } catch (e) {
      journal('erreur', `événement Google non déplacé : ${e.message}`, nouvelle.uid);
    }
    const mails = mailsDeplacement(nouvelle, ancienne, ctx());
    await courrier.envoyer(mails.visiteur, nouvelle, ctx(), nouvelle.uid);
    await courrier.envoyer(mails.proprietaire, nouvelle, ctx(), nouvelle.uid);
    base.planifierRappels(nouvelle.uid, nouvelle.debut, reglages.rappelsMinutes ?? [], maintenant());
    journal('info', `déplacement depuis ${uid}`, nouvelle.uid);
    return nouvelle;
  }

  // --- Tâches de fond (appelées par serveur.js, testables à la main) ---------

  async function tachesDeFond() {
    const now = maintenant();
    for (const rappel of base.rappelsDus(now)) {
      const r = base.obtenir(rappel.reservation_uid);
      await courrier.envoyer(mailRappel(r, ctx(), Number(rappel.type)), null, null, r.uid);
      base.rappelEnvoye(rappel.id, now);
    }
    if (google.autorise) {
      for (const r of base.sansEvenementGoogle(now)) {
        try {
          const { id, lienVisio } = await google.creerEvenement(r, reglages, env.proprietaire);
          if (id) { base.noterGoogle(r.uid, id, lienVisio); journal('info', 'événement Google créé en différé', r.uid); }
        } catch (e) { journal('erreur', `nouvel échec Google : ${e.message}`, r.uid); break; }
      }
    }
  }

  function purger() {
    const n = base.purger(reglages.conservationJours ?? 365, maintenant());
    if (n) journal('info', `purge : ${n} réservation(s) supprimée(s)`);
  }

  function rechargerReglages() {
    reglages = lireReglages(env.donnees);
    return reglages;
  }

  // --- Routage ----------------------------------------------------------------

  const origines = new Set([env.urlPublique, ...env.origines]);
  // Une page servie sur la machine du développeur (localhost, 127.0.0.1,
  // n'importe quel port) est toujours admise : c'est ainsi qu'on teste le
  // site avant de le publier. Ça ne protège rien de moins — la vérification
  // d'origine vise les sites tiers, pas le poste de la personne elle-même.
  const LOCALE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const origineAdmise = (o) => origines.has(o) || LOCALE.test(o);

  function cors(req, res) {
    const origine = req.headers.origin;
    if (origine && origineAdmise(origine)) {
      res.setHeader('Access-Control-Allow-Origin', origine);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function verifierOrigine(req) {
    const origine = req.headers.origin;
    if (origine && !origineAdmise(origine)) throw new Erreur(403, 'origine_refusee', 'Ce site n’est pas autorisé à prendre des rendez-vous ici.');
  }

  function ip(req) {
    return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  }

  function pageRendezVous(r, { message = '' } = {}) {
    const now = maintenant();
    const etat = r.statut === 'annulee' ? 'annulee' : r.fin <= now ? 'passee' : 'active';
    return rendre('rendezvous.html', {
      uid: r.uid,
      titre: reglages.titre,
      proprietaire: env.proprietaire.nom,
      quand: decrireCreneau(r, r.fuseau),
      format: r.format === 'visio' ? 'Visio' : 'Téléphone',
      contact: etat !== 'active' ? ''
        : r.format === 'visio'
          ? (r.lien_visio ? `<a href="${echapper(r.lien_visio)}">${echapper(r.lien_visio)}</a>` : 'Le lien de visio est envoyé par mail avant le rendez-vous.')
          : `${echapper(env.proprietaire.nom)} vous appelle au ${echapper(r.telephone)}.`,
      nom: r.nom,
      message,
      urlPublique: env.urlPublique,
      classeEtat: etat,
      etatTexte: { active: 'Confirmé', annulee: 'Annulé', passee: 'Passé' }[etat],
      duree: reglages.duree,
      fuseau: r.fuseau,
    });
  }

  async function traiter(req, res) {
    const url = new URL(req.url, env.urlPublique);
    const chemin = url.pathname.replace(/\/+$/, '') || '/';
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    // Fichiers de la brique, servis tels quels pour la page autonome.
    if (req.method === 'GET' && (chemin === '/rdv.css' || chemin === '/rdv.js')) {
      const fichier = join(ICI, '..', chemin.slice(1));
      if (!existsSync(fichier)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': chemin.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.end(readFileSync(fichier));
      return;
    }

    if (req.method === 'GET' && chemin === '/sante') {
      return json(res, 200, { ok: true, google: google.configure ? (google.autorise ? 'autorise' : 'non_autorise') : 'debranche', smtp: courrier.configure });
    }

    if (req.method === 'GET' && chemin === '/') {
      return html(res, 200, rendre('index.html', { titre: reglages.titre, proprietaire: env.proprietaire.nom, urlPublique: env.urlPublique, duree: reglages.duree }));
    }

    if (req.method === 'GET' && chemin === '/api/reglages') {
      return json(res, 200, {
        duree: reglages.duree, fuseau: reglages.fuseau, titre: reglages.titre,
        proprietaire: env.proprietaire.nom, horizonJours: reglages.horizonJours, preavisMinutes: reglages.preavisMinutes,
      });
    }

    if (req.method === 'GET' && chemin === '/api/creneaux') {
      if (!limiteur.autoriser(`c:${ip(req)}`, LIMITE_LECTURE, MINUTE, maintenant())) throw new Erreur(429, 'trop_de_requetes', 'Trop de requêtes, réessayez dans une minute.');
      const now = maintenant();
      const de = url.searchParams.has('de') ? instant(url.searchParams.get('de'), 'de') : now;
      const a = url.searchParams.has('a') ? instant(url.searchParams.get('a'), 'a') : now + 14 * JOUR;
      if (a - de > 62 * JOUR) throw new Erreur(400, 'fenetre_trop_large', 'La fenêtre demandée dépasse deux mois.');
      const sauf = texte(url.searchParams.get('sauf'), 40) || null;
      const liste = await creneaux(de, a, { sauf });
      return json(res, 200, { creneaux: liste.map((t) => new Date(t).toISOString()), duree: reglages.duree, fuseau: reglages.fuseau });
    }

    if (req.method === 'POST' && chemin === '/api/reservations') {
      verifierOrigine(req);
      if (!limiteur.autoriser(`r:${ip(req)}`, LIMITE_ECRITURE, 60 * MINUTE, maintenant())) throw new Erreur(429, 'trop_de_requetes', 'Trop de demandes depuis cette adresse. Réessayez plus tard.');
      const d = await lireJson(req);
      /* Pot de miel : un robot qui le remplit reçoit un faux succès.
         Le champ s'appelait « entreprise », un mot que Chrome reconnaît comme un
         nom de société et remplit automatiquement — `autocomplete=off` étant
         ignoré pour les fiches contact. Des visiteurs réels recevaient donc une
         confirmation sans qu'aucun rendez-vous ne soit créé. */
      if (texte(d['ne-pas-remplir'], 500)) return json(res, 201, { uid: 'ok', url: `${env.urlPublique}/` });
      const debut = instant(d.debut);
      const format = d.format === 'telephone' ? 'telephone' : d.format === 'visio' ? 'visio' : null;
      if (!format) throw new Erreur(400, 'format_invalide', 'Choisissez visio ou téléphone.');
      const nom = texte(d.nom, 120, { requis: true, nom: 'nom' });
      const email = texte(d.email, 200, { requis: true, nom: 'e-mail' }).toLowerCase();
      if (!EMAIL.test(email)) throw new Erreur(400, 'email_invalide', 'L\'adresse e-mail est invalide.');
      const telephone = texte(d.telephone, 40, { requis: format === 'telephone', nom: 'téléphone' });
      const message = texte(d.message, 2000);
      const fuseau = fuseauValide(texte(d.fuseau, 60), reglages.fuseau);
      const fin = await verifierProposable(debut);
      let r;
      try {
        r = base.reserver({
          debut, fin, format, nom, email, telephone, message, fuseau, ipHachee: hacherIp(ip(req)),
          statut: reglages.confirmationAutomatique === false ? 'en_attente' : 'confirmee',
          reglages, maintenant: maintenant(),
        });
      } catch (e) {
        if (e instanceof CreneauPris) throw new Erreur(409, 'creneau_indisponible', e.message);
        throw e;
      }
      journal('info', `réservation ${format} ${new Date(debut).toISOString()}`, r.uid);
      r = await apresReservation(r);
      return json(res, 201, { uid: r.uid, url: `${env.urlPublique}/r/${r.uid}`, lienVisio: r.lien_visio, debut: new Date(r.debut).toISOString(), fin: new Date(r.fin).toISOString() });
    }

    let m;
    if ((m = chemin.match(/^\/api\/reservations\/([A-Za-z0-9_-]{22})$/)) && req.method === 'GET') {
      const r = base.obtenir(m[1]);
      if (!r) throw new Erreur(404, 'introuvable', 'Rendez-vous introuvable.');
      return json(res, 200, {
        uid: r.uid, debut: new Date(r.debut).toISOString(), fin: new Date(r.fin).toISOString(), statut: r.statut,
        format: r.format, nom: r.nom, fuseau: r.fuseau, lienVisio: r.lien_visio,
      });
    }

    if ((m = chemin.match(/^\/api\/reservations\/([A-Za-z0-9_-]{22})\/annulation$/)) && req.method === 'POST') {
      verifierOrigine(req);
      const d = await lireJson(req);
      const r = await annuler(m[1], texte(d.motif, 500));
      return json(res, 200, { uid: r.uid, statut: r.statut });
    }

    if ((m = chemin.match(/^\/api\/reservations\/([A-Za-z0-9_-]{22})\/deplacement$/)) && req.method === 'POST') {
      verifierOrigine(req);
      if (!limiteur.autoriser(`r:${ip(req)}`, LIMITE_ECRITURE, 60 * MINUTE, maintenant())) throw new Erreur(429, 'trop_de_requetes', 'Trop de demandes depuis cette adresse.');
      const d = await lireJson(req);
      const r = await deplacer(m[1], instant(d.debut));
      return json(res, 200, { uid: r.uid, url: `${env.urlPublique}/r/${r.uid}`, debut: new Date(r.debut).toISOString(), fin: new Date(r.fin).toISOString() });
    }

    // La page d'un rendez-vous, et son formulaire d'annulation sans JavaScript.
    if ((m = chemin.match(/^\/r\/([A-Za-z0-9_-]{22})$/))) {
      const r = base.obtenir(m[1]);
      if (!r) return html(res, 404, rendre('erreur.html', { titre: 'Rendez-vous introuvable', message: 'Ce lien ne correspond à aucun rendez-vous.', urlPublique: env.urlPublique }));
      if (req.method === 'GET') return html(res, 200, pageRendezVous(r));
      if (req.method === 'POST') {
        verifierOrigine(req);
        const d = await lireJson(req);
        if (d.action === 'annuler') {
          try {
            const a = await annuler(r.uid, texte(d.motif, 500));
            return html(res, 200, pageRendezVous(a, { message: 'Votre rendez-vous est annulé. Un mail de confirmation vous a été envoyé.' }));
          } catch (e) {
            if (e instanceof DejaAnnulee || e instanceof DejaPassee) return html(res, 200, pageRendezVous(r, { message: e.message }));
            throw e;
          }
        }
      }
    }

    // Autorisation Google, une fois, protégée par la clé d'administration.
    if (req.method === 'GET' && chemin === '/google/connexion') {
      // La clé est comparée aussi sous sa forme brute : dans une URL, un « + »
      // devient un espace au décodage, ce qui rejetterait une clé base64.
      const brute = decodeURIComponent((req.url.match(/[?&]cle=([^&#]*)/) ?? [])[1] ?? '');
      if (!env.cleAdmin || (url.searchParams.get('cle') !== env.cleAdmin && brute !== env.cleAdmin)) throw new Erreur(403, 'interdit', 'Clé invalide.');
      if (!google.configure) throw new Erreur(500, 'google_non_configure', 'GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET manquent.');
      return rediriger(res, google.urlAutorisation());
    }
    if (req.method === 'GET' && chemin === '/google/retour') {
      if (url.searchParams.get('error')) throw new Erreur(400, 'google_refus', `Google a répondu : ${url.searchParams.get('error')}`);
      const compte = await google.recevoirCode(url.searchParams.get('code'), url.searchParams.get('state'));
      journal('info', `Google Calendar autorisé${compte ? ` (${compte})` : ''}`);
      return html(res, 200, rendre('erreur.html', { titre: 'Agenda connecté', message: `Google Calendar est autorisé${compte ? ` pour ${compte}` : ''}. Vous pouvez fermer cette page.`, urlPublique: env.urlPublique }));
    }

    throw new Erreur(404, 'introuvable', 'Page introuvable.');
  }

  const serveur = createServer(async (req, res) => {
    try {
      await traiter(req, res);
    } catch (e) {
      const accepteHtml = (req.headers.accept ?? '').includes('text/html') && !req.url.startsWith('/api/');
      if (e instanceof Erreur) {
        if (accepteHtml) return html(res, e.http, rendre('erreur.html', { titre: 'Impossible', message: e.message, urlPublique: env.urlPublique }));
        return json(res, e.http, { erreur: e.type, message: e.message });
      }
      if (e instanceof GoogleIndisponible) {
        journal('erreur', e.message);
        const message = 'L\'agenda est momentanément injoignable. Réessayez dans quelques minutes.';
        if (accepteHtml) return html(res, 503, rendre('erreur.html', { titre: 'Agenda injoignable', message, urlPublique: env.urlPublique }));
        return json(res, 503, { erreur: 'google_indisponible', message });
      }
      if (e instanceof Introuvable) return json(res, 404, { erreur: 'introuvable', message: e.message });
      if (e instanceof DejaAnnulee || e instanceof DejaPassee) return json(res, 409, { erreur: e.code, message: e.message });
      if (e instanceof CreneauPris) return json(res, 409, { erreur: 'creneau_indisponible', message: e.message });
      journal('erreur', `erreur interne : ${e.stack ?? e.message}`);
      if (accepteHtml) return html(res, 500, rendre('erreur.html', { titre: 'Erreur', message: 'Une erreur est survenue. Réessayez, ou écrivez-nous.', urlPublique: env.urlPublique }));
      return json(res, 500, { erreur: 'interne', message: 'Une erreur est survenue.' });
    }
  });

  return { serveur, base, google, courrier, env, reglages: () => reglages, rechargerReglages, tachesDeFond, purger, journal };
}
