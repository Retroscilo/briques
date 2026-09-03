// La configuration : les variables d'environnement pour ce qui est secret ou
// propre au déploiement, un fichier JSON pour les réglages du propriétaire.
//
// Rien ici n'a de valeur par défaut « réelle » : le dépôt est public, les
// vraies valeurs vivent dans le fichier d'environnement du VPS.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));

export function lireEnv(env = process.env) {
  const donnees = env.DONNEES ?? join(ICI, 'donnees');
  return {
    port: Number(env.PORT ?? 3000),
    donnees,
    urlPublique: (env.URL_PUBLIQUE ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
    // Origines autorisées à appeler l'API depuis un navigateur (la brique
    // posée sur le site). Plusieurs, séparées par des virgules.
    origines: (env.SITE_ORIGINES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    proprietaire: {
      nom: env.PROPRIETAIRE_NOM ?? 'Le propriétaire',
      email: env.PROPRIETAIRE_EMAIL ?? '',
      telephone: env.PROPRIETAIRE_TELEPHONE ?? '',
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      // L'adresse du compte, pas « primary » : l'alias n'est pas résolu par
      // freebusy avec le seul accès calendar.freebusy (constaté le 03/09/2026).
      calendrier: env.GOOGLE_CALENDRIER ?? 'primary',
    },
    smtp: {
      hote: env.SMTP_HOTE ?? '',
      port: Number(env.SMTP_PORT ?? 465),
      utilisateur: env.SMTP_UTILISATEUR ?? '',
      motDePasse: env.SMTP_MOT_DE_PASSE ?? '',
      expediteur: env.SMTP_EXPEDITEUR ?? env.PROPRIETAIRE_EMAIL ?? '',
    },
    // Protège la connexion Google (sinon n'importe qui pourrait brancher son
    // propre agenda) et sert de sel au hachage des adresses IP.
    cleAdmin: env.CLE_ADMIN ?? '',
  };
}

const REGLAGES_DEFAUT = {
  fuseau: 'Indian/Reunion',
  duree: 30,
  pas: 30,
  margeAvant: 15,
  margeApres: 15,
  preavisMinutes: 1440,
  horizonJours: 30,
  maxParJour: 4,
  confirmationAutomatique: true,
  rappelsMinutes: [1440, 60],
  conservationJours: 365,
  titre: 'Premier échange',
  horaires: [
    { jours: [1, 2, 3, 4, 5], debut: '09:00', fin: '12:00' },
    { jours: [1, 2, 3, 4, 5], debut: '14:00', fin: '17:00' },
  ],
  exceptions: [],
};

// Lit `reglages.json` dans le dossier des données. S'il n'existe pas, les
// valeurs par défaut ci-dessus s'appliquent : le serveur démarre toujours.
export function lireReglages(dossier) {
  const chemin = join(dossier, 'reglages.json');
  if (!existsSync(chemin)) return { ...REGLAGES_DEFAUT };
  const lu = JSON.parse(readFileSync(chemin, 'utf8'));
  const r = { ...REGLAGES_DEFAUT, ...lu };
  verifierReglages(r);
  return r;
}

export function verifierReglages(r) {
  const heure = /^([01]\d|2[0-4]):[0-5]\d$/;
  const date = /^\d{4}-\d{2}-\d{2}$/;
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: r.fuseau }); } catch { throw new Error(`Fuseau inconnu : ${r.fuseau}`); }
  if (!(r.duree > 0)) throw new Error('duree doit être positive');
  if (!(r.pas > 0)) throw new Error('pas doit être positif');
  for (const h of r.horaires) {
    if (!Array.isArray(h.jours) || !heure.test(h.debut) || !heure.test(h.fin)) throw new Error(`Horaire invalide : ${JSON.stringify(h)}`);
  }
  for (const e of r.exceptions ?? []) {
    if (!date.test(e.date)) throw new Error(`Exception invalide : ${JSON.stringify(e)}`);
    for (const p of e.plages ?? []) if (!heure.test(p.debut) || !heure.test(p.fin)) throw new Error(`Plage invalide : ${JSON.stringify(p)}`);
  }
  return r;
}

export function preparerDossier(dossier) {
  mkdirSync(dossier, { recursive: true });
  return dossier;
}
