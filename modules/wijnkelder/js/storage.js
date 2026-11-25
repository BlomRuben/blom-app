'use strict';

// ============================================================
//  Opslag
//  Er zijn twee manieren, de app kiest zelf:
//  - Geopend via je server (http://…): gegevens en foto's staan
//    op de server, dus je ziet overal dezelfde kelder.
//  - Als los bestand geopend (file://…): alles staat in deze browser.
// ============================================================

// SERVER_MODE, api(), apiSend(), ConflictError en AuthError komen uit gedeeld/blom.js
const STORAGE_KEY = 'wijnkelder-v1';
const API = 'api/wijnkelder';

const Storage = {
  remote: SERVER_MODE,
  // De versie van de gegevens die we van de server hebben. De server weigert
  // opslaan vanaf een oude versie, zodat apparaten elkaars werk niet overschrijven.
  version: 0,

  async load() {
    if (!SERVER_MODE) {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? Storage.normalize(JSON.parse(raw)) : Storage.empty();
    }
    const store = await api(`${API}/data`);
    Storage.version = store.version;
    return store.data ? Storage.normalize(store.data) : Storage.empty();
  },

  async save(data) {
    if (!SERVER_MODE) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return;
    }
    const result = await apiSend('PUT', `${API}/data`, { version: Storage.version, data });
    Storage.version = result.version;
  },

  // Heeft een ander apparaat intussen iets opgeslagen?
  async hasNewer() {
    if (!SERVER_MODE) return false;
    return (await api(`${API}/version`)).version !== Storage.version;
  },

  empty() {
    return {
      racks: [{ id: uid(), name: 'Rek 1', rows: 6, cols: 8 }],
      wines: [],
      wishlist: [],
    };
  },

  // Zorgt dat ingelezen gegevens (ook uit een back-up) altijd de juiste vorm hebben.
  normalize(d) {
    if (!d || !Array.isArray(d.wines)) throw new Error('Dit is geen geldig wijnkelder-bestand.');
    return {
      racks: (d.racks || []).map(r => ({ ...r, rows: Number(r.rows) || 1, cols: Number(r.cols) || 1 })),
      wines: d.wines.map(w => ({ ...w, quantity: Number(w.quantity) || 0, drunk: Number(w.drunk) || 0, positions: w.positions || [] })),
      wishlist: d.wishlist || [],
    };
  },
};

// ============================================================
//  Foto's
//  Elke foto wordt bewaard onder het id van de wijn.
//  Via de server staan ze op de server; als los bestand in
//  IndexedDB (ook in de browser, maar met veel meer ruimte
//  dan localStorage).
// ============================================================

const PhotosOnServer = {
  // Alle foto's als { wijnId: adres van de foto }
  async getAll() {
    const { photos } = await api(`${API}/photos`);
    return Object.fromEntries(Object.entries(photos).map(([id, v]) => [id, blomUrl(`${API}/photos/${id}?v=${v}`)]));
  },

  async set(id, dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    await api(`${API}/photos/${id}`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
  },

  delete(id) { return api(`${API}/photos/${id}`, { method: 'DELETE' }); },
  clear() { return api(`${API}/photos`, { method: 'DELETE' }); },

  async replaceAll(photos) {
    await this.clear();
    for (const [id, dataUrl] of Object.entries(photos)) await this.set(id, dataUrl);
  },
};

const PhotosInBrowser = {
  _db: null,

  open() {
    this._db ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('wijnkelder-fotos', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },

  // Voert één handeling uit op de foto-opslag en wacht tot die klaar is
  async _run(mode, action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = action(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  },

  // Alle foto's als { wijnId: dataUrl }
  async getAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const result = {};
      const req = db.transaction('photos').objectStore('photos').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(result);
        result[cursor.key] = cursor.value;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  set(id, dataUrl) { return this._run('readwrite', store => store.put(dataUrl, id)); },
  delete(id) { return this._run('readwrite', store => store.delete(id)); },
  clear() { return this._run('readwrite', store => store.clear()); },

  async replaceAll(photos) {
    await this.clear();
    for (const [id, dataUrl] of Object.entries(photos)) await this.set(id, dataUrl);
  },
};

const Photos = SERVER_MODE ? PhotosOnServer : PhotosInBrowser;

// Unieke id voor een wijn, rek of wens
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Datum van vandaag als 2026-10-29
function today() {
  return new Date().toISOString().slice(0, 10);
}
