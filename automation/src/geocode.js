// Geocoding mit Zwischenspeicher und zweitem Anbieter.
//
// Feldauswertung wie geocode() in src/app.js des Aufmass-Tools, damit ein
// automatisch vorbereitetes Objekt an genau derselben Stelle landet wie eines,
// das jemand von Hand in die Suchleiste tippt.
//
// Warum mehr als ein Anbieter: eine Portfolio-Anfrage bringt 50-100 Adressen
// auf einmal. Der oeffentliche Photon-Dienst drosselt dabei ab etwa der 55.
// Adresse und sperrt danach fuer laengere Zeit ganz. Ohne Ausweichweg fehlt
// dann fast die Haelfte der Objekte - und zwar still, weil jeder einzelne
// Fehlschlag harmlos aussieht.

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'sveag-aufmass/1.0 (Winterdienst-Aufmass)';

// Photon liefert fuer Stadtstaaten kein `state` (Stadt- und Landesgrenze sind
// identisch). Ohne diesen Fallback findet das Tool spaeter weder WMS- noch
// WFS-Eintrag fuer Berlin/Hamburg/Bremen.
const CITY_STATES = ['Berlin', 'Hamburg', 'Bremen'];
const RETRY_STATUS = /^(429|5\d\d)$/;

// --- Zwischenspeicher ---------------------------------------------------

// Eine Adresse aendert ihre Koordinate nicht. Bei einem zweiten Lauf ueber
// dieselbe Objektliste - und den gibt es immer, spaetestens beim Nachtragen
// fehlender Adressen - darf kein einziger Aufruf mehr rausgehen.
class Cache {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.dirty = false;
    if (file && fs.existsSync(file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        this.data = {}; // kaputter Cache ist kein Grund abzubrechen
      }
    }
  }

  get(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : undefined;
  }

  set(key, value) {
    this.data[key] = value;
    this.dirty = true;
    // Zwischendurch schreiben. Ein Lauf ueber 95 Adressen dauert Minuten; wird
    // er abgebrochen (Zeitlimit, Strg-C, OOM), waere sonst jeder Abruf umsonst
    // gewesen - genau das ist einmal passiert.
    this.seitSpeichern = (this.seitSpeichern || 0) + 1;
    if (this.seitSpeichern >= 10) this.save();
  }

  save() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Erst daneben schreiben, dann umbenennen: ein Abbruch mittendrin darf
    // keine halbe Datei hinterlassen, die beim naechsten Start unlesbar ist.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    this.seitSpeichern = 0;
  }

  get size() {
    return Object.keys(this.data).length;
  }
}

// --- Anbieter -----------------------------------------------------------

function fromPhoton(data, query) {
  const f = data && data.features && data.features[0];
  if (!f) return null;
  const p = f.properties || {};
  const street = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
  const city = [p.postcode, p.city].filter(Boolean).join(' ');
  return {
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    state: p.state || (CITY_STATES.includes(p.city) ? p.city : null),
    // Grossschreibung erzwingen: Photon liefert je nach Datensatz "DE" oder
    // "de", und der Aufrufer vergleicht gegen "DE". Ohne das wuerde eine
    // deutsche Adresse als Auslandstreffer verworfen.
    countryCode: (p.countrycode || '').toUpperCase() || null,
    label: [street, city].filter(Boolean).join(', ') || query,
    provider: 'photon',
  };
}

function fromNominatim(data, query) {
  const f = Array.isArray(data) && data[0];
  if (!f) return null;
  const a = f.address || {};
  const street = [a.road, a.house_number].filter(Boolean).join(' ');
  const ort = a.city || a.town || a.village || a.suburb;
  const city = [a.postcode, ort].filter(Boolean).join(' ');
  return {
    lat: Number(f.lat),
    lon: Number(f.lon),
    // Nominatim nennt das Bundesland `state`; Stadtstaaten liefern es mit.
    state: a.state || (CITY_STATES.includes(ort) ? ort : null),
    countryCode: (a.country_code || '').toUpperCase() || null,
    label: [street, city].filter(Boolean).join(', ') || f.display_name || query,
    provider: 'nominatim',
  };
}

const PROVIDERS = [
  {
    name: 'photon',
    url: (q) => `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=1&lang=de`,
    parse: fromPhoton,
  },
  {
    name: 'nominatim',
    // Nominatim erlaubt laut Nutzungsbedingungen hoechstens eine Anfrage pro
    // Sekunde und verlangt einen aussagekraeftigen User-Agent.
    url: (q) => `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=1&countrycodes=de`,
    parse: fromNominatim,
    minIntervalMs: 1100,
  },
];

