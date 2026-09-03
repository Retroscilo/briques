import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculerCreneaux, dateLocale, decalage, estProposable, instantLocal, plagesProprietaire,
} from '../creneaux.js';

const H = 3_600_000;
const MIN = 60_000;
const utc = (s) => Date.parse(s);

// Un propriétaire à La Réunion (UTC+4, pas d'heure d'été), lundi–vendredi,
// 9 h–12 h et 14 h–17 h, rendez-vous de 30 min, marges de 15 min.
const reunion = {
  fuseau: 'Indian/Reunion',
  duree: 30, pas: 30, margeAvant: 15, margeApres: 15,
  preavisMinutes: 24 * 60, horizonJours: 30, maxParJour: 4,
  horaires: [
    { jours: [1, 2, 3, 4, 5], debut: '09:00', fin: '12:00' },
    { jours: [1, 2, 3, 4, 5], debut: '14:00', fin: '17:00' },
  ],
  exceptions: [],
};

// Lundi 7 septembre 2026, vu un samedi matin : le préavis ne coupe rien.
const samedi = utc('2026-09-05T04:00:00Z');
const lundi = { de: utc('2026-09-06T20:00:00Z'), a: utc('2026-09-07T20:00:00Z') };

const local = (heure, date = '2026-09-07') => instantLocal('Indian/Reunion', date, heure);
const heures = (creneaux, fuseau = 'Indian/Reunion') => creneaux.map((c) => {
  const f = new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(c);
});

test('décalage et date locale', () => {
  assert.equal(decalage('Indian/Reunion', utc('2026-09-07T05:00:00Z')), 4 * H);
  assert.equal(decalage('Europe/Paris', utc('2026-07-01T12:00:00Z')), 2 * H);
  assert.equal(decalage('Europe/Paris', utc('2026-01-01T12:00:00Z')), 1 * H);
  // 22 h UTC un dimanche = 2 h du matin lundi à La Réunion.
  assert.equal(dateLocale('Indian/Reunion', utc('2026-09-06T22:00:00Z')), '2026-09-07');
});

test('instant local : cas simple et « 24:00 »', () => {
  assert.equal(local('09:00'), utc('2026-09-07T05:00:00Z'));
  assert.equal(local('24:00'), utc('2026-09-07T20:00:00Z'));
});

test('instant local aux deux bascules d’heure à Paris', () => {
  // Dimanche 29 mars 2026 : 2 h → 3 h. 9 h locales = 7 h UTC (CEST).
  assert.equal(instantLocal('Europe/Paris', '2026-03-29', '09:00'), utc('2026-03-29T07:00:00Z'));
  // La veille, 9 h locales = 8 h UTC (CET).
  assert.equal(instantLocal('Europe/Paris', '2026-03-28', '09:00'), utc('2026-03-28T08:00:00Z'));
  // 2 h 30 n'existe pas ce jour-là : on obtient l'instant juste après le saut.
  assert.equal(instantLocal('Europe/Paris', '2026-03-29', '02:30'), utc('2026-03-29T01:30:00Z'));
  // Dimanche 25 octobre 2026 : 3 h → 2 h. 9 h locales = 8 h UTC (CET).
  assert.equal(instantLocal('Europe/Paris', '2026-10-25', '09:00'), utc('2026-10-25T08:00:00Z'));
  // Minuit local ce jour-là, la journée dure 25 h.
  assert.equal(
    instantLocal('Europe/Paris', '2026-10-26', '00:00') - instantLocal('Europe/Paris', '2026-10-25', '00:00'),
    25 * H,
  );
});

