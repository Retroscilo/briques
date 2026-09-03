// Calcul des créneaux libres. Pur : aucune lecture de fichier, aucun réseau,
// aucune horloge. Tout ce qu'il faut entre par les arguments, ce qui rend le
// module testable sur des dates fixes.
//
// Convention : tous les instants sont des entiers, millisecondes UTC. Le
// fuseau du propriétaire n'intervient que pour transformer ses horaires
// locaux (« lundi 9 h ») en instants. Le fuseau du visiteur n'intervient pas
// du tout : il regroupe et formate côté navigateur.

const MINUTE = 60_000;
const JOUR = 86_400_000;

// ---------------------------------------------------------------------------
// Fuseaux, sans bibliothèque.
// ---------------------------------------------------------------------------

const formateurs = new Map();

function formateur(fuseau) {
  let f = formateurs.get(fuseau);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuseau,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formateurs.set(fuseau, f);
  }
  return f;
}

// Les composantes locales (année, mois, jour, heure, minute, seconde) d'un
// instant dans un fuseau.
function composantes(fuseau, instant) {
  const p = {};
  for (const { type, value } of formateur(fuseau).formatToParts(instant)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return p;
}

// Décalage du fuseau à cet instant, en millisecondes (positif à l'est).
export function decalage(fuseau, instant) {
  const c = composantes(fuseau, instant);
  const commeUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  // Le formateur tronque à la seconde ; on tronque l'instant de même.
  return commeUtc - Math.floor(instant / 1000) * 1000;
}

// La date locale « AAAA-MM-JJ » d'un instant dans un fuseau.
export function dateLocale(fuseau, instant) {
  const c = composantes(fuseau, instant);
  return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
}

// L'instant correspondant à une date et une heure locales dans un fuseau.
// « 24:00 » est accepté et signifie minuit le jour suivant.
//
// Méthode : on suppose d'abord le décalage en vigueur à l'instant « naïf »
// (les composantes lues comme si elles étaient UTC), puis on vérifie que le
// décalage à l'instant obtenu est le même. S'il diffère, on est sur un jour
// de changement d'heure et on recalcule avec le second décalage. Pour une
// heure locale qui n'existe pas (le saut de printemps), on obtient l'instant
// juste après le saut, ce qui est le comportement des agendas courants.
export function instantLocal(fuseau, date, heure) {
  const [a, m, j] = date.split('-').map(Number);
  const [h, mn] = heure.split(':').map(Number);
  const naif = Date.UTC(a, m - 1, j, h, mn);
  const d1 = decalage(fuseau, naif);
  const essai = naif - d1;
  const d2 = decalage(fuseau, essai);
  if (d1 === d2) return essai;
  const essai2 = naif - d2;
  return decalage(fuseau, essai2) === d2 ? essai2 : Math.max(essai, essai2);
}

// Le jour de la semaine (0 = dimanche … 6 = samedi) d'une date « AAAA-MM-JJ ».
export function jourSemaine(date) {
  const [a, m, j] = date.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, j)).getUTCDay();
}

// La date locale suivante. On avance de 36 h à partir de midi local pour ne
// jamais retomber sur le même jour, quel que soit le changement d'heure.
export function dateSuivante(fuseau, date) {
  return dateLocale(fuseau, instantLocal(fuseau, date, '12:00') + JOUR);
}

// ---------------------------------------------------------------------------
// Les plages du propriétaire.
// ---------------------------------------------------------------------------

