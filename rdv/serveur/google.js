// Google Calendar, en REST direct avec `fetch`. Trois besoins : les
// occupations (freebusy), créer et modifier l'événement, et l'autorisation
// OAuth du propriétaire, une fois.
//
// Sans identifiants Google dans l'environnement, le module est « débranché » :
// aucune occupation, aucun événement, et le reste fonctionne. C'est le mode
// de développement et de démonstration.

import { randomBytes } from 'node:crypto';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];
const JOUR = 86_400_000;

export class GoogleIndisponible extends Error {
  constructor(message) { super(message); this.code = 'google_indisponible'; }
}

export class Google {
  constructor({ clientId, clientSecret, calendrier = 'primary' }, base, { urlPublique, journal = () => {} } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.calendrier = calendrier;
    this.base = base;
    this.urlRetour = `${urlPublique}/google/retour`;
    this.journal = journal;
    this.etats = new Map(); // état OAuth → expiration
    this.cache = new Map(); // clé de fenêtre → { le, occupations }
  }

  get configure() {
    return Boolean(this.clientId && this.clientSecret);
  }

  get autorise() {
    return this.configure && Boolean(this.base.jeton());
  }

  // --- Autorisation ---------------------------------------------------------

  urlAutorisation() {
    const etat = randomBytes(16).toString('base64url');
    this.etats.set(etat, Date.now() + 10 * 60_000);
    const p = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.urlRetour,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: etat,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }

