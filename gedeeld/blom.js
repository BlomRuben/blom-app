'use strict';

// ============================================================
//  Blom App – gedeeld door het portaal en alle modules
//  - api() en apiSend(): verzoeken aan de server
//  - Blom.start(): controleert of je bent ingelogd en tekent
//    de kopbalk (terug naar het portaal, wisselen van module,
//    uitloggen)
//  - kleine hulpfuncties: $, $$, esc
// ============================================================

// De map van de hele app (één niveau boven gedeeld/), zodat adressen kloppen
// vanuit het portaal én vanuit een module, en ook als los bestand
const BLOM_ROOT = new URL('..', document.currentScript.src);
const SERVER_MODE = location.protocol === 'http:' || location.protocol === 'https:';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fout als de gegevens intussen op een ander apparaat zijn gewijzigd
class ConflictError extends Error {}
// Fout als je niet (meer) bent ingelogd
class AuthError extends Error {}

// Volledig adres binnen de app, bijv. blomUrl('api/session')
function blomUrl(path) {
  return new URL(path, BLOM_ROOT).href;
}

// Doet een verzoek aan de server en geeft het JSON-antwoord terug
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(blomUrl(path), { cache: 'no-store', ...options });
  } catch {
    throw new Error('De server is niet bereikbaar.');
  }
  if (res.status === 409) throw new ConflictError('De gegevens zijn op een ander apparaat gewijzigd.');
  if (res.status === 401) {
    document.dispatchEvent(new Event('blom:uitgelogd'));
    throw new AuthError('Je bent niet (meer) ingelogd.');
  }
  if (!res.ok) {
    // De server legt in de meeste gevallen zelf uit wat er mis is
    const message = await res.json().then(body => body.error, () => null);
    throw new Error(message || `De server gaf een fout (${res.status}).`);
  }
  return res.json();
}

// JSON versturen naar de server
function apiSend(method, path, body) {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

// Opslag van de gegevens van een module. Via de server per gebruiker, met een
// versienummer zodat apparaten elkaars werk niet overschrijven; als los bestand
// in deze browser (localStorage).
class ModuleStore {
  constructor(moduleId) {
    this.moduleId = moduleId;
    this.remote = SERVER_MODE;
    this.version = 0;
    this.key = `blom-${moduleId}`;
  }

  // Geeft de gegevens terug, of null als er nog niets is opgeslagen
  async load() {
    if (!this.remote) {
      const raw = localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    }
    const store = await api(`api/${this.moduleId}/data`);
    this.version = store.version;
    return store.data;
  }

  async save(data) {
    if (!this.remote) {
      localStorage.setItem(this.key, JSON.stringify(data));
      return;
    }
    const result = await apiSend('PUT', `api/${this.moduleId}/data`, { version: this.version, data });
    this.version = result.version;
  }

  // Heeft een ander apparaat intussen iets opgeslagen?
  async hasNewer() {
    if (!this.remote) return false;
    return (await api(`api/${this.moduleId}/version`)).version !== this.version;
  }
}

const Blom = {
  serverMode: SERVER_MODE,
  root: BLOM_ROOT.href,
  session: null,   // { user, modules, connectors } na start()

  // Voor een module: controleert de login en tekent de kopbalk.
  // Geeft de sessie terug, of null als de pagina als los bestand is geopend.
  async start(moduleId) {
    if (!SERVER_MODE) {
      this.renderHeader(moduleId, null);
      return null;
    }
    let session;
    try {
      session = await api('api/session');
    } catch (err) {
      this.renderHeader(moduleId, null);
      throw err;
    }
    if (!session.user) {
      // Inloggen gebeurt in het portaal
      location.href = BLOM_ROOT.href;
      return new Promise(() => {});   // de pagina gaat weg; niets meer doen
    }
    this.session = session;
    this.renderHeader(moduleId, session);
    if (!session.modules.some(m => m.id === moduleId)) {
      throw new Error('Je hebt geen toegang tot deze module. Vraag de admin om hem voor je aan te zetten.');
    }
    return session;
  },

  hasConnector(id) {
    return !!this.session?.connectors.includes(id);
  },

  // Kopbalk: "Blom App › 🍷 Wijnkelder", wisselen van module, gebruiker en uitloggen
  renderHeader(moduleId, session) {
    const head = $('#blom-head');
    if (!head) return;
    const current = session?.modules.find(m => m.id === moduleId);
    const title = head.dataset.title || current?.name || '';
    const icon = head.dataset.icon || current?.icon || '';
    // In het portaal zelf (moduleId leeg) geen weg terug en geen wisselaar: daar staan de tegels
    const others = session && moduleId ? session.modules.filter(m => m.id !== moduleId) : [];
    head.innerHTML = `
      <div class="crumbs">
        ${SERVER_MODE && moduleId ? `<a href="${esc(BLOM_ROOT.href)}">⌂ Blom App</a><span class="sep">›</span>` : ''}
        <h1>${esc(icon)} ${esc(title)}</h1>
      </div>
      ${session ? `
        <div class="account">
          ${others.length ? `<select aria-label="Naar een andere module" id="blom-switch">
              <option value="">Wissel van app…</option>
              ${others.map(m => `<option value="${esc(blomUrl(m.url))}">${esc(m.icon)} ${esc(m.name)}</option>`).join('')}
            </select>` : ''}
          <span>👤 <strong>${esc(session.user.username)}</strong></span>
          <button type="button" id="blom-logout">Uitloggen</button>
        </div>` : ''}`;
    $('#blom-switch')?.addEventListener('change', e => { if (e.target.value) location.href = e.target.value; });
    $('#blom-logout')?.addEventListener('click', () => Blom.logout());
  },

  async logout() {
    try {
      await apiSend('POST', 'api/logout');
    } catch {
      // Ook als de server niet reageert: naar het portaal, dat toont de status
    }
    location.href = BLOM_ROOT.href;
  },
};

// Verlopen sessie, of elders je wachtwoord gewijzigd: naar het inlogscherm in het portaal.
// Even wachten, zodat de pagina zelf eerst kan opruimen (bijv. niet meer proberen op te slaan).
document.addEventListener('blom:uitgelogd', () => {
  if (Blom.loggingOut) return;
  Blom.loggingOut = true;
  setTimeout(() => {
    alert('Je bent uitgelogd, bijvoorbeeld omdat je wachtwoord is gewijzigd. Log opnieuw in.');
    location.href = BLOM_ROOT.href;
  }, 0);
});