// Les plages ouvertes, en instants UTC, pour chaque date locale du
// propriétaire entre `de` et `a` inclus. Une exception datée remplace toute
// la journée ; une exception avec `plages: []` ferme le jour.
//
// reglages.horaires : [{ jours: [1,2,3,4,5], debut: '09:00', fin: '12:00' }]
// reglages.exceptions : [{ date: '2026-12-25', plages: [] },
//                        { date: '2026-09-12', plages: [{ debut, fin }] }]
export function plagesProprietaire(reglages, de, a) {
  const { fuseau } = reglages;
  const exceptions = new Map((reglages.exceptions ?? []).map((e) => [e.date, e.plages ?? []]));
  const resultat = [];
  const derniere = dateLocale(fuseau, a);
  // On part de la veille de `de` : une plage locale peut avoir commencé la
  // veille en UTC (fuseaux à l'est) et n'être pas encore finie.
  let date = dateLocale(fuseau, de - JOUR);
  for (let garde = 0; garde < 400; garde++) {
    const js = jourSemaine(date);
    const plages = exceptions.has(date)
      ? exceptions.get(date)
      : reglages.horaires.filter((h) => h.jours.includes(js));
    for (const p of plages) {
      const debut = instantLocal(fuseau, date, p.debut);
      const fin = instantLocal(fuseau, date, p.fin);
      if (fin > debut) resultat.push({ debut, fin, date });
    }
    if (date === derniere) break;
    date = dateSuivante(fuseau, date);
  }
  return resultat;
}

// ---------------------------------------------------------------------------
// Les créneaux.
// ---------------------------------------------------------------------------

// Vrai si un créneau [debut, fin[ est compatible avec toutes les occupations.
//
// Les marges se lisent du point de vue du NOUVEAU rendez-vous : il lui faut
// `margeAvant` minutes libres avant son début et `margeApres` après sa fin.
// Une occupation [s, e[ bloque donc tout créneau qui touche [s − margeApres,
// e + margeAvant[.
export function libre(debut, fin, occupations, margeAvant, margeApres) {
  for (const o of occupations) {
    if (o.debut - margeApres < fin && o.fin + margeAvant > debut) return false;
  }
  return true;
}

// Les créneaux proposables.
//
//   reglages      : fuseau, duree, pas, margeAvant, margeApres (minutes),
//                   preavisMinutes, horizonJours, maxParJour, horaires,
//                   exceptions
//   maintenant    : l'instant de référence (ms UTC)
//   de, a         : la fenêtre demandée (ms UTC) ; elle est bornée au préavis
//                   et à l'horizon
//   occupations   : [{ debut, fin }] ms UTC — réservations actives et
//                   occupations Google, SANS marges (elles sont appliquées ici)
//   parJour       : Map date locale → nombre de réservations actives ce jour
//
// Renvoie la liste triée des instants de début, en ms UTC.
//
// Les candidats sont alignés sur le DÉBUT DE LA PLAGE, tous les `pas`
// minutes, puis filtrés : c'est ce qui donne 9 h 30, 10 h, 10 h 30 quand la
// plage commence à 9 h 30, et qui garde des heures rondes même quand une
// occupation Google se termine à 10 h 07.
export function calculerCreneaux({ reglages, maintenant, de, a, occupations = [], parJour = new Map() }) {
  const duree = reglages.duree * MINUTE;
  const pas = (reglages.pas ?? reglages.duree) * MINUTE;
  const margeAvant = (reglages.margeAvant ?? 0) * MINUTE;
  const margeApres = (reglages.margeApres ?? 0) * MINUTE;
  const debutMin = Math.max(de, maintenant + (reglages.preavisMinutes ?? 0) * MINUTE);
  const finMax = Math.min(a, maintenant + (reglages.horizonJours ?? 30) * JOUR);
  if (finMax <= debutMin) return [];

  const creneaux = [];
  for (const plage of plagesProprietaire(reglages, debutMin, finMax)) {
    if (reglages.maxParJour && (parJour.get(plage.date) ?? 0) >= reglages.maxParJour) continue;
    for (let t = plage.debut; t + duree <= plage.fin; t += pas) {
      if (t < debutMin) continue;
      if (t + duree > finMax) break;
      if (libre(t, t + duree, occupations, margeAvant, margeApres)) creneaux.push(t);
    }
  }
  return creneaux.sort((x, y) => x - y);
}

// Vrai si `debut` est exactement l'un des créneaux que `calculerCreneaux`
// proposerait avec ces arguments. Sert à la réservation : le serveur ne fait
// confiance à aucun instant venu du navigateur.
export function estProposable(debut, args) {
  const duree = args.reglages.duree * MINUTE;
  return calculerCreneaux({ ...args, de: debut - JOUR, a: debut + duree + JOUR }).includes(debut);
}
