#!/usr/bin/env node
// Welche Flurstuecks- und Gebaeudekanten folgt der tatsaechlich geraeumte
// Gehweg - und woran erkennt man sie vorher?
//
//   node tools/label-edges.js work/georef.json work/geom2.json
//
// Bisher waehlt extractFrontage() Kanten nach drei von Hand gesetzten Zahlen
// (Abstand zur Strasse, Winkel, Mindestlaenge). Mit der verorteten Geometrie
// laesst sich zum ersten Mal nachsehen, welche Kanten wirklich dazugehoeren,
// und ob andere Merkmale sie besser vorhersagen.

const fs = require('node:fs');
const { haversineM } = require('../vendor/geo.js');

const [georefPath, geomPath] = process.argv.slice(2);
const georef = JSON.parse(fs.readFileSync(georefPath, 'utf8'));
const geom = JSON.parse(fs.readFileSync(geomPath, 'utf8'));
const norm = (s) => String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe')
  .replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/straße|strasse|str\./g, 'str').replace(/[^a-z0-9]/g, '');
const nummer = (s) => norm(s).replace(/([0-9]+)[a-z](?![0-9])/g, '$1');
const pos = new Map();
for (const r of geom) { pos.set(norm(r.address), r); pos.set(nummer(r.address), r); }

const M = (p, ref) => [(p[1] - ref[1]) * 111320 * Math.cos(ref[0] * Math.PI / 180), (p[0] - ref[0]) * 111320];
function distPunktStrecke(p, a, b, ref) {
  const P = M(p, ref), A = M(a, ref), B = M(b, ref);
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(P[0] - A[0], P[1] - A[1]);
  let t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy);
}
const winkel = (a, b, ref) => {
  const A = M(a, ref), B = M(b, ref);
  let d = Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI;
  return ((d % 180) + 180) % 180;
};
const winkelDiff = (a, b) => { const d = Math.abs(a - b) % 180; return d > 90 ? 180 - d : d; };

const kanten = [];
for (const g of georef) {
  if (!g.geprueft) continue;
  const wege = g.strecken.filter((s) => s.kategorie === 'gehweg');
  if (!wege.length) continue;
  const rec = pos.get(norm(g.adresse)) || pos.get(nummer(g.adresse));
  if (!rec || !rec.streets || (!rec.parcel && !rec.building)) continue;
  const ref = (rec.parcel ? rec.parcel[0][0] : rec.building[0]);

  const ringe = [];
  if (rec.parcel) for (const r of rec.parcel) ringe.push({ ring: r, quelle: 'kataster' });
  if (rec.building) ringe.push({ ring: rec.building, quelle: 'gebaeude' });

  for (const { ring, quelle } of ringe) {
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      const laenge = haversineM(a, b);
      if (laenge < 1) continue;
      const mitte = [(a[0] + b[0]) / 2, (b[1] + a[1]) / 2];
      // Merkmale
      let dStrasse = Infinity, strassenWinkel = 0;
      for (const line of rec.streets) for (let s = 1; s < line.length; s++) {
        const d = distPunktStrecke(mitte, line[s - 1], line[s], ref);
        if (d < dStrasse) { dStrasse = d; strassenWinkel = winkel(line[s - 1], line[s], ref); }
      }
      const dWinkel = winkelDiff(winkel(a, b, ref), strassenWinkel);
      // Label: liegt die Kante auf dem tatsaechlichen Gehweg?
      let dWeg = Infinity;
      for (const w of wege) for (let s = 1; s < w.punkte.length; s++) {
        const d = Math.min(distPunktStrecke(a, w.punkte[s - 1], w.punkte[s], ref),
                           distPunktStrecke(b, w.punkte[s - 1], w.punkte[s], ref),
                           distPunktStrecke(mitte, w.punkte[s - 1], w.punkte[s], ref));
        if (d < dWeg) dWeg = d;
      }
      kanten.push({ adresse: g.adresse, quelle, laenge, dStrasse, dWinkel, aufWeg: dWeg <= 4 });
    }
  }
}

const ja = kanten.filter((k) => k.aufWeg), nein = kanten.filter((k) => !k.aufWeg);
console.log(`${kanten.length} Kanten aus ${new Set(kanten.map((k) => k.adresse)).size} Objekten`);
console.log(`  davon auf dem gemessenen Gehweg: ${ja.length} (${(ja.length / kanten.length * 100).toFixed(0)} %)\n`);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
console.log('Merkmal'.padEnd(22) + 'auf dem Weg'.padStart(14) + 'nicht'.padStart(10) + '   Trennung');
for (const [name, f] of [['Abstand zur Strasse', (k) => k.dStrasse],
                         ['Winkel zur Strasse', (k) => k.dWinkel],
                         ['Kantenlaenge', (k) => k.laenge]]) {
  const A = ja.map(f), B = nein.map(f);
  const alle = [...A, ...B];
  const sd = Math.sqrt(alle.reduce((s, x) => s + (x - alle.reduce((p, q) => p + q, 0) / alle.length) ** 2, 0) / alle.length);
  console.log(name.padEnd(22) + med(A).toFixed(1).padStart(14) + med(B).toFixed(1).padStart(10)
    + '   ' + (Math.abs(med(A) - med(B)) / (sd || 1)).toFixed(2));
}
const kat = kanten.filter((k) => k.quelle === 'kataster'), geb = kanten.filter((k) => k.quelle === 'gebaeude');
console.log(`\nAnteil auf dem Weg  Kataster ${(kat.filter((k) => k.aufWeg).length / kat.length * 100).toFixed(0)} %   Gebaeude ${(geb.filter((k) => k.aufWeg).length / geb.length * 100).toFixed(0)} %`);
fs.writeFileSync('work/kanten.json', JSON.stringify(kanten));
