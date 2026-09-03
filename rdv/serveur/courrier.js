// Les mails et le fichier .ics.
//
// Sans SMTP configuré, les mails sont écrits dans le journal au lieu d'être
// envoyés : le module reste utilisable en développement, et rien ne part par
// accident depuis un poste de travail.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- Formatage --------------------------------------------------------------

export function formaterDate(instant, fuseau, locale = 'fr-FR') {
  const f = new Intl.DateTimeFormat(locale, {
    timeZone: fuseau, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  return f.format(instant);
}

export function formaterHeure(instant, fuseau, locale = 'fr-FR') {
  return new Intl.DateTimeFormat(locale, { timeZone: fuseau, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(instant).replace(':', ' h ');
}

function nomFuseau(fuseau, instant) {
  const p = new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, timeZoneName: 'long' }).formatToParts(instant);
  return p.find((x) => x.type === 'timeZoneName')?.value ?? fuseau;
}

// « lundi 7 septembre 2026, 9 h 00 – 9 h 30 (heure de La Réunion) »
export function decrireCreneau(r, fuseau) {
  return `${formaterDate(r.debut, fuseau)}, ${formaterHeure(r.debut, fuseau)} – ${formaterHeure(r.fin, fuseau)} (${nomFuseau(fuseau, r.debut)})`;
}

// --- .ics -------------------------------------------------------------------

function icsDate(instant) {
  return new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsTexte(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Coupe les lignes à 75 octets, comme le demande la RFC 5545.
function plier(ligne) {
  const out = [];
  let reste = ligne;
  while (Buffer.byteLength(reste) > 75) {
    let i = 75;
    while (Buffer.byteLength(reste.slice(0, i)) > 75) i--;
    out.push(reste.slice(0, i));
    reste = ' ' + reste.slice(i);
  }
  out.push(reste);
  return out.join('\r\n');
}

// Le même UID pour la demande et l'annulation, la SEQUENCE qui monte : c'est
// ce qui fait que Gmail et Outlook mettent l'événement à jour au lieu d'en
// créer un second.
export function genererIcs(r, { methode = 'REQUEST', reglages, proprietaire, urlPublique }) {
  const lieu = r.format === 'visio' ? (r.lien_visio ?? 'Visio') : 'Téléphone';
  const lignes = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//rdv//briques//FR',
    `METHOD:${methode}`,
    'BEGIN:VEVENT',
    `UID:${r.ical_uid}`,
    `SEQUENCE:${r.ical_sequence}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(r.debut)}`,
    `DTEND:${icsDate(r.fin)}`,
    `SUMMARY:${icsTexte(`${reglages.titre} · ${proprietaire.nom}`)}`,
    `DESCRIPTION:${icsTexte(`${r.format === 'visio' ? 'Visio' : 'Téléphone'}\nGérer ce rendez-vous : ${urlPublique}/r/${r.uid}`)}`,
    `LOCATION:${icsTexte(lieu)}`,
    `STATUS:${methode === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    proprietaire.email ? `ORGANIZER;CN=${icsTexte(proprietaire.nom)}:mailto:${proprietaire.email}` : null,
    `ATTENDEE;CN=${icsTexte(r.nom)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:${r.email}`,
    r.lien_visio ? `URL:${r.lien_visio}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lignes.map(plier).join('\r\n') + '\r\n';
}

// --- Contenu des mails --------------------------------------------------------

function bloc(r, fuseau, proprietaire, urlPublique) {
  const contact = r.format === 'visio'
    ? (r.lien_visio ? `Lien de visio : ${r.lien_visio}` : 'Le lien de visio vous sera envoyé avant le rendez-vous.')
    : `${proprietaire.nom} vous appellera au ${r.telephone || 'numéro indiqué'}.`;
  return [
    decrireCreneau(r, fuseau),
    contact,
    '',
    `Annuler ou déplacer : ${urlPublique}/r/${r.uid}`,
  ].join('\n');
}

export function mailsConfirmation(r, ctx) {
  const { reglages, proprietaire, urlPublique } = ctx;
  return {
    visiteur: {
      a: `${r.nom} <${r.email}>`,
      sujet: `Rendez-vous confirmé avec ${proprietaire.nom}`,
      texte: [
        `Bonjour ${r.nom},`,
        '',
        'Votre rendez-vous est confirmé.',
        '',
        bloc(r, r.fuseau, proprietaire, urlPublique),
        '',
        `${proprietaire.nom}`,
      ].join('\n'),
      ics: { methode: 'REQUEST', nom: 'rendez-vous.ics' },
    },
    proprietaire: proprietaire.email ? {
      a: proprietaire.email,
      sujet: `Nouveau rendez-vous : ${r.nom}, ${formaterDate(r.debut, reglages.fuseau)} ${formaterHeure(r.debut, reglages.fuseau)}`,
      texte: [
        `${r.nom} a pris rendez-vous.`,
        '',
        decrireCreneau(r, reglages.fuseau),
        `Format : ${r.format === 'visio' ? 'visio' : 'téléphone'}${r.lien_visio ? ` · ${r.lien_visio}` : ''}`,
        `E-mail : ${r.email}`,
        r.telephone ? `Téléphone : ${r.telephone}` : null,
        r.message ? `\nMessage :\n${r.message}` : null,
        '',
        `Annuler ou déplacer : ${urlPublique}/r/${r.uid}`,
      ].filter((l) => l !== null).join('\n'),
      ics: { methode: 'REQUEST', nom: 'rendez-vous.ics' },
    } : null,
  };
}

export function mailsAnnulation(r, ctx, { parLeProprietaire = false } = {}) {
  const { reglages, proprietaire, urlPublique } = ctx;
  const motif = r.motif_annulation && r.motif_annulation !== 'deplace' ? `\nMotif : ${r.motif_annulation}` : '';
  return {
    visiteur: {
      a: `${r.nom} <${r.email}>`,
      sujet: `Rendez-vous annulé : ${formaterDate(r.debut, r.fuseau)}`,
      texte: [
        `Bonjour ${r.nom},`,
        '',
        `Votre rendez-vous du ${decrireCreneau(r, r.fuseau)} est annulé.${motif}`,
        '',
        `Pour en reprendre un : ${urlPublique}/`,
        '',
        `${proprietaire.nom}`,
      ].join('\n'),
      ics: { methode: 'CANCEL', nom: 'annulation.ics' },
    },
    proprietaire: proprietaire.email && !parLeProprietaire ? {
      a: proprietaire.email,
      sujet: `Rendez-vous annulé : ${r.nom}, ${formaterDate(r.debut, reglages.fuseau)} ${formaterHeure(r.debut, reglages.fuseau)}`,
      texte: `${r.nom} a annulé le rendez-vous du ${decrireCreneau(r, reglages.fuseau)}.${motif}`,
      ics: { methode: 'CANCEL', nom: 'annulation.ics' },
    } : null,
  };
}

export function mailsDeplacement(nouvelle, ancienne, ctx) {
  const { reglages, proprietaire, urlPublique } = ctx;
  return {
    visiteur: {
      a: `${nouvelle.nom} <${nouvelle.email}>`,
      sujet: `Rendez-vous déplacé : ${formaterDate(nouvelle.debut, nouvelle.fuseau)}`,
      texte: [
        `Bonjour ${nouvelle.nom},`,
        '',
        `Votre rendez-vous est déplacé du ${decrireCreneau(ancienne, nouvelle.fuseau)} au :`,
        '',
        bloc(nouvelle, nouvelle.fuseau, proprietaire, urlPublique),
        '',
        `${proprietaire.nom}`,
      ].join('\n'),
      ics: { methode: 'REQUEST', nom: 'rendez-vous.ics' },
    },
    proprietaire: proprietaire.email ? {
      a: proprietaire.email,
      sujet: `Rendez-vous déplacé : ${nouvelle.nom}, ${formaterDate(nouvelle.debut, reglages.fuseau)} ${formaterHeure(nouvelle.debut, reglages.fuseau)}`,
      texte: [
        `${nouvelle.nom} a déplacé le rendez-vous.`,
        `Avant : ${decrireCreneau(ancienne, reglages.fuseau)}`,
        `Après : ${decrireCreneau(nouvelle, reglages.fuseau)}`,
        '',
        `Annuler ou déplacer : ${urlPublique}/r/${nouvelle.uid}`,
      ].join('\n'),
      ics: { methode: 'REQUEST', nom: 'rendez-vous.ics' },
    } : null,
  };
}

export function mailRappel(r, ctx, minutes) {
  const { proprietaire, urlPublique } = ctx;
  const quand = minutes >= 1440 ? `dans ${Math.round(minutes / 1440)} jour${minutes >= 2880 ? 's' : ''}` : minutes >= 60 ? `dans ${Math.round(minutes / 60)} h` : `dans ${minutes} min`;
  return {
    a: `${r.nom} <${r.email}>`,
    sujet: `Rappel : rendez-vous ${quand} avec ${proprietaire.nom}`,
    texte: [
      `Bonjour ${r.nom},`,
      '',
      `Petit rappel : votre rendez-vous a lieu ${quand}.`,
      '',
      bloc(r, r.fuseau, proprietaire, urlPublique),
      '',
      `${proprietaire.nom}`,
    ].join('\n'),
  };
}

// --- Envoi ---------------------------------------------------------------------

export class Courrier {
  constructor(smtp, { journal = () => {} } = {}) {
    this.journal = journal;
    this.expediteur = smtp.expediteur;
    if (smtp.hote && smtp.utilisateur && smtp.motDePasse) {
      const nodemailer = require('nodemailer');
      this.transport = nodemailer.createTransport({
        host: smtp.hote,
        port: smtp.port,
        secure: smtp.port === 465,
        auth: { user: smtp.utilisateur, pass: smtp.motDePasse },
      });
    } else {
      this.transport = null;
    }
  }

  get configure() {
    return Boolean(this.transport);
  }

  // Envoie un mail { a, sujet, texte, ics? }. `r` et `ctx` servent à générer
  // le .ics si demandé. Une erreur d'envoi est journalisée, jamais levée :
  // un mail perdu ne doit pas faire échouer une réservation déjà en base.
  async envoyer(mail, r = null, ctx = null, uid = null) {
    if (!mail) return false;
    const message = {
      from: this.expediteur,
      to: mail.a,
      subject: mail.sujet,
      text: mail.texte,
    };
    if (mail.ics && r && ctx) {
      const contenu = genererIcs(r, { methode: mail.ics.methode, ...ctx });
      message.icalEvent = { method: mail.ics.methode, filename: mail.ics.nom, content: contenu };
    }
    if (!this.transport) {
      this.journal('info', `[mail non envoyé, SMTP absent] à ${mail.a} — ${mail.sujet}`, uid);
      return false;
    }
    try {
      await this.transport.sendMail(message);
      this.journal('info', `mail envoyé à ${mail.a} — ${mail.sujet}`, uid);
      return true;
    } catch (e) {
      this.journal('erreur', `échec d'envoi à ${mail.a} : ${e.message}`, uid);
      return false;
    }
  }
}
