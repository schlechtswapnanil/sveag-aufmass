#!/usr/bin/env node
// Wie viel der tatsaechlich gemessenen Strecke liegt ueberhaupt auf einer
// Kante, die in den Vektordaten steht?
//
//   node tools/analyse-georef.js work/georef.json work/geom2.json
//
// Das ist die entscheidende Frage fuer die Obergrenze. Laeuft ein Gehweg
// entlang der Flurstuecks- oder Gebaeudekante, kann ein geometrisches
// Verfahren ihn finden. Laeuft er quer ueber das Grundstueck, kann es das
// grundsaetzlich nicht - egal wie die Parameter stehen.

const fs = require('node:fs');
const { haversineM } = require('../vendor/geo.js');

const [georefPath, geomPath] = process.argv.slice(2);
const georef = JSON.parse(fs.readFileSync(georefPath, 'utf8'));
const geom = JSON.parse(fs.readFileSync(geomPath, 'utf8'));

const norm = (s) => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/straße|strasse|str\./g, 'str').replace(/[^a-z0-9]/g, '');
const nummer = (s) => norm(s).replace(/([0-9]+)[a-z](?![0-9])/g, '$1');
const pos = new Map();
for (const r of geom) { pos.set(norm(r.address), r); pos.set(nummer(r.address), r); }

// Abstand eines Punktes zur naechsten Kante einer Kantenmenge, in Metern.
function abstandZuKanten(p, ringe) {
  let best = Infinity;
  for (const ring of ringe) {
    for (let i = 1; i < ring.length; i++) {
      const d = punktZuStrecke(p, ring[i - 1], ring[i]);
      if (d < best) best = d;
    }
  }
  return best;
}

function punktZuStrecke(p, a, b) {
  const la = (a[0] + b[0]) / 2 * Math.PI / 180;
  const X = (q) => [(q[1] - a[1]) * 111320 * Math.cos(la), (q[0] - a[0]) * 111320];
  const P = X(p), B = X(b);
  const len2 = B[0] * B[0] + B[1] * B[1];
  if (len2 === 0) return Math.hypot(P[0], P[1]);
  let t = (P[0] * B[0] + P[1] * B[1]) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P[0] - t * B[0], P[1] - t * B[1]);
}

// Strecke in 1-m-Schritte zerlegen, damit der Anteil laengengewichtet ist.
function stuetzpunkte(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i]);
    const n = Math.max(1, Math.round(d));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const TOLERANZ = 4; // m - grosszuegig, Zeichengenauigkeit im Tool ist begrenzt
let gesamt = 0, aufFlur = 0, aufGeb = 0, aufEinem = 0, objekte = 0;
const proObjekt = [];

for (const g of georef) {
  if (!g.geprueft || !g.strecken) continue;
  const rec = pos.get(norm(g.adresse)) || pos.get(nummer(g.adresse));
  if (!rec || (!rec.parcel && !rec.building)) continue;
  const gehwege = g.strecken.filter((s) => s.kategorie === 'gehweg');
  if (!gehwege.length) continue;

  let n = 0, f = 0, b = 0, e = 0;
  for (const s of gehwege) {
    for (const p of stuetzpunkte(s.punkte)) {
      n++;
      const dF = rec.parcel ? abstandZuKanten(p, rec.parcel) : Infinity;
      const dG = rec.building ? abstandZuKanten(p, [rec.building]) : Infinity;
      if (dF <= TOLERANZ) f++;
      if (dG <= TOLERANZ) b++;
      if (Math.min(dF, dG) <= TOLERANZ) e++;
    }
  }
  gesamt += n; aufFlur += f; aufGeb += b; aufEinem += e; objekte++;
  proObjekt.push({ adresse: g.adresse, n, anteil: e / n });
}

const pct = (a, b) => (b ? (a / b * 100).toFixed(0) : '0') + ' %';
console.log(`${objekte} Objekte mit geprueft verorteter Gehweg-Geometrie, ${gesamt} Stuetzpunkte je 1 m\n`);
console.log(`Anteil der gemessenen Gehweg-Laenge, der innerhalb ${TOLERANZ} m liegt von`);
console.log(`  einer Flurstueckskante      ${pct(aufFlur, gesamt)}`);
console.log(`  einer Gebaeudekante         ${pct(aufGeb, gesamt)}`);
console.log(`  einer der beiden            ${pct(aufEinem, gesamt)}`);

proObjekt.sort((a, b) => a.anteil - b.anteil);
console.log('\nObjekte, deren Gehweg am wenigsten auf einer Kante liegt:');
for (const o of proObjekt.slice(0, 8)) {
  console.log(`  ${o.adresse.slice(0, 40).padEnd(42)} ${(o.anteil * 100).toFixed(0).padStart(3)} % auf Kante  (${o.n} m)`);
}
const gut = proObjekt.filter((o) => o.anteil >= 0.8).length;
console.log(`\n${gut} von ${objekte} Objekten liegen zu mindestens 80 % auf einer Kante.`);
