const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { geocode, Cache, resetProviderState, FEHLER_BIS_AUSFALL } = require('../src/geocode.js');

// Der Ausfall-Zaehler lebt im Modul und wuerde sonst zwischen Tests lecken.
test.beforeEach(() => resetProviderState());

const PHOTON_TREFFER = { features: [{
  geometry: { coordinates: [12.37, 51.34] },
  properties: { name: 'Herrnhuter Straße', housenumber: '23', postcode: '04318',
                city: 'Leipzig', state: 'Sachsen', countrycode: 'de' },
}] };

const NOMINATIM_TREFFER = [{
  lat: '51.3341', lon: '12.4230',
  address: { road: 'Herrnhuter Straße', house_number: '23', postcode: '04318',
             city: 'Leipzig', state: 'Sachsen', country_code: 'de' },
}];

const antwort = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ADRESSE = 'Herrnhuter Straße 23, 04318 Leipzig';

function tmpCacheFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aufmass-')), 'cache.json');
}

test('ein leerer Suchbegriff wird abgewiesen, ohne den Dienst zu fragen', async () => {
  const nie = () => { throw new Error('darf nicht abgefragt werden'); };
  for (const q of [null, undefined, '', '  ', 'ab']) {
    await assert.rejects(() => geocode(q, { fetchImpl: nie }), /Unbrauchbarer Suchbegriff/);
  }
});

test('503 wird wiederholt, dann geliefert', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return n < 3 ? antwort(503) : antwort(200, PHOTON_TREFFER); };
  const geo = await geocode(ADRESSE, { fetchImpl, backoffMs: 1 });
  assert.strictEqual(geo.provider, 'photon');
  assert.strictEqual(geo.state, 'Sachsen');
  assert.strictEqual(geo.countryCode, 'DE');
});

test('gibt Photon endgueltig auf, uebernimmt Nominatim', async () => {
  // Genau der Fall aus der Praxis: nach ~55 Adressen sperrt Photon. Ohne
  // Ausweichanbieter fehlt der Rest der Objektliste.
  const gefragt = [];
  const fetchImpl = async (url) => {
    gefragt.push(url.includes('photon') ? 'photon' : 'nominatim');
    return url.includes('photon') ? antwort(503) : antwort(200, NOMINATIM_TREFFER);
  };
  const geo = await geocode(ADRESSE, { fetchImpl, retries: 1, backoffMs: 1 });
  assert.strictEqual(geo.provider, 'nominatim');
  assert.strictEqual(geo.state, 'Sachsen');
  assert.strictEqual(geo.countryCode, 'DE');
  assert.match(geo.label, /Herrnhuter Straße 23/);
  assert.ok(gefragt.includes('photon') && gefragt.includes('nominatim'));
});

test('kennt der erste Anbieter die Adresse nicht, darf der zweite ran', async () => {
  const fetchImpl = async (url) => (url.includes('photon')
    ? antwort(200, { features: [] })
    : antwort(200, NOMINATIM_TREFFER));
  const geo = await geocode(ADRESSE, { fetchImpl, backoffMs: 1 });
  assert.strictEqual(geo.provider, 'nominatim');
});

test('kennt keiner die Adresse, ist das null - kein Fehler', async () => {
  const fetchImpl = async (url) => antwort(200, url.includes('photon') ? { features: [] } : []);
  assert.strictEqual(await geocode('Gibtsnicht 1, 99999 Nirgendwo', { fetchImpl, backoffMs: 1 }), null);
});

test('faellt jeder Anbieter technisch aus, wirft es - das ist kein "Adresse unbekannt"', async () => {
  const fetchImpl = async () => antwort(503);
  await assert.rejects(
    () => geocode(ADRESSE, { fetchImpl, retries: 1, backoffMs: 1 }),
    /Kein Anbieter erreichbar/
  );
});

test('400 wird nicht wiederholt', async () => {
  let n = 0;
  const fetchImpl = async (url) => { if (url.includes('photon')) n++; return antwort(400); };
  await assert.rejects(() => geocode(ADRESSE, { fetchImpl, retries: 3, backoffMs: 1 }));
  assert.strictEqual(n, 1);
});

test('Stadtstaaten: fehlendes state wird aus der Stadt ergaenzt', async () => {
  const fetchImpl = async () => antwort(200, { features: [{
    geometry: { coordinates: [10.0, 53.6] },
    properties: { name: 'Erdkampsweg', housenumber: '87', postcode: '22335',
                  city: 'Hamburg', countrycode: 'de' },
  }] });
  // Ohne das findet das Tool weder WMS- noch WFS-Eintrag fuer Hamburg.
  assert.strictEqual((await geocode('Erdkampsweg 87, Hamburg', { fetchImpl })).state, 'Hamburg');
});

// --- Zwischenspeicher ---------------------------------------------------

