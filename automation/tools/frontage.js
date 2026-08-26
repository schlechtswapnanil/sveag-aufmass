#!/usr/bin/env node
// Gehweg-Laenge aus dem Flurstueck, ohne Umweg ueber das Luftbild.
//
//   node tools/frontage.js <lat> <lon> <Bundesland>
//
// Das ist derselbe Weg, den das Tool bei einer Adresssuche geht
// (loadParcelFrontage in src/app.js): Flurstueck vom Landes-WFS, Strassen aus
// OSM, dann extractFrontage - die Flurstueckskanten, die parallel und nah zur
// Strasse laufen. Anders als der Luftbild-Schritt beruht das auf amtlicher
// Geometrie und nicht auf Bildauswertung.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { ringsFromGml, ringsFromGeoJson, ringContains, extractFrontage } = require('../vendor/parcel.js');

const REG = require('../vendor/registries.json');

const [lat, lon, state] = process.argv.slice(2);
if (!lat || !lon || !state) {
  console.error('Aufruf: frontage.js <lat> <lon> <Bundesland>');
  process.exit(2);
}
const pt = [Number(lat), Number(lon)];
const wfs = REG.WFS_BY_STATE[state];
if (!wfs) { console.error(`Kein Flurstueck-Dienst fuer ${state}`); process.exit(1); }

function osmStreets(radiusM = 100) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((pt[0] * Math.PI) / 180));
  const bbox = [pt[1] - dLon, pt[0] - dLat, pt[1] + dLon, pt[0] + dLat].join(',');
  const raw = execFileSync('curl', ['-sS', '--fail', '-A', 'sveag-aufmass',
    `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`], { maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(raw);
  const nodes = new Map();
  for (const e of data.elements) if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
  const out = [];
  for (const e of data.elements) {
    if (e.type !== 'way' || !e.nodes || !(e.tags || {}).highway) continue;
    const g = e.nodes.map((n) => nodes.get(n)).filter(Boolean);
    if (g.length >= 2) out.push(g);
  }
  return out;
}

(async () => {
  const pq = JSON.parse(execFileSync('node', [
    path.join(__dirname, '..', 'cv', 'parcel-query.js'),
    String(pt[0]), String(pt[1]), JSON.stringify(wfs), '100', '25',
  ]).toString());

  if (!pq.containing.length) {
    console.log(JSON.stringify({ ok: false, grund: 'kein Flurstueck enthaelt den Punkt' }));
    return;
  }
  const streets = osmStreets();
  const chains = extractFrontage(pq.containing, streets);
  console.log(JSON.stringify({
    ok: true,
    truncated: pq.truncated,          // haette count=5 des Tools danebengegriffen?
    ringe: pq.total,
    fronten: chains.map((c) => Math.round(c.lengthM * 10) / 10),
    gesamtM: Math.round(chains.reduce((n, c) => n + c.lengthM, 0) * 10) / 10,
  }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, grund: e.message.slice(0, 120) })); });
