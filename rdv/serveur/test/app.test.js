import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creerApplication } from '../app.js';
import { lireEnv } from '../config.js';

const H = 3_600_000;
const MIN = 60_000;

// Samedi 5 septembre 2026, 8 h à La Réunion. Les créneaux commencent lundi.
let horloge = Date.parse('2026-09-05T04:00:00Z');
const lundi9h = '2026-09-07T05:00:00.000Z';

let app, url, dossier;

before(async () => {
  dossier = mkdtempSync(join(tmpdir(), 'rdv-app-'));
  writeFileSync(join(dossier, 'reglages.json'), JSON.stringify({ preavisMinutes: 60, exceptions: [{ date: '2026-09-09', plages: [] }] }));
  const env = lireEnv({
    PORT: '0', DONNEES: dossier, URL_PUBLIQUE: 'http://rdv.test', SITE_ORIGINES: 'https://site.test',
    PROPRIETAIRE_NOM: 'Loïc', PROPRIETAIRE_EMAIL: 'loic@example.re', CLE_ADMIN: 'secret',
  });
  app = creerApplication(env, { maintenant: () => horloge, limites: { ecriture: 1000 } });
  await new Promise((r) => app.serveur.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.serveur.address().port}`;
});

after(async () => {
  await new Promise((r) => app.serveur.close(r));
  app.base.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

const get = (chemin, entetes = {}) => fetch(url + chemin, { headers: entetes });
const post = (chemin, corps, entetes = {}) => fetch(url + chemin, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...entetes }, body: JSON.stringify(corps),
});
const visiteur = { debut: lundi9h, format: 'visio', nom: 'Marie Payet', email: 'Marie@Example.re', telephone: '0692', message: 'Bonjour', fuseau: 'Europe/Paris' };

test('santé : Google débranché, SMTP absent', async () => {
  const r = await get('/sante');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, google: 'debranche', smtp: false });
});

test('les créneaux respectent les réglages du fichier', async () => {
  const r = await get('/api/creneaux?de=2026-09-06T20:00:00Z&a=2026-09-10T20:00:00Z');
  assert.equal(r.status, 200);
  const { creneaux, duree, fuseau } = await r.json();
  assert.equal(duree, 30);
  assert.equal(fuseau, 'Indian/Reunion');
  assert.equal(creneaux[0], lundi9h);
  // Lundi, mardi, jeudi : 12 chacun ; mercredi fermé par exception.
  assert.equal(creneaux.length, 36);
  assert.ok(!creneaux.some((c) => c.startsWith('2026-09-09')));
});

test('la page autonome et la brique sont servies', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-rdv=""/);
  assert.equal((await get('/rdv.js')).status, 200);
  assert.equal((await get('/rdv.css')).headers.get('content-type'), 'text/css; charset=utf-8');
});

test('réserver : validation des champs', async () => {
  for (const [corps, type] of [
    [{ ...visiteur, debut: 'pas une date' }, 'date_invalide'],
    [{ ...visiteur, format: 'pigeon' }, 'format_invalide'],
    [{ ...visiteur, nom: '' }, 'champ_manquant'],
    [{ ...visiteur, email: 'nope' }, 'email_invalide'],
    [{ ...visiteur, format: 'telephone', telephone: '' }, 'champ_manquant'],
    [{ ...visiteur, message: 'x'.repeat(2001) }, 'champ_trop_long'],
    [{ ...visiteur, debut: '2026-09-07T05:10:00Z' }, 'creneau_indisponible'],
    [{ ...visiteur, debut: '2026-09-06T05:00:00Z' }, 'creneau_indisponible'],
  ]) {
    const r = await post('/api/reservations', corps);
    const j = await r.json();
    assert.equal(j.erreur, type, `${JSON.stringify(corps)} → ${JSON.stringify(j)}`);
  }
});

test('réserver : succès, puis le créneau disparaît, puis conflit', async () => {
  const r = await post('/api/reservations', visiteur, { Origin: 'https://site.test' });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://site.test');
  const j = await r.json();
  assert.equal(j.uid.length, 22);
  assert.equal(j.url, `http://rdv.test/r/${j.uid}`);
  assert.equal(j.debut, lundi9h);

  const liste = await (await get('/api/creneaux?de=2026-09-06T20:00:00Z&a=2026-09-07T20:00:00Z')).json();
  // 9 h pris, 9 h 30 dans la marge : dix restent.
  assert.equal(liste.creneaux.length, 10);
  assert.ok(!liste.creneaux.includes(lundi9h));

  const conflit = await post('/api/reservations', visiteur);
  assert.equal(conflit.status, 409);
  assert.equal((await conflit.json()).erreur, 'creneau_indisponible');

  // Ce qui a été stocké : e-mail en minuscules, fuseau du visiteur, rappels.
  const stock = app.base.obtenir(j.uid);
  assert.equal(stock.email, 'marie@example.re');
  assert.equal(stock.fuseau, 'Europe/Paris');
  assert.equal(stock.statut, 'confirmee');
  assert.equal(app.base.db.prepare('SELECT count(*) AS n FROM rappels WHERE reservation_uid = ?').get(j.uid).n, 2);
  // Les mails ont été journalisés, faute de SMTP.
  const mails = app.base.db.prepare("SELECT message FROM journal WHERE reservation_uid = ? AND message LIKE '%mail non envoyé%'").all(j.uid);
  assert.equal(mails.length, 2);
  assert.match(mails[0].message, /Marie Payet <marie@example.re>/);
  assert.match(mails[1].message, /loic@example.re/);
});

