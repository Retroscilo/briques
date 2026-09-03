import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ouvrir, CreneauPris, DejaAnnulee, DejaPassee, Introuvable } from '../base.js';

const MIN = 60_000;
const H = 3_600_000;
const JOUR = 24 * H;

const reglages = { fuseau: 'Indian/Reunion', duree: 30, margeAvant: 15, margeApres: 15 };
const maintenant = Date.parse('2026-09-05T04:00:00Z');
const t0 = Date.parse('2026-09-07T05:00:00Z'); // lundi 9 h à La Réunion

const visiteur = {
  format: 'visio', nom: 'Marie Payet', email: 'marie@example.re', telephone: '+262692000000',
  fuseau: 'Indian/Reunion', reglages, maintenant,
};

const reserver = (base, debut, extra = {}) => base.reserver({ ...visiteur, debut, fin: debut + 30 * MIN, ...extra });

test('réserver, relire, uid opaque', () => {
  const base = ouvrir();
  const r = reserver(base, t0);
  assert.equal(r.uid.length, 22);
  assert.equal(r.statut, 'confirmee');
  assert.equal(r.ical_sequence, 0);
  assert.match(r.ical_uid, /@rdv$/);
  assert.deepEqual(base.occupations(t0 - JOUR, t0 + JOUR).map((o) => [o.debut, o.fin]), [[t0, t0 + 30 * MIN]]);
});

test('le même créneau deux fois : la seconde échoue', () => {
  const base = ouvrir();
  reserver(base, t0);
  assert.throws(() => reserver(base, t0), CreneauPris);
  assert.equal(base.occupations(0, Infinity).length, 1);
});

test('un créneau dans la marge est refusé, hors marge accepté', () => {
  const base = ouvrir();
  reserver(base, t0);
  // 9 h 30 : commence 0 min après la fin, il en faut 15.
  assert.throws(() => reserver(base, t0 + 30 * MIN), CreneauPris);
  // 8 h 15 : finit à 8 h 45, il faut 15 min avant 9 h → juste bon.
  reserver(base, t0 - 45 * MIN);
  // 9 h 45 : commence 15 min après 9 h 30 → juste bon.
  reserver(base, t0 + 45 * MIN);
  assert.equal(base.occupations(0, Infinity).length, 3);
});

test('l’index unique tient même sans vérification applicative', () => {
  const base = ouvrir();
  reserver(base, t0);
  assert.throws(() => base.req.inserer.run('x'.repeat(22), t0, t0 + 30 * MIN, 'confirmee', 'visio', 'a', 'b', '', '', 'UTC', 'u', 0, null, 0, ''), /UNIQUE/);
});

test('une réservation annulée libère le créneau', () => {
  const base = ouvrir();
  const r = reserver(base, t0);
  const a = base.annuler(r.uid, 'empêchement', maintenant);
  assert.equal(a.statut, 'annulee');
  assert.equal(a.ical_sequence, 1);
  assert.equal(a.motif_annulation, 'empêchement');
  reserver(base, t0);
  assert.throws(() => base.annuler(r.uid, '', maintenant), DejaAnnulee);
  assert.throws(() => base.annuler('inconnu', '', maintenant), Introuvable);
});

test('un rendez-vous passé ne s’annule plus', () => {
  const base = ouvrir();
  const r = reserver(base, t0);
  assert.throws(() => base.annuler(r.uid, '', t0 + H), DejaPassee);
});

test('déplacer : nouvelle ligne, ancienne annulée, même identité .ics', () => {
  const base = ouvrir();
  const r = reserver(base, t0);
  base.noterGoogle(r.uid, 'evt123', 'https://meet.google.com/abc');
  base.planifierRappels(r.uid, t0, [24 * 60, 60], maintenant);
  const n = base.deplacer(r.uid, { debut: t0 + 2 * H, fin: t0 + 2 * H + 30 * MIN, reglages, maintenant });
  assert.equal(n.remplace, r.uid);
  assert.equal(n.ical_uid, r.ical_uid);
  assert.equal(n.ical_sequence, 1);
  assert.equal(n.google_event_id, 'evt123');
  assert.equal(n.lien_visio, 'https://meet.google.com/abc');
  assert.equal(base.obtenir(r.uid).statut, 'annulee');
  // Les rappels de l'ancienne sont partis, et le créneau initial est libre.
  assert.equal(base.rappelsDus(t0).length, 0);
  reserver(base, t0);
});