const lastCall = new Map();

// Sicherung gegen einen dauerhaft ausgefallenen Anbieter.
//
// Ist Photon gesperrt, kostet jede Adresse sonst erst zwei Wiederholungen mit
// Wartezeit, bevor Nominatim ueberhaupt drankommt - bei 95 Adressen sind das
// Minuten reiner Leerlauf. Nach drei Fehlschlaegen in Folge wird der Anbieter
// fuer den Rest des Laufs uebersprungen.
const FEHLER_BIS_AUSFALL = 3;
const fehlerInFolge = new Map();

function alsAusgefallen(name) {
  return (fehlerInFolge.get(name) || 0) >= FEHLER_BIS_AUSFALL;
}

// Nur fuer Tests: Zustand zwischen Laeufen zuruecksetzen.
function resetProviderState() {
  fehlerInFolge.clear();
  lastCall.clear();
}

async function ask(provider, query, { fetchImpl, timeoutMs, retries, backoffMs }) {
  if (provider.minIntervalMs) {
    const seit = Date.now() - (lastCall.get(provider.name) || 0);
    if (seit < provider.minIntervalMs) await sleep(provider.minIntervalMs - seit);
  }
  const url = provider.url(query);
  let lastErr = null;
  for (let versuch = 0; versuch <= retries; versuch++) {
    if (versuch > 0) await sleep(backoffMs * versuch);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
      lastCall.set(provider.name, Date.now());
      if (!res.ok) {
        lastErr = new Error(`${provider.name} HTTP ${res.status}`);
        if (RETRY_STATUS.test(String(res.status))) continue;
        throw lastErr; // 400er sind Programmierfehler, kein Wiederholen
      }
      return provider.parse(await res.json(), query);
    } catch (err) {
      lastCall.set(provider.name, Date.now());
      lastErr = err;
      if (err.name !== 'AbortError' && !/HTTP (429|5\d\d)/.test(err.message)) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`${provider.name}: unbekannter Fehler`);
}

// Gibt {lat, lon, state, countryCode, label, provider} zurueck, oder null,
// wenn KEIN Anbieter einen Treffer hat. Wirft nur, wenn alle Anbieter an
// einem technischen Fehler scheitern - dann ist der Dienst das Problem, nicht
// die Adresse, und das sind zwei verschiedene Dinge.
async function geocode(query, {
  fetchImpl = fetch, timeoutMs = 15000, retries = 2, backoffMs = 1200, cache = null,
} = {}) {
  if (typeof query !== 'string' || query.trim().length < 3) {
    throw new Error(`Unbrauchbarer Suchbegriff fuer das Geocoding: ${JSON.stringify(query)}`);
  }
  const key = query.trim();
  if (cache) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit ? { ...hit, cached: true } : null;
  }

  const fehler = [];
  let uebersprungen = 0;
  for (const provider of PROVIDERS) {
    if (alsAusgefallen(provider.name)) { uebersprungen++; continue; }
    let treffer;
    try {
      treffer = await ask(provider, key, { fetchImpl, timeoutMs, retries, backoffMs });
      fehlerInFolge.set(provider.name, 0);
    } catch (err) {
      fehlerInFolge.set(provider.name, (fehlerInFolge.get(provider.name) || 0) + 1);
      fehler.push(err.message);
      continue; // naechster Anbieter
    }
    if (treffer) {
      if (cache) cache.set(key, treffer);
      return treffer;
    }
    // Treffer null heisst: der Dienst antwortete, kennt die Adresse aber
    // nicht. Der naechste Anbieter darf es trotzdem versuchen.
  }
  if (fehler.length + uebersprungen === PROVIDERS.length) {
    const grund = fehler.length ? fehler.join('; ') : 'alle Anbieter als ausgefallen markiert';
    throw new Error(`Kein Anbieter erreichbar (${grund})`);
  }
  if (cache) cache.set(key, null); // "gibt es nicht" ist auch ein Ergebnis
  return null;
}

module.exports = {
  geocode, Cache, resetProviderState,
  PHOTON_URL, NOMINATIM_URL, CITY_STATES, PROVIDERS, FEHLER_BIS_AUSFALL,
};