test('ein zweiter Lauf fragt keinen Dienst mehr', async () => {
  const cache = new Cache(tmpCacheFile());
  let n = 0;
  const fetchImpl = async () => { n++; return antwort(200, PHOTON_TREFFER); };
  await geocode(ADRESSE, { fetchImpl, cache });
  const zweiter = await geocode(ADRESSE, { fetchImpl, cache });
  assert.strictEqual(n, 1, 'der zweite Aufruf muss aus dem Zwischenspeicher kommen');
  assert.strictEqual(zweiter.cached, true);
  assert.strictEqual(zweiter.lat, PHOTON_TREFFER.features[0].geometry.coordinates[1]);
});

test('auch "gibt es nicht" wird gemerkt - sonst fragt jeder Lauf erneut', async () => {
  const cache = new Cache(tmpCacheFile());
  let n = 0;
  const fetchImpl = async (url) => { n++; return antwort(200, url.includes('photon') ? { features: [] } : []); };
  assert.strictEqual(await geocode('Gibtsnicht 1, 99999 Nirgendwo', { fetchImpl, cache, backoffMs: 1 }), null);
  const vorher = n;
  assert.strictEqual(await geocode('Gibtsnicht 1, 99999 Nirgendwo', { fetchImpl, cache, backoffMs: 1 }), null);
  assert.strictEqual(n, vorher);
});

test('der Zwischenspeicher ueberlebt den Prozess', async () => {
  const file = tmpCacheFile();
  const a = new Cache(file);
  const fetchImpl = async () => antwort(200, PHOTON_TREFFER);
  await geocode(ADRESSE, { fetchImpl, cache: a });
  a.save();

  const b = new Cache(file);
  const nie = () => { throw new Error('darf nicht abgefragt werden'); };
  const geo = await geocode(ADRESSE, { fetchImpl: nie, cache: b });
  assert.strictEqual(geo.cached, true);
});

test('ein kaputter Zwischenspeicher blockiert nicht', async () => {
  const file = tmpCacheFile();
  fs.writeFileSync(file, '{ das ist kein JSON');
  const cache = new Cache(file);
  assert.strictEqual(cache.size, 0);
  const geo = await geocode(ADRESSE, { fetchImpl: async () => antwort(200, PHOTON_TREFFER), cache });
  assert.strictEqual(geo.provider, 'photon');
});


// --- Ausfallsicherung ---------------------------------------------------

test('ein dauerhaft ausgefallener Anbieter wird nicht endlos weiter gefragt', async () => {
  // Ohne das kostet jede weitere Adresse erst Wiederholungen samt Wartezeit,
  // bevor der zweite Anbieter drankommt - bei 95 Adressen Minuten Leerlauf.
  let photon = 0;
  const fetchImpl = async (url) => {
    if (url.includes('photon')) { photon++; return antwort(503); }
    return antwort(200, NOMINATIM_TREFFER);
  };
  for (let i = 0; i < 6; i++) {
    const geo = await geocode(`Teststraße ${i}, 04318 Leipzig`, { fetchImpl, retries: 0, backoffMs: 1 });
    assert.strictEqual(geo.provider, 'nominatim');
  }
  // Nach FEHLER_BIS_AUSFALL Fehlschlaegen in Folge wird Photon uebersprungen.
  assert.strictEqual(photon, FEHLER_BIS_AUSFALL);
});

test('ein zwischendurch erfolgreicher Abruf setzt den Zaehler zurueck', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (!url.includes('photon')) return antwort(200, NOMINATIM_TREFFER);
    n++;
    return n === 3 ? antwort(200, PHOTON_TREFFER) : antwort(503);
  };
  for (let i = 0; i < 5; i++) {
    await geocode(`Teststraße ${i}, 04318 Leipzig`, { fetchImpl, retries: 0, backoffMs: 1 });
  }
  // Der Treffer beim dritten Versuch verhindert den Ausfall - Photon wird
  // weiter gefragt, statt fuer den Rest des Laufs abgeschrieben zu werden.
  assert.ok(n > FEHLER_BIS_AUSFALL, `Photon wurde nur ${n}x gefragt`);
});

test('der Zwischenspeicher wird waehrend des Laufs geschrieben, nicht erst am Ende', async () => {
  // Ein abgebrochener Lauf hat schon einmal jeden Abruf verloren.
  const file = tmpCacheFile();
  const cache = new Cache(file);
  const fetchImpl = async () => antwort(200, PHOTON_TREFFER);
  for (let i = 0; i < 12; i++) {
    await geocode(`Teststraße ${i}, 04318 Leipzig`, { fetchImpl, cache });
  }
  assert.ok(fs.existsSync(file), 'nach 12 Adressen muss die Datei existieren');
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length >= 10);
});

test('ein abgebrochenes Schreiben hinterlaesst keine halbe Datei', async () => {
  const file = tmpCacheFile();
  const cache = new Cache(file);
  cache.set('a', { lat: 1, lon: 2 });
  cache.save();
  assert.ok(!fs.existsSync(`${file}.tmp`), 'die temporaere Datei muss weg sein');
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['a']);
});
