#!/usr/bin/env node
// Ergebnisse des Luftbild-Schritts an die Objekte einer Importdatei haengen.
//
//   node tools/merge-cv.js work/x.import.json --cv work/bilder -o work/x.measured.json
//
// Zuordnung ueber den Adress-Slug: cv/run.py --out <slug> schreibt <slug>.json,
// und slugFor(obj.address) liefert denselben Namen. Dieselbe Konvention nutzt
// die Kontrollbild-Spalte im Sheet.
//
// Alles, was von hier kommt, ist `isAssumption: true`. Es ist geraten, bis
// jemand es angesehen hat - und die Kontrollbilder zeigen, dass das noetig ist.

const fs = require('node:fs');
const path = require('node:path');
const { slugFor } = require('../src/to-sheet.js');
const { TOOL_CATEGORIES } = require('../src/brief.js');

const [importPath, ...rest] = process.argv.slice(2);
let cvDir = null;
let out = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--cv') cvDir = rest[++i];
  else if (rest[i] === '-o' || rest[i] === '--out') out = rest[++i];
  else { console.error(`Unbekannte Option: ${rest[i]}`); process.exit(2); }
}
if (!importPath || !cvDir) {
  console.error('Aufruf: merge-cv.js <import.json> --cv <verzeichnis> [-o <measured.json>]');
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(importPath, 'utf8'));
let mitErgebnis = 0;
let linienGesamt = 0;
let verworfen = 0;

for (const obj of state.objects || []) {
  const file = path.join(cvDir, `${slugFor(obj.address)}.json`);
  if (!fs.existsSync(file)) continue;
  const cv = JSON.parse(fs.readFileSync(file, 'utf8'));

  const lines = [];
  for (const [i, s] of (cv.sectors || []).entries()) {
    // `sonstiges` kennt das Tool nicht - categoryTotals() laeuft nur ueber die
    // fuenf CATEGORIES. Solche Linien wuerden still verschwinden, also werden
    // sie hier gezaehlt und gemeldet statt lautlos mitgeschleppt.
    if (!TOOL_CATEGORIES.includes(s.category)) { verworfen++; continue; }
    if (!Array.isArray(s.points) || s.points.length < 2) { verworfen++; continue; }
    lines.push({
      id: `cv-${slugFor(obj.address)}-${i}`,
      category: s.category,
      points: s.points,
      isAssumption: true, // aus dem Luftbild abgeleitet, nicht gemessen
    });
  }

  obj.lines = (obj.lines || []).concat(lines);
  obj.updatedAt = cv.measuredAt || obj.updatedAt;
  obj.sveagLinks = Object.assign({}, obj.sveagLinks, {
    kontrollbild: obj.sveagLinks?.kontrollbild
      || `file://${path.resolve(cvDir, `${slugFor(obj.address)}.debug.png`)}`,
  });
  if (lines.length) mitErgebnis++;
  linienGesamt += lines.length;
}

console.error(`✔ ${mitErgebnis} von ${state.objects.length} Objekt(en) mit Luftbild-Linien, ${linienGesamt} Linie(n)`);
if (verworfen) {
  console.error(`  ! ${verworfen} Sektor(en) verworfen: Kategorie "sonstiges" kennt das Tool nicht.`);
  console.error('    Bei Mehrfamilienhaeusern ist das die Regel, nicht die Ausnahme - siehe cv/README.md.');
}
console.error('  Alle Linien sind isAssumption: true - vor dem Angebot ansehen.');

const json = JSON.stringify(state, null, 2);
if (out) { fs.writeFileSync(out, json); console.error(`✔ geschrieben: ${out}`); }
else process.stdout.write(json + '\n');
