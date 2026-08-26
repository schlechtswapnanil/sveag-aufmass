#!/usr/bin/env node
// Parameter von extractFrontage an den Handmessungen ausrichten.
//
//   node tools/fit.js work/geom.json
//
// "Modell" ist hier keine gelernte Funktion, sondern drei Zahlen:
//   maxDistM     wie nah eine Kante an der Strasse liegen muss
//   maxAngleDeg  wie parallel sie dazu verlaufen muss
//   minLenM      ab welcher Laenge ein Stueck zaehlt
//
// Mehr ist mit 85 Beispielen auch nicht zu rechtfertigen. Deshalb:
// Rastersuche auf einer Trainingshaelfte, Bewertung auf der anderen. Wer die
// Parameter auf allen Daten sucht und dort auch bewertet, misst nur, wie gut
// er sich an die Stichprobe angepasst hat.

const fs = require('node:fs');
const { extractFrontage } = require('../vendor/parcel.js');

const geom = JSON.parse(fs.readFileSync(process.argv[2] || 'work/geom.json', 'utf8'))
  .filter((r) => r.manuell != null && r.streets && (r.parcel || r.building));

// Feste, aber willkuerfreie Aufteilung: jeder zweite Datensatz. Die Liste ist
// nach Stadtteilen sortiert, ein Schnitt in der Mitte haette ganze Viertel nur
// auf einer Seite.
const train = geom.filter((_, i) => i % 2 === 0);
const test = geom.filter((_, i) => i % 2 === 1);

const summe = (chains) => chains.reduce((n, c) => n + c.lengthM, 0);

function vorhersage(rec, opts) {
  const werte = [];
  if (rec.parcel) werte.push(summe(extractFrontage(rec.parcel, rec.streets, opts)));
  if (rec.building) werte.push(summe(extractFrontage([rec.building], rec.streets, opts)));
  const gueltig = werte.filter((v) => v > 0);
  return gueltig.length ? Math.min(...gueltig) : null;
}

function bewerte(daten, opts) {
  const rel = [];
  const abs = [];
  for (const rec of daten) {
    const v = vorhersage(rec, opts);
    if (v == null) continue;
    abs.push(Math.abs(v - rec.manuell));
    if (rec.manuell > 0) rel.push(Math.abs(v - rec.manuell) / rec.manuell);
  }
  if (!rel.length) return null;
  const sortiert = [...rel].sort((a, b) => a - b);
  return {
    n: rel.length,
    medianRel: sortiert[Math.floor(sortiert.length / 2)],
    medianAbs: [...abs].sort((a, b) => a - b)[Math.floor(abs.length / 2)],
    p20: rel.filter((r) => r <= 0.2).length / rel.length,
    p50: rel.filter((r) => r <= 0.5).length / rel.length,
  };
}

const RASTER = [];
for (const maxDistM of [5, 8, 10, 12, 15, 20, 25]) {
  for (const maxAngleDeg of [15, 20, 30, 40, 50]) {
    for (const minLenM of [1, 3, 5, 8]) RASTER.push({ maxDistM, maxAngleDeg, minLenM });
  }
}

const ausgangs = { maxDistM: 15, maxAngleDeg: 30, minLenM: 3 };
console.log(`Train ${train.length}, Test ${test.length}, ${RASTER.length} Parametersaetze\n`);

let beste = null;
for (const opts of RASTER) {
  const r = bewerte(train, opts);
  if (!r) continue;
  // Zielgroesse: Anteil innerhalb ±20 %. Der Median allein belohnt ein Modell,
  // das die Mitte trifft und die Raender liegen laesst.
  const score = r.p20 + r.p50 / 2;
  if (!beste || score > beste.score) beste = { opts, r, score };
}

const zeig = (name, opts, r) => console.log(
  `${name.padEnd(30)} Median ${(r.medianAbs).toFixed(1).padStart(5)} m  rel ${(r.medianRel * 100).toFixed(0).padStart(3)}%  ` +
  `±20% ${(r.p20 * 100).toFixed(0).padStart(3)}%  ±50% ${(r.p50 * 100).toFixed(0).padStart(3)}%   ${JSON.stringify(opts)}`);

console.log('Auf der Trainingshaelfte gesucht:');
zeig('  Ausgangswerte (Tool)', ausgangs, bewerte(train, ausgangs));
zeig('  bester Satz', beste.opts, beste.r);

console.log('\nAuf der Testhaelfte bewertet - das zaehlt:');
zeig('  Ausgangswerte (Tool)', ausgangs, bewerte(test, ausgangs));
zeig('  bester Satz', beste.opts, bewerte(test, beste.opts));