test('une journée ordinaire : douze créneaux alignés sur les plages', () => {
  const c = calculerCreneaux({ reglages: reunion, maintenant: samedi, ...lundi });
  assert.deepEqual(heures(c), [
    '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
    '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  ]);
  assert.equal(c[0], utc('2026-09-07T05:00:00Z'));
});

test('le préavis de 24 h retire les créneaux trop proches', () => {
  // Lundi 7 h locale : tout le lundi passe sous les 24 h, le mardi reste.
  const maintenant = local('07:00');
  const c = calculerCreneaux({
    reglages: reunion, maintenant,
    de: maintenant, a: utc('2026-09-08T20:00:00Z'),
  });
  assert.equal(dateLocale('Indian/Reunion', c[0]), '2026-09-08');
  assert.equal(c.length, 12);
});

test('l’horizon borne la fenêtre', () => {
  const c = calculerCreneaux({
    reglages: { ...reunion, horizonJours: 2 }, maintenant: samedi,
    de: samedi, a: samedi + 60 * 24 * H,
  });
  // Samedi + 2 jours = lundi 8 h locale : seuls les créneaux d'avant restent... aucun,
  // car ils finiraient après la borne ou sont avant le préavis. Vérifions la borne exacte.
  for (const t of c) assert.ok(t + 30 * MIN <= samedi + 2 * 24 * H);
});

test('une plage qui commence à 9 h 30 propose 9 h 30 en premier', () => {
  const reglages = { ...reunion, horaires: [{ jours: [1], debut: '09:30', fin: '11:00' }] };
  const c = calculerCreneaux({ reglages, maintenant: samedi, ...lundi });
  assert.deepEqual(heures(c), ['09:30', '10:00', '10:30']);
});

test('une exception ferme le jour, une autre ouvre un samedi', () => {
  const reglages = {
    ...reunion,
    exceptions: [
      { date: '2026-09-07', plages: [] },
      { date: '2026-09-12', plages: [{ debut: '10:00', fin: '11:00' }] },
    ],
  };
  assert.deepEqual(calculerCreneaux({ reglages, maintenant: samedi, ...lundi }), []);
  const c = calculerCreneaux({
    reglages, maintenant: samedi,
    de: utc('2026-09-11T20:00:00Z'), a: utc('2026-09-12T20:00:00Z'),
  });
  assert.deepEqual(heures(c), ['10:00', '10:30']);
});

test('une occupation courte bloque, marges comprises, trois créneaux', () => {
  // Occupé de 10 h 00 à 10 h 20. Avec 15 min de marge de chaque côté :
  // 9 h 30 (finit 10 h, il faudrait 10 h 15 libre), 10 h, 10 h 30 (il faudrait
  // 10 h 15 libre avant, or c'est occupé jusqu'à 10 h 20) tombent ; 11 h reste.
  const occupations = [{ debut: local('10:00'), fin: local('10:20') }];
  const c = calculerCreneaux({ reglages: reunion, maintenant: samedi, ...lundi, occupations });
  assert.deepEqual(heures(c).slice(0, 4), ['09:00', '11:00', '11:30', '14:00']);
});

test('une occupation à cheval sur deux plages', () => {
  const occupations = [{ debut: local('11:30'), fin: local('14:30') }];
  const c = calculerCreneaux({ reglages: reunion, maintenant: samedi, ...lundi, occupations });
  assert.deepEqual(heures(c), ['09:00', '09:30', '10:00', '10:30', '15:00', '15:30', '16:00', '16:30']);
});

test('une occupation Google qui finit à 10 h 07 garde des heures rondes', () => {
  const occupations = [{ debut: local('09:00'), fin: local('10:07') }];
  const c = calculerCreneaux({ reglages: reunion, maintenant: samedi, ...lundi, occupations });
  assert.deepEqual(heures(c).slice(0, 3), ['10:30', '11:00', '11:30']);
});

test('sans marges, les créneaux se collent à l’occupation', () => {
  const reglages = { ...reunion, margeAvant: 0, margeApres: 0 };
  const occupations = [{ debut: local('10:00'), fin: local('10:30') }];
  const c = calculerCreneaux({ reglages, maintenant: samedi, ...lundi, occupations });
  assert.deepEqual(heures(c).slice(0, 4), ['09:00', '09:30', '10:30', '11:00']);
});

test('le plafond quotidien retire la journée', () => {
  const parJour = new Map([['2026-09-07', 4]]);
  assert.deepEqual(calculerCreneaux({ reglages: reunion, maintenant: samedi, ...lundi, parJour }), []);
  parJour.set('2026-09-07', 3);
  assert.equal(calculerCreneaux({ reglages: reunion, maintenant: samedi, ...lundi, parJour }).length, 12);
});

test('un propriétaire à Paris, le jour du passage à l’heure d’été', () => {
  const paris = {
    ...reunion, fuseau: 'Europe/Paris',
    horaires: [{ jours: [0, 6], debut: '09:00', fin: '11:00' }],
  };
  const maintenant = utc('2026-03-20T12:00:00Z');
  const c = calculerCreneaux({
    reglages: paris, maintenant,
    de: utc('2026-03-27T22:00:00Z'), a: utc('2026-03-29T22:00:00Z'),
  });
  assert.deepEqual(c.map((t) => new Date(t).toISOString()), [
    '2026-03-28T08:00:00.000Z', '2026-03-28T08:30:00.000Z', '2026-03-28T09:00:00.000Z', '2026-03-28T09:30:00.000Z',
    '2026-03-29T07:00:00.000Z', '2026-03-29T07:30:00.000Z', '2026-03-29T08:00:00.000Z', '2026-03-29T08:30:00.000Z',
  ]);
  assert.deepEqual(heures(c, 'Europe/Paris'), ['09:00', '09:30', '10:00', '10:30', '09:00', '09:30', '10:00', '10:30']);
});

test('un propriétaire à Paris, le jour du retour à l’heure d’hiver', () => {
  const paris = {
    ...reunion, fuseau: 'Europe/Paris',
    horaires: [{ jours: [0], debut: '09:00', fin: '10:00' }],
  };
  const c = calculerCreneaux({
    reglages: paris, maintenant: utc('2026-10-20T12:00:00Z'),
    de: utc('2026-10-24T22:00:00Z'), a: utc('2026-10-25T22:00:00Z'),
  });
  assert.deepEqual(c.map((t) => new Date(t).toISOString()), ['2026-10-25T08:00:00.000Z', '2026-10-25T08:30:00.000Z']);
});

test('une plage qui déborde sur le lendemain en UTC est vue', () => {
  // À Auckland (UTC+12 ou +13), lundi 9 h locale = dimanche 20 h UTC.
  const auckland = { ...reunion, fuseau: 'Pacific/Auckland', horaires: [{ jours: [1], debut: '09:00', fin: '10:00' }] };
  const plages = plagesProprietaire(auckland, utc('2026-09-06T19:00:00Z'), utc('2026-09-06T23:00:00Z'));
  assert.equal(plages.length, 1);
  assert.equal(plages[0].date, '2026-09-07');
  assert.equal(plages[0].debut, utc('2026-09-06T21:00:00Z'));
});

test('estProposable ne fait confiance à rien', () => {
  const args = { reglages: reunion, maintenant: samedi };
  assert.equal(estProposable(local('09:00'), args), true);
  assert.equal(estProposable(local('09:10'), args), false);
  assert.equal(estProposable(local('12:00'), args), false);
  assert.equal(estProposable(local('09:00', '2026-09-06'), args), false); // dimanche
  assert.equal(estProposable(local('09:00'), { ...args, occupations: [{ debut: local('09:00'), fin: local('09:30') }] }), false);
});
