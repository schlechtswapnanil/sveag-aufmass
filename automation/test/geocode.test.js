const test = require('node:test');
const assert = require('node:assert');
const { geocode } = require('../src/geocode.js');

const TREFFER = {
  features: [{
    geometry: { coordinates: [12.37, 51.34] },
    properties: { name: 'Herrnhuter Straße', housenumber: '23', postcode: '04318',
                  city: 'Leipzig', state: 'Sachsen', countrycode: 'DE' },
  }],
};

function antwort(status, body = TREFFER) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('ein leerer Suchbegriff wird abgewiesen, ohne den Dienst zu fragen', async () => {
  const nie = () => { throw new Error('darf nicht abgefragt werden'); };
  for (const q of [null, undefined, '', '  ', 'ab']) {
    await assert.rejects(() => geocode(q, { fetchImpl: nie }), /Unbrauchbarer Suchbegriff/);
  }
});

test('503 wird wiederholt - sonst fehlt bei einer Objektliste die halbe Liste', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return n < 3 ? antwort(503) : antwort(200); };
  const geo = await geocode('Herrnhuter Straße 23, Leipzig', { fetchImpl, backoffMs: 1 });
  assert.strictEqual(n, 3);
  assert.strictEqual(geo.state, 'Sachsen');
  assert.strictEqual(geo.countryCode, 'DE');
});

test('429 wird ebenfalls wiederholt', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return n < 2 ? antwort(429) : antwort(200); };
  await geocode('Herrnhuter Straße 23, Leipzig', { fetchImpl, backoffMs: 1 });
  assert.strictEqual(n, 2);
});

test('400 wird nicht wiederholt - das waere ein Programmierfehler', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return antwort(400); };
  await assert.rejects(() => geocode('x y z', { fetchImpl, backoffMs: 1 }), /HTTP 400/);
  assert.strictEqual(n, 1, 'ein 400 darf nicht wiederholt werden');
});

test('nach erschoepften Wiederholungen sagt der Fehler, dass wiederholt wurde', async () => {
  const fetchImpl = async () => antwort(503);
  await assert.rejects(
    () => geocode('Herrnhuter Straße 23, Leipzig', { fetchImpl, retries: 2, backoffMs: 1 }),
    /HTTP 503 \(nach 2 Wiederholungen\)/
  );
});

test('kein Treffer ist kein Fehler, sondern null', async () => {
  const fetchImpl = async () => antwort(200, { features: [] });
  assert.strictEqual(await geocode('Gibtsnicht 1, Nirgendwo', { fetchImpl }), null);
});

test('Stadtstaaten: fehlendes state wird aus der Stadt ergaenzt', async () => {
  const fetchImpl = async () => antwort(200, { features: [{
    geometry: { coordinates: [10.0, 53.6] },
    properties: { name: 'Erdkampsweg', housenumber: '87', postcode: '22335',
                  city: 'Hamburg', countrycode: 'DE' },
  }] });
  const geo = await geocode('Erdkampsweg 87, Hamburg', { fetchImpl });
  // Ohne das findet das Tool weder WMS- noch WFS-Eintrag fuer Hamburg.
  assert.strictEqual(geo.state, 'Hamburg');
});
