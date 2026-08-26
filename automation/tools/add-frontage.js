#!/usr/bin/env node
// Gehweg-Vorschlag als echte Linie an die Objekte haengen.
//
//   node tools/add-frontage.js <import.json> --geom <geom.json> -o <measured.json>
//
// Anders als eine blosse Zahl entsteht hier eine Polylinie, die das Tool
// zeichnen kann - die Freigabe sieht also, WO der Gehweg liegt, nicht nur wie
// lang er sein soll. Alles bleibt isAssumption: true.

const fs = require('node:fs');
const { predictGehweg, FITTED } = require('../src/frontage.js');

const [importPath, ...rest] = process.argv.slice(2);
let geomPath = null, out = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--geom') geomPath = rest[++i];
  else if (rest[i] === '-o' || rest[i] === '--out') out = rest[++i];
  else { console.error(`Unbekannte Option: ${rest[i]}`); process.exit(2); }
}
if (!importPath || !geomPath) {
  console.error('Aufruf: add-frontage.js <import.json> --geom <geom.json> [-o <measured.json>]');
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(importPath, 'utf8'));
const geom = JSON.parse(fs.readFileSync(geomPath, 'utf8'));

// Zuordnung ueber die Koordinate: der Geometrie-Datensatz traegt denselben
// Punkt, mit dem das Objekt angelegt wurde.
const byPt = new Map();
for (const g of geom) {
  if (g.pt) byPt.set(`${g.pt[0].toFixed(6)},${g.pt[1].toFixed(6)}`, g);
}

let gesetzt = 0, ohne = 0, weitAuseinander = 0;
for (const obj of state.objects || []) {
  const g = byPt.get(`${obj.lat.toFixed(6)},${obj.lon.toFixed(6)}`);
  if (!g || !g.streets) { ohne++; continue; }
  const p = predictGehweg({ parcelRings: g.parcel, buildingRing: g.building, streets: g.streets });
  if (!p) { ohne++; continue; }

  obj.lines = (obj.lines || []).filter((l) => l.id !== 'front-gehweg').concat(
    p.chains.map((c, i) => ({
      id: `front-gehweg-${i}`,
      category: 'gehweg',
      points: c.points,
      isAssumption: true, // aus Geometrie hergeleitet, nicht vor Ort gemessen
    }))
  );
  obj.sveagFrontage = {
    lengthM: p.lengthM, source: p.source, spreadM: p.spreadM, params: FITTED,
  };
  gesetzt++;
  // Weichen Kataster und Gebaeude stark ab, steckt meist ein Sammelflurstueck
  // oder ein Sammelpolygon dahinter - dann ist die kleinere Zahl zwar die
  // bessere, aber nicht unbedingt die richtige.
  if (p.spreadM > 3 * p.lengthM) weitAuseinander++;
}

console.error(`✔ Gehweg-Vorschlag an ${gesetzt} von ${state.objects.length} Objekt(en)`);
if (ohne) console.error(`  ! ${ohne} ohne Vorschlag - kurze oder fehlende Front, von Hand messen`);
if (weitAuseinander) {
  console.error(`  ! ${weitAuseinander} mit grossem Abstand zwischen Kataster und Gebaeude`);
  console.error('    (Sammelflurstueck oder Sammelpolygon) - dort besonders genau pruefen');
}
console.error('  Alle Linien sind isAssumption: true.');

const json = JSON.stringify(state, null, 2);
if (out) { fs.writeFileSync(out, json); console.error(`✔ geschrieben: ${out}`); }
else process.stdout.write(json + '\n');