  async recevoirCode(code, etat) {
    const exp = this.etats.get(etat);
    this.etats.delete(etat);
    if (!exp || exp < Date.now()) throw new Error('État OAuth inconnu ou expiré.');
    const r = await this.#jeton({ code, grant_type: 'authorization_code', redirect_uri: this.urlRetour });
    if (!r.refresh_token) throw new Error('Google n\'a pas renvoyé de jeton de rafraîchissement.');
    let compte = null;
    try {
      const rep = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendrier)}`, {
        headers: { Authorization: `Bearer ${r.access_token}` },
      });
      if (rep.ok) compte = (await rep.json()).id ?? null;
    } catch { /* l'identité du compte est un confort, pas une nécessité */ }
    this.base.enregistrerJeton({
      refreshToken: r.refresh_token, accessToken: r.access_token,
      expireLe: Date.now() + (r.expires_in - 60) * 1000, compte,
    });
    return compte;
  }

  async #jeton(corps) {
    const rep = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...corps }),
    });
    const json = await rep.json().catch(() => ({}));
    if (!rep.ok) throw new Error(`Jeton Google refusé : ${json.error ?? rep.status} ${json.error_description ?? ''}`.trim());
    return json;
  }

  async #acces() {
    const j = this.base.jeton();
    if (!j) throw new GoogleIndisponible('Google Calendar n\'est pas encore autorisé.');
    if (j.access_token && j.expire_le > Date.now()) return j.access_token;
    const r = await this.#jeton({ refresh_token: j.refresh_token, grant_type: 'refresh_token' });
    this.base.rafraichirAcces(r.access_token, Date.now() + (r.expires_in - 60) * 1000);
    return r.access_token;
  }

  async #appel(methode, chemin, corps, requete = {}) {
    let jeton;
    try { jeton = await this.#acces(); } catch (e) {
      if (e instanceof GoogleIndisponible) throw e;
      throw new GoogleIndisponible(e.message);
    }
    const url = new URL(`https://www.googleapis.com/calendar/v3${chemin}`);
    for (const [k, v] of Object.entries(requete)) url.searchParams.set(k, v);
    let rep;
    try {
      rep = await fetch(url, {
        method: methode,
        headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
        body: corps ? JSON.stringify(corps) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      throw new GoogleIndisponible(`Google injoignable : ${e.message}`);
    }
    if (rep.status === 204) return null;
    const json = await rep.json().catch(() => ({}));
    if (!rep.ok) {
      const err = new GoogleIndisponible(`Google a répondu ${rep.status} : ${json.error?.message ?? ''}`.trim());
      err.statut = rep.status;
      throw err;
    }
    return json;
  }

  // --- Occupations ------------------------------------------------------------

  // Les périodes occupées entre `de` et `a`, en ms UTC. Par tranches de 90
  // jours au plus, limite de l'API. `frais: true` ignore le cache : c'est ce
  // que fait la réservation.
  async occupations(de, a, { frais = false } = {}) {
    if (!this.configure) return [];
    const cle = `${de}-${a}`;
    const c = this.cache.get(cle);
    if (!frais && c && c.le > Date.now() - 60_000) return c.occupations;
    const occupations = [];
    for (let debut = de; debut < a; debut += 90 * JOUR) {
      const fin = Math.min(a, debut + 90 * JOUR);
      const rep = await this.#appel('POST', '/freeBusy', {
        timeMin: new Date(debut).toISOString(),
        timeMax: new Date(fin).toISOString(),
        items: [{ id: this.calendrier }],
      });
      const cal = rep.calendars?.[this.calendrier] ?? Object.values(rep.calendars ?? {})[0] ?? {};
      if (cal.errors?.length) throw new GoogleIndisponible(`freebusy : ${cal.errors[0].reason}`);
      for (const b of cal.busy ?? []) occupations.push({ debut: Date.parse(b.start), fin: Date.parse(b.end) });
    }
    this.cache.set(cle, { le: Date.now(), occupations });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return occupations;
  }

  // --- Événements -------------------------------------------------------------

  #corpsEvenement(r, reglages, proprietaire) {
    const lignes = [
      `${r.format === 'visio' ? 'Visio' : 'Téléphone'} · ${r.nom}`,
      `E-mail : ${r.email}`,
      r.telephone ? `Téléphone : ${r.telephone}` : null,
      r.message ? `\n${r.message}` : null,
    ].filter(Boolean);
    return {
      summary: `${reglages.titre} · ${r.nom}`,
      description: lignes.join('\n'),
      start: { dateTime: new Date(r.debut).toISOString() },
      end: { dateTime: new Date(r.fin).toISOString() },
      attendees: [{ email: r.email, displayName: r.nom }],
      iCalUID: r.ical_uid,
      sequence: r.ical_sequence,
      reminders: { useDefault: true },
      guestsCanInviteOthers: false,
      ...(proprietaire?.email ? { organizer: { email: proprietaire.email } } : {}),
    };
  }

  // Crée l'événement. Renvoie { id, lienVisio }. Les mails, c'est nous ;
  // Google n'envoie rien (`sendUpdates: none`).
  async creerEvenement(r, reglages, proprietaire) {
    if (!this.configure) return { id: null, lienVisio: null };
    const corps = this.#corpsEvenement(r, reglages, proprietaire);
    if (r.format === 'visio') {
      corps.conferenceData = {
        createRequest: { requestId: r.uid, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      };
    }
    const rep = await this.#appel('POST', `/calendars/${encodeURIComponent(this.calendrier)}/events`, corps, {
      sendUpdates: 'none', conferenceDataVersion: '1',
    });
    return { id: rep.id, lienVisio: rep.hangoutLink ?? null };
  }

  async deplacerEvenement(r, reglages, proprietaire) {
    if (!this.configure || !r.google_event_id) return;
    const corps = this.#corpsEvenement(r, reglages, proprietaire);
    delete corps.attendees; // inchangés ; les renvoyer remettrait leur réponse à zéro
    await this.#appel('PATCH', `/calendars/${encodeURIComponent(this.calendrier)}/events/${encodeURIComponent(r.google_event_id)}`, corps, {
      sendUpdates: 'none',
    });
  }

  async supprimerEvenement(r) {
    if (!this.configure || !r.google_event_id) return;
    try {
      await this.#appel('DELETE', `/calendars/${encodeURIComponent(this.calendrier)}/events/${encodeURIComponent(r.google_event_id)}`, null, {
        sendUpdates: 'none',
      });
    } catch (e) {
      // Déjà supprimé côté Google : ce n'est pas une erreur pour nous.
      if (e.statut === 404 || e.statut === 410) return;
      throw e;
    }
  }
}
