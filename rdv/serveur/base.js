// La base : SQLite via node:sqlite, un fichier, un seul processus écrivain.
//
// Tout ce qui touche aux données passe par ici. Les instants sont des entiers
// en millisecondes UTC, comme dans creneaux.js. Aucune connaissance de HTTP,
// de Google ni des mails.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { dateLocale, libre } from './creneaux.js';

const MINUTE = 60_000;
const JOUR = 86_400_000;

export const STATUTS_ACTIFS = ['confirmee', 'en_attente'];

export class CreneauPris extends Error {
  constructor() { super('Ce créneau vient d\'être pris.'); this.code = 'creneau_pris'; }
}
export class Introuvable extends Error {
  constructor() { super('Rendez-vous introuvable.'); this.code = 'introuvable'; }
}
export class DejaAnnulee extends Error {
  constructor() { super('Ce rendez-vous est déjà annulé.'); this.code = 'deja_annulee'; }
}
export class DejaPassee extends Error {
  constructor() { super('Ce rendez-vous est passé.'); this.code = 'deja_passee'; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reservations (
  uid              TEXT PRIMARY KEY,
  debut            INTEGER NOT NULL,
  fin              INTEGER NOT NULL,
  statut           TEXT NOT NULL CHECK (statut IN ('confirmee', 'en_attente', 'annulee')),
  format           TEXT NOT NULL CHECK (format IN ('visio', 'telephone')),
  nom              TEXT NOT NULL,
  email            TEXT NOT NULL,
  telephone        TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  fuseau           TEXT NOT NULL,
  ical_uid         TEXT NOT NULL,
  ical_sequence    INTEGER NOT NULL DEFAULT 0,
  google_event_id  TEXT,
  lien_visio       TEXT,
  remplace         TEXT REFERENCES reservations(uid) ON DELETE SET NULL,
  motif_annulation TEXT,
  annulee_le       INTEGER,
  creee_le         INTEGER NOT NULL,
  ip_hachee        TEXT NOT NULL DEFAULT ''
);
-- Deux réservations vivantes ne peuvent pas commencer au même instant, quoi
-- qu'il se passe au-dessus. Cal.com n'a pas cette contrainte.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_debut_actif
  ON reservations(debut) WHERE statut IN ('confirmee', 'en_attente');
CREATE INDEX IF NOT EXISTS reservations_fenetre ON reservations(debut, fin);

CREATE TABLE IF NOT EXISTS rappels (
  id              INTEGER PRIMARY KEY,
  reservation_uid TEXT NOT NULL REFERENCES reservations(uid) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  envoyer_a       INTEGER NOT NULL,
  envoye_le       INTEGER,
  UNIQUE (reservation_uid, type)
);
CREATE INDEX IF NOT EXISTS rappels_dus ON rappels(envoyer_a) WHERE envoye_le IS NULL;

CREATE TABLE IF NOT EXISTS jetons_google (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token    TEXT NOT NULL,
  access_token     TEXT,
  expire_le        INTEGER,
  compte           TEXT,
  autorise_le      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  id              INTEGER PRIMARY KEY,
  le              INTEGER NOT NULL,
  niveau          TEXT NOT NULL,
  message         TEXT NOT NULL,
  reservation_uid TEXT
);
`;

// Un identifiant opaque de 22 caractères, sûr dans une URL.
export function nouvelUid() {
  return randomBytes(16).toString('base64url');
}

export function ouvrir(chemin = ':memory:') {
  const db = new DatabaseSync(chemin);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return new Base(db);
}

export class Base {
  constructor(db) {
    this.db = db;
    this.req = {
      inserer: db.prepare(`INSERT INTO reservations
        (uid, debut, fin, statut, format, nom, email, telephone, message, fuseau, ical_uid, ical_sequence, remplace, creee_le, ip_hachee)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      actives: db.prepare(`SELECT uid, debut, fin FROM reservations
        WHERE statut IN ('confirmee', 'en_attente') AND fin > ? AND debut < ?`),
      activesDetail: db.prepare(`SELECT * FROM reservations
        WHERE statut IN ('confirmee', 'en_attente') AND fin > ? AND debut < ? ORDER BY debut`),
      parUid: db.prepare('SELECT * FROM reservations WHERE uid = ?'),
      annuler: db.prepare(`UPDATE reservations SET statut = 'annulee', motif_annulation = ?, annulee_le = ?,
        ical_sequence = ical_sequence + 1 WHERE uid = ?`),
      google: db.prepare('UPDATE reservations SET google_event_id = ?, lien_visio = ? WHERE uid = ?'),
      statut: db.prepare('UPDATE reservations SET statut = ? WHERE uid = ?'),
      sansGoogle: db.prepare(`SELECT * FROM reservations WHERE statut = 'confirmee' AND google_event_id IS NULL AND debut > ? ORDER BY creee_le LIMIT 20`),
      rappelInserer: db.prepare('INSERT OR IGNORE INTO rappels (reservation_uid, type, envoyer_a) VALUES (?, ?, ?)'),
      rappelsDus: db.prepare(`SELECT r.id, r.type, r.reservation_uid FROM rappels r
        JOIN reservations v ON v.uid = r.reservation_uid
        WHERE r.envoye_le IS NULL AND r.envoyer_a <= ? AND v.statut = 'confirmee' ORDER BY r.envoyer_a LIMIT 50`),
      rappelEnvoye: db.prepare('UPDATE rappels SET envoye_le = ? WHERE id = ?'),
      rappelsSupprimer: db.prepare('DELETE FROM rappels WHERE reservation_uid = ? AND envoye_le IS NULL'),
      journal: db.prepare('INSERT INTO journal (le, niveau, message, reservation_uid) VALUES (?, ?, ?, ?)'),
      jetonLire: db.prepare('SELECT * FROM jetons_google WHERE id = 1'),
      jetonEcrire: db.prepare(`INSERT INTO jetons_google (id, refresh_token, access_token, expire_le, compte, autorise_le)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
          expire_le = excluded.expire_le, compte = excluded.compte, autorise_le = excluded.autorise_le`),
      jetonAcces: db.prepare('UPDATE jetons_google SET access_token = ?, expire_le = ? WHERE id = 1'),
      purger: db.prepare('DELETE FROM reservations WHERE fin < ?'),
      purgerJournal: db.prepare('DELETE FROM journal WHERE le < ?'),
    };
  }

  // Les occupations actives (réservations confirmées ou en attente) qui
  // touchent la fenêtre, sans marges.
  occupations(de, a) {
    return this.req.actives.all(de, a);
  }

  reservationsActives(de, a) {
    return this.req.activesDetail.all(de, a);
  }

  // Nombre de réservations actives par date locale du propriétaire.
  parJour(fuseau, de, a) {
    const m = new Map();
    for (const r of this.req.actives.all(de, a)) {
      const d = dateLocale(fuseau, r.debut);
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  }

  obtenir(uid) {
    return this.req.parUid.get(uid) ?? null;
  }

  // Réserve un créneau, dans une transaction en écriture exclusive.
  //
  // La vérification d'un chevauchement se fait ICI, sous le verrou, avec les
  // mêmes marges que le calcul des créneaux : deux demandes simultanées sur
  // le même créneau se sérialisent, la seconde voit la première et échoue
  // avec CreneauPris. L'index unique sur `debut` est la ceinture en plus des
  // bretelles.
  //
  // Renvoie la réservation créée. Ne parle ni à Google ni aux mails : c'est
  // au serveur de le faire APRÈS, hors transaction.
  reserver({ debut, fin, format, nom, email, telephone = '', message = '', fuseau, ipHachee = '', remplace = null, icalUid = null, icalSequence = 0, statut = 'confirmee', reglages, maintenant = Date.now() }) {
    const margeAvant = (reglages.margeAvant ?? 0) * MINUTE;
    const margeApres = (reglages.margeApres ?? 0) * MINUTE;
    const uid = nouvelUid();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // En cas de déplacement, l'ancienne réservation ne compte pas : elle
      // est annulée dans la même transaction.
      const voisines = this.req.actives.all(debut - JOUR, fin + JOUR).filter((o) => o.uid !== remplace);
      if (!libre(debut, fin, voisines, margeAvant, margeApres)) throw new CreneauPris();
      if (remplace) this.req.annuler.run('deplace', maintenant, remplace);
      try {
        this.req.inserer.run(uid, debut, fin, statut, format, nom, email, telephone, message, fuseau,
          icalUid ?? `${nouvelUid()}@rdv`, icalSequence, remplace, maintenant, ipHachee);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new CreneauPris();
        throw e;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.obtenir(uid);
  }

  // Déplace : nouvelle ligne liée à l'ancienne, ancienne annulée, même
  // identité .ics avec la séquence incrémentée. Tout dans une transaction.
  deplacer(uid, { debut, fin, reglages, maintenant = Date.now() }) {
    const ancienne = this.obtenir(uid);
    if (!ancienne) throw new Introuvable();
    if (ancienne.statut === 'annulee') throw new DejaAnnulee();
    if (ancienne.fin <= maintenant) throw new DejaPassee();
    const nouvelle = this.reserver({
      debut, fin, format: ancienne.format, nom: ancienne.nom, email: ancienne.email,
      telephone: ancienne.telephone, message: ancienne.message, fuseau: ancienne.fuseau,
      ipHachee: ancienne.ip_hachee, remplace: uid, icalUid: ancienne.ical_uid,
      icalSequence: ancienne.ical_sequence + 1, statut: ancienne.statut, reglages, maintenant,
    });
    // L'événement Google suit la réservation : il est modifié en place.
    this.req.google.run(ancienne.google_event_id, ancienne.lien_visio, nouvelle.uid);
    this.req.rappelsSupprimer.run(uid);
    return this.obtenir(nouvelle.uid);
  }

  annuler(uid, motif = '', maintenant = Date.now()) {
    const r = this.obtenir(uid);
    if (!r) throw new Introuvable();
    if (r.statut === 'annulee') throw new DejaAnnulee();
    if (r.fin <= maintenant) throw new DejaPassee();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.req.annuler.run(motif, maintenant, uid);
      this.req.rappelsSupprimer.run(uid);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.obtenir(uid);
  }

  confirmer(uid) {
    this.req.statut.run('confirmee', uid);
    return this.obtenir(uid);
  }

  noterGoogle(uid, eventId, lienVisio = null) {
    this.req.google.run(eventId, lienVisio, uid);
  }

  sansEvenementGoogle(maintenant = Date.now()) {
    return this.req.sansGoogle.all(maintenant);
  }

  // Rappels -----------------------------------------------------------------

  planifierRappels(uid, debut, delaisMinutes, maintenant = Date.now()) {
    for (const d of delaisMinutes) {
      const a = debut - d * MINUTE;
      if (a > maintenant) this.req.rappelInserer.run(uid, `${d}`, a);
    }
  }

  rappelsDus(maintenant = Date.now()) {
    return this.req.rappelsDus.all(maintenant);
  }

  rappelEnvoye(id, maintenant = Date.now()) {
    this.req.rappelEnvoye.run(maintenant, id);
  }

  // Google ------------------------------------------------------------------

  jeton() {
    return this.req.jetonLire.get() ?? null;
  }

  enregistrerJeton({ refreshToken, accessToken = null, expireLe = null, compte = null, maintenant = Date.now() }) {
    this.req.jetonEcrire.run(refreshToken, accessToken, expireLe, compte, maintenant);
  }

  rafraichirAcces(accessToken, expireLe) {
    this.req.jetonAcces.run(accessToken, expireLe);
  }

  // Journal et purge --------------------------------------------------------

  journal(niveau, message, uid = null, maintenant = Date.now()) {
    this.req.journal.run(maintenant, niveau, String(message).slice(0, 2000), uid);
  }

  // Supprime les réservations terminées depuis plus de `conservationJours`,
  // leurs rappels, et le journal plus vieux que la même durée.
  purger(conservationJours, maintenant = Date.now()) {
    const seuil = maintenant - conservationJours * JOUR;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const n = this.req.purger.run(seuil).changes;
      this.req.purgerJournal.run(seuil);
      this.db.exec('COMMIT');
      return n;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  fermer() {
    this.db.close();
  }
}