test('déplacer sur son propre créneau ne se bloque pas soi-même', () => {
  const base = ouvrir();
  const r = reserver(base, t0);
  // Décalage de 15 min : chevauche l'ancienne, qui ne doit pas compter.
  const n = base.deplacer(r.uid, { debut: t0 + 15 * MIN, fin: t0 + 45 * MIN, reglages, maintenant });
  assert.equal(n.debut, t0 + 15 * MIN);
});

test('rappels : planifiés, dus, envoyés, supprimés à l’annulation', () => {
  const base = ouvrir();
  const r = reserver(base, t0);
  base.planifierRappels(r.uid, t0, [24 * 60, 60], maintenant);
  assert.equal(base.rappelsDus(maintenant).length, 0);
  const dus = base.rappelsDus(t0 - 23 * H);
  assert.equal(dus.length, 1);
  assert.equal(dus[0].type, '1440');
  base.rappelEnvoye(dus[0].id, t0 - 23 * H);
  assert.equal(base.rappelsDus(t0 - 23 * H).length, 0);
  assert.equal(base.rappelsDus(t0 - 30 * MIN).length, 1);
  base.annuler(r.uid, '', t0 - 30 * MIN);
  assert.equal(base.rappelsDus(t0 - 30 * MIN).length, 0);
});

test('un rappel dont l’heure est déjà passée n’est pas planifié', () => {
  const base = ouvrir();
  const r = reserver(base, t0, { maintenant: t0 - 2 * H });
  base.planifierRappels(r.uid, t0, [24 * 60, 60], t0 - 2 * H);
  assert.deepEqual(base.rappelsDus(t0).map((x) => x.type), ['60']);
});

test('comptage par jour local, réservations en attente comprises', () => {
  const base = ouvrir();
  reserver(base, t0);
  reserver(base, t0 + 2 * H, { statut: 'en_attente' });
  reserver(base, t0 + JOUR);
  const m = base.parJour('Indian/Reunion', t0 - JOUR, t0 + 3 * JOUR);
  assert.equal(m.get('2026-09-07'), 2);
  assert.equal(m.get('2026-09-08'), 1);
});

test('jeton Google : écrire, relire, rafraîchir', () => {
  const base = ouvrir();
  assert.equal(base.jeton(), null);
  base.enregistrerJeton({ refreshToken: 'r1', compte: 'x@gmail.com', maintenant });
  base.rafraichirAcces('a1', maintenant + H);
  assert.equal(base.jeton().refresh_token, 'r1');
  assert.equal(base.jeton().access_token, 'a1');
  base.enregistrerJeton({ refreshToken: 'r2', maintenant });
  assert.equal(base.jeton().refresh_token, 'r2');
});

test('purge : les réservations anciennes partent avec leurs rappels', () => {
  const base = ouvrir();
  const vieille = reserver(base, t0);
  base.planifierRappels(vieille.uid, t0, [60], maintenant);
  const recente = reserver(base, t0 + 400 * JOUR);
  base.journal('info', 'test', vieille.uid, maintenant);
  const n = base.purger(365, t0 + 400 * JOUR);
  assert.equal(n, 1);
  assert.equal(base.obtenir(vieille.uid), null);
  assert.ok(base.obtenir(recente.uid));
  assert.equal(base.db.prepare('SELECT count(*) AS n FROM rappels').get().n, 0);
  assert.equal(base.db.prepare('SELECT count(*) AS n FROM journal').get().n, 0);
});

test('purge : une réservation qui en remplace une purgée garde sa ligne', () => {
  const base = ouvrir();
  const r = reserver(base, t0);
  const n = base.deplacer(r.uid, { debut: t0 + 400 * JOUR, fin: t0 + 400 * JOUR + 30 * MIN, reglages, maintenant });
  base.purger(365, t0 + 380 * JOUR);
  assert.equal(base.obtenir(r.uid), null);
  assert.equal(base.obtenir(n.uid).remplace, null);
});

test('ouvrir deux fois le même fichier ne recrée rien', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dossier = mkdtempSync(join(tmpdir(), 'rdv-'));
  const chemin = join(dossier, 'rdv.sqlite');
  const b1 = ouvrir(chemin);
  reserver(b1, t0);
  b1.fermer();
  const b2 = ouvrir(chemin);
  assert.equal(b2.occupations(0, Infinity).length, 1);
  b2.fermer();
  rmSync(dossier, { recursive: true, force: true });
});
