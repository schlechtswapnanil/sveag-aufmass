#!/usr/bin/env node
// Gehweg fuer eine ganze Wohnanlage: Spanne aufloesen, je Adresse messen,
// Doppeltes abziehen.
//
//   node tools/estate-frontage.js work/potsdam-test.json -o work/potsdam-estate.json
//
// Warum nicht einfach summieren: benachbarte Haeuser einer Anlage liegen oft
// auf DEMSELBEN Flurstueck. Deren Front ist dieselbe Linie, einmal je Adresse
// gezaehlt waere sie zwanzigfach im Angebot. Zusammengefasst wird deshalb ueber
// die Geometrie - gleiche Linie, einmal gezaehlt.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { predictGehweg } = require('../src/frontage.js');
const { geocode, Cache } = require('../src/geocode.js');
const { ringContains } = require('../vendor/parcel.js');
const { haversineM, polylineLengthM } = require('../vendor/geo.js');
const REG = require('../vendor/registries.json');

const [inPath, ...rest] = process.argv.slice(2);
let out = null;
for (let i = 0; i < rest.length; i++) if (rest[i] === '-o') out = rest[++i];

function osm(pt, radiusM = 120) {
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(pt[0] * Math.PI / 180));
  const bbox = [pt[1] - dLon, pt[0] - dLat, pt[1] + dLon, pt[0] + dLat].join(',');
  const raw = execFileSync('curl', ['-sS', '--fail', '--max-time', '30', '-A', 'sveag-aufmass',
    `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`], { maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(raw);
  const nodes = new Map();
  for (const e of data.elements) if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
  const streets = [], buildings = [];
  for (const e of data.elements) {
    if (e.type !== 'way' || !e.nodes) continue;
    const t = e.tags || {}, g = e.nodes.map((n) => nodes.get(n)).filter(Boolean);
    if (g.length < 2) continue;
    if (t.building) buildings.push(g); else if (t.highway) streets.push(g);
  }
  return { streets, buildings };
}

function pickBuilding(bs, pt) {
  const drin = bs.filter((b) => ringContains(b, pt));
  if (drin.length) return drin[0];
  let best = null, bd = Infinity;
  for (const b of bs) for (const p of b) { const d = haversineM(p, pt); if (d < bd) { bd = d; best = b; } }
  return bd <= 40 ? best : null;
}

// Kennung einer Linie, grob genug um Rundungsrauschen zu ueberstehen, fein
// genug um zwei verschiedene Fronten zu unterscheiden (~1 m).
const sig = (pts) => pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('|');

(async () => {
  const zeilen = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const cache = new Cache('work/geocode-cache.json');
  const ergebnis = [];
  for (const [idx, z] of zeilen.entries()) {
    // --plain: eine Adresse je Zeile. Die lesbare Ausgabe kuerzt ab acht
    // Teilen ab, was bei einer 27er-Anlage stillschweigend 19 Haeuser
    // verschluckt hat.
    const teile = execFileSync('python3', ['tools/expand-range.py', '--plain', z.original])
      .toString().split('\n').map((s) => s.trim()).filter(Boolean);
    const adressen = teile.map((t) => `${t}, ${z.ort || 'Potsdam'}`);

    const gesehen = new Set();
    let summe = 0, getroffen = 0;
    const details = [];
    for (const a of adressen) {
      let geo = null;
      try { geo = await geocode(a, { cache }); } catch { /* weiter */ }
      if (!geo) continue;
      getroffen++;
      let g;
      try { g = osm([geo.lat, geo.lon]); } catch { continue; }
      let parcel = null;
      const wfs = REG.WFS_BY_STATE[geo.state];
      if (wfs) {
        try {
          const pq = JSON.parse(execFileSync('node', ['cv/parcel-query.js',
            String(geo.lat), String(geo.lon), JSON.stringify(wfs), '100', '25'],
            { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
          parcel = pq.containing.length ? pq.containing : null;
        } catch { /* ohne Flurstueck weiter */ }
      }
      const p = predictGehweg({ parcelRings: parcel, buildingRing: pickBuilding(g.buildings, [geo.lat, geo.lon]), streets: g.streets });
      if (!p) continue;
      for (const c of p.chains) {
        const s = sig(c.points);
        if (gesehen.has(s)) continue;      // dieselbe Front schon gezaehlt
        gesehen.add(s);
        summe += c.lengthM;
      }
      details.push({ adresse: a, m: p.lengthM });
      await new Promise((r) => setTimeout(r, 200));
    }
    ergebnis.push({ original: z.original, sollM: z.gesamtM,
                    adressen: adressen.length, geocodiert: getroffen,
                    summeM: Math.round(summe * 10) / 10, details });
    process.stderr.write(`\r  ${idx + 1}/${zeilen.length}  ${z.original.slice(0, 34)}`.padEnd(60));
    if (out) fs.writeFileSync(out, JSON.stringify(ergebnis, null, 1));
  }
  cache.save();
  process.stderr.write('\n');
  if (out) fs.writeFileSync(out, JSON.stringify(ergebnis, null, 1));
})();