test('le pot de miel renvoie un faux succès sans rien créer', async () => {
  const avant = app.base.db.prepare('SELECT count(*) AS n FROM reservations').get().n;
  const r = await post('/api/reservations', { ...visiteur, debut: '2026-09-07T07:00:00Z', 'ne-pas-remplir': 'ACME' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).uid, 'ok');
  assert.equal(app.base.db.prepare('SELECT count(*) AS n FROM reservations').get().n, avant);
});

test('une origine inconnue est refusée en écriture, acceptée en lecture', async () => {
  const r = await post('/api/reservations', { ...visiteur, debut: '2026-09-07T07:00:00Z' }, { Origin: 'https://pirate.test' });
  assert.equal(r.status, 403);
  const l = await get('/api/creneaux', { Origin: 'https://pirate.test' });
  assert.equal(l.status, 200);
  assert.equal(l.headers.get('access-control-allow-origin'), null);
});

test('la page du rendez-vous, son déplacement et son annulation', async () => {
  const r = await (await post('/api/reservations', { ...visiteur, debut: '2026-09-07T07:00:00Z', format: 'telephone', telephone: '0692 00 00 00' })).json();
  const page = await get(`/r/${r.uid}`, { Accept: 'text/html' });
  assert.equal(page.status, 200);
  const texte = await page.text();
  assert.match(texte, /Confirmé/);
  assert.match(texte, /lundi 7 septembre 2026, 09 h 00 – 09 h 30 \(heure d’été d’Europe centrale\)/); // 11 h à La Réunion, affiché dans le fuseau du visiteur
  assert.match(texte, /Loïc vous appelle au 0692 00 00 00/);
  assert.match(texte, new RegExp(`data-rdv-deplacer="${r.uid}"`));

  // Les créneaux « sauf » le sien : 11 h (celui-ci) reste proposable pour lui.
  const sauf = await (await get(`/api/creneaux?de=2026-09-06T20:00:00Z&a=2026-09-07T20:00:00Z&sauf=${r.uid}`)).json();
  assert.ok(sauf.creneaux.includes('2026-09-07T07:00:00.000Z'));

  // Déplacement à 15 h locale (11 h UTC).
  const d = await post(`/api/reservations/${r.uid}/deplacement`, { debut: '2026-09-07T11:00:00Z' });
  assert.equal(d.status, 200);
  const nouvelle = await d.json();
  assert.notEqual(nouvelle.uid, r.uid);
  assert.equal(app.base.obtenir(r.uid).statut, 'annulee');
  assert.equal(app.base.obtenir(nouvelle.uid).ical_sequence, 1);

  // L'ancienne page dit « Annulé », sans formulaire.
  const ancienne = await (await get(`/r/${r.uid}`, { Accept: 'text/html' })).text();
  assert.match(ancienne, /class="annulee"/);

  // Annulation de la nouvelle par formulaire, sans JavaScript.
  const a = await fetch(`${url}/r/${nouvelle.uid}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: 'action=annuler&motif=emp%C3%AAchement',
  });
  assert.equal(a.status, 200);
  assert.match(await a.text(), /Votre rendez-vous est annulé/);
  const s = app.base.obtenir(nouvelle.uid);
  assert.equal(s.statut, 'annulee');
  assert.equal(s.motif_annulation, 'empêchement');

  // Une seconde annulation par l'API répond 409.
  const encore = await post(`/api/reservations/${nouvelle.uid}/annulation`, {});
  assert.equal(encore.status, 409);
});

test('un lien inconnu répond 404 en HTML', async () => {
  const r = await get('/r/AAAAAAAAAAAAAAAAAAAAAA', { Accept: 'text/html' });
  assert.equal(r.status, 404);
  assert.match(await r.text(), /introuvable/);
});

test('la connexion Google exige la clé', async () => {
  assert.equal((await get('/google/connexion')).status, 403);
  assert.equal((await get('/google/connexion?cle=secret')).status, 500); // pas d'identifiants Google
});

test('les tâches de fond envoient les rappels dus', async () => {
  const r = await (await post('/api/reservations', { ...visiteur, debut: '2026-09-08T05:00:00Z' })).json();
  horloge = Date.parse('2026-09-08T05:00:00Z') - 50 * MIN;
  await app.tachesDeFond();
  const envoyes = app.base.db.prepare('SELECT type, envoye_le FROM rappels WHERE reservation_uid = ? ORDER BY type').all(r.uid);
  assert.deepEqual(envoyes.map((x) => [x.type, x.envoye_le !== null]), [['1440', true], ['60', true]]);
  const rappel = app.base.db.prepare("SELECT message FROM journal WHERE reservation_uid = ? AND message LIKE '%Rappel%'").all(r.uid);
  assert.equal(rappel.length, 2);
  horloge = Date.parse('2026-09-05T04:00:00Z');
});

test('les réglages se rechargent sans redémarrer', async () => {
  writeFileSync(join(dossier, 'reglages.json'), JSON.stringify({ duree: 45, preavisMinutes: 60 }));
  app.rechargerReglages();
  const { duree } = await (await get('/api/reglages')).json();
  assert.equal(duree, 45);
  writeFileSync(join(dossier, 'reglages.json'), JSON.stringify({ fuseau: 'Nulle/Part' }));
  assert.throws(() => app.rechargerReglages(), /Fuseau inconnu/);
  assert.equal(app.reglages().duree, 45); // les anciens réglages restent en place
});

test('la limite de demandes par adresse', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'rdv-lim-'));
  const app2 = creerApplication(lireEnv({ DONNEES: d2, URL_PUBLIQUE: 'http://rdv.test' }), { maintenant: () => horloge, limites: { ecriture: 3 } });
  await new Promise((r) => app2.serveur.listen(0, '127.0.0.1', r));
  const u2 = `http://127.0.0.1:${app2.serveur.address().port}`;
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${u2}/api/reservations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...visiteur, nom: '' }) });
    codes.push(r.status);
  }
  assert.deepEqual(codes, [400, 400, 400, 429]);
  await new Promise((r) => app2.serveur.close(r));
  app2.base.fermer();
  rmSync(d2, { recursive: true, force: true });
});
