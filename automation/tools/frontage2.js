#!/usr/bin/env node
// Gehweg-Laenge, zwei Wege im Vergleich.
//
//   node tools/frontage2.js <lat> <lon> <Bundesland>
//
// A) Flurstueck  - die Kanten des Flurstuecks entlang der Strasse (was das
//                  Tool heute vorschlaegt).
// B) Gebaeude    - die strassenseitigen Kanten des OSM-Gebaeudegrundrisses.
//
// Beides laeuft durch dieselbe Funktion extractFrontage(); nur die Geometrie
// ist eine andere.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { ringContains, extractFrontage } = require('../vendor/parcel.js');
const REG = require('../vendor/registries.json');

const [lat, lon, state] = process.argv.slice(2);
const pt = [Number(lat), Number(lon)];
const opts = { maxDistM: Number(process.env.MAXDIST || 15),
               maxAngleDeg: Number(process.env.MAXANGLE || 30),
               minLenM: Number(process.env.MINLEN || 3) };

function osm(radiusM = 90) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((pt[0] * Math.PI) / 180));
  const bbox = [pt[1] - dLon, pt[0] - dLat, pt[1] + dLon, pt[0] + dLat].join(',');
  const raw = execFileSync('curl', ['-sS', '--fail', '-A', 'sveag-aufmass',
    `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`], { maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(raw);
  const nodes = new Map();
  for (const e of data.elements) if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
  const streets = [], buildings = [];
  for (const e of data.elements) {
    if (e.type !== 'way' || !e.nodes) continue;
    const t = e.tags || {};
    const g = e.nodes.map((n) => nodes.get(n)).filter(Boolean);
    if (g.length < 2) continue;
    if (t.building) buildings.push(g);
    else if (t.highway) streets.push(g);
  }
  return { streets, buildings };
}

const summe = (chains) => Math.round(chains.reduce((n, c) => n + c.lengthM, 0) * 10) / 10;

// Gebaeude, in dem der Punkt liegt; sonst das mit dem naechsten Stuetzpunkt.
function pickBuilding(buildings) {
  const drin = buildings.filter((b) => ringContains(b, pt));
  if (drin.length) return drin[0];
  let best = null, bestD = Infinity;
  for (const b of buildings) {
    for (const p of b) {
      const d = Math.hypot((p[0] - pt[0]) * 111320, (p[1] - pt[1]) * 111320 * Math.cos(pt[0] * Math.PI / 180));
      if (d < bestD) { bestD = d; best = b; }
    }
  }
  return bestD <= 40 ? best : null;
}

(async () => {
  const res = { ok: true };
  const { streets, buildings } = osm();

  const wfs = REG.WFS_BY_STATE[state];
  if (wfs) {
    try {
      const pq = JSON.parse(execFileSync('node', [
        path.join(__dirname, '..', 'cv', 'parcel-query.js'),
        String(pt[0]), String(pt[1]), JSON.stringify(wfs), '100', '25'], { stdio: ['ignore','pipe','ignore'] }).toString());
      res.flurstueck = pq.containing.length ? summe(extractFrontage(pq.containing, streets, opts)) : null;
      res.truncated = pq.truncated;
    } catch { res.flurstueck = null; }
  }

  const b = pickBuilding(buildings);
  res.gebaeude = b ? summe(extractFrontage([b], streets, opts)) : null;
  res.gebaeudeUmfang = b ? Math.round(require('../vendor/geo.js').polylineLengthM(b.concat([b[0]])) * 10) / 10 : null;
  console.log(JSON.stringify(res));
})().catch((e) => console.log(JSON.stringify({ ok: false, grund: e.message.slice(0, 90) })));
