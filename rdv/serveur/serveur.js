// Point d'entrée : démarre l'application et les tâches de fond.
//
//   node serveur.js
//
// Variables d'environnement : voir env.exemple. Réglages : reglages.json
// dans le dossier DONNEES (voir reglages.exemple.json).

import { creerApplication } from './app.js';
import { lireEnv } from './config.js';

const env = lireEnv();
const app = creerApplication(env);

app.serveur.listen(env.port, () => {
  const r = app.reglages();
  console.log(`[rdv] à l'écoute sur le port ${env.port} — ${env.urlPublique}`);
  console.log(`[rdv] fuseau ${r.fuseau}, ${r.duree} min, Google ${app.google.configure ? (app.google.autorise ? 'autorisé' : 'à autoriser via /google/connexion?cle=…') : 'débranché'}, SMTP ${app.courrier.configure ? 'configuré' : 'absent (mails journalisés)'}`);
});

// Toutes les minutes : rappels dus, événements Google à retenter.
// Toutes les heures : purge, et relecture des réglages (on peut les
// modifier sans redémarrer).
const minute = setInterval(() => app.tachesDeFond().catch((e) => app.journal('erreur', `tâches de fond : ${e.message}`)), 60_000);
const heure = setInterval(() => {
  try { app.purger(); } catch (e) { app.journal('erreur', `purge : ${e.message}`); }
  try { app.rechargerReglages(); } catch (e) { app.journal('erreur', `réglages non rechargés : ${e.message}`); }
}, 3_600_000);

function arreter(signal) {
  console.log(`[rdv] ${signal}, arrêt`);
  clearInterval(minute);
  clearInterval(heure);
  app.serveur.close(() => { app.base.fermer(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => arreter('SIGTERM'));
process.on('SIGINT', () => arreter('SIGINT'));
