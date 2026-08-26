#!/usr/bin/env node
// Vorhersage gegen die tatsaechlich gemessene Geometrie - nicht nur gegen die
// Laenge.
//
//   node tools/score-geometry.js work/georef.json work/geom2.json
//
// Die Laenge kann aus dem falschen Grund stimmen: bei Daumierstrasse 20 liegt
// die Vorhersage auf der Gebaeudefassade, die Handmessung ein paar Meter
// weiter auf dem Gehweg. Gleiche Laenge, versetzte Lage - im Laengenvergleich
// ein Volltreffer, auf der Karte danebengelegt.
//
// Gemessen wird deshalb ueberdeckend:
//   Trefferquote (recall)    wie viel der gemessenen Strecke die Vorhersage abdeckt
//   Genauigkeit  (precision) wie viel der Vorhersage auf der Strecke liegt
// Beides bei einer Toleranz, die dem Zeichnen im Tool entspricht.

const fs = require('node:fs');
const { haversineM } = require('../vendor/geo.js');
const { predictGehweg } = require('../src/frontage.js');

const [georefPath, geomPath] = process.argv.slice(2);
const georef = JSON.parse(fs.readFileSync(georefPath, 'utf8'));
const geom = JSON.parse(fs.readFileSync(geomPath, 'utf8'));
const norm = (s) => String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe')
  .replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/straße|strasse|str\./g, 'str').replace(/[^a-z0-9]/g, '');
const nummer = (s) => norm(s).replace(/([0-9]+)[a-z](?![0-9])/g, '$1');
const pos = new Map();
for (const r of geom) { pos.set(norm(r.address), r); pos.set(nummer(r.address), r); }

const M = (p, ref) => [(p[1] - ref[1]) * 111320 * Math.cos(ref[0] * Math.PI / 180), (p[0] - ref[0]) * 111320];
function d2seg(p, a, b, ref) {
  const P = M(p, ref), A = M(a, ref), B = M(b, ref);
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(P[0] - A[0], P[1] - A[1]);
  let t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy);
}
// Strecke in 1-m-Schritte zerlegen, damit die Quote laengengewichtet ist
function stuetz(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const n = Math.max(1, Math.round(haversineM(pts[i - 1], pts[i])));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
    }
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}
const nahAn = (p, linien, ref, tol) => linien.some((l) => {
  for (let i = 1; i < l.length; i++) if (d2seg(p, l[i - 1], l[i], ref) <= tol) return true;
  return false;
});

for (const TOL of [4, 8, 12]) {
  let tSum = 0, tTreffer = 0, pSum = 0, pTreffer = 0, objekte = 0;
  const je = [];
  for (const g of georef) {
    if (!g.geprueft) continue;
    const wege = g.strecken.filter((s) => s.kategorie === 'gehweg');
    if (!wege.length) continue;
    const rec = pos.get(norm(g.adresse)) || pos.get(nummer(g.adresse));
    if (!rec || !rec.streets) continue;
    const p = predictGehweg({ parcelRings: rec.parcel, buildingRing: rec.building, streets: rec.streets });
    if (!p) continue;
    const ref = wege[0].punkte[0];
    const wahr = wege.map((w) => w.punkte);
    const vorher = p.chains.map((c) => c.points);

    let a = 0, b = 0, c = 0, d = 0;
    for (const l of wahr) for (const pt of stuetz(l)) { a++; if (nahAn(pt, vorher, ref, TOL)) b++; }
    for (const l of vorher) for (const pt of stuetz(l)) { c++; if (nahAn(pt, wahr, ref, TOL)) d++; }
    tSum += a; tTreffer += b; pSum += c; pTreffer += d; objekte++;
    je.push({ adresse: g.adresse, recall: a ? b / a : 0, prec: c ? d / c : 0 });
  }
  const R = tTreffer / tSum, P = pTreffer / pSum;
  console.log(`Toleranz ${String(TOL).padStart(2)} m:  Trefferquote ${(R * 100).toFixed(0).padStart(3)} %   `
    + `Genauigkeit ${(P * 100).toFixed(0).padStart(3)} %   F1 ${((2 * R * P / (R + P)) * 100).toFixed(0)} %   (${objekte} Objekte)`);
  if (TOL === 8) {
    je.sort((x, y) => x.recall - y.recall);
    console.log('\n  schlechteste Abdeckung:');
    for (const o of je.slice(0, 5)) console.log(`    ${o.adresse.slice(0, 38).padEnd(40)} abgedeckt ${(o.recall * 100).toFixed(0).padStart(3)} %  davon richtig ${(o.prec * 100).toFixed(0).padStart(3)} %`);
    console.log('  beste:');
    for (const o of je.slice(-3).reverse()) console.log(`    ${o.adresse.slice(0, 38).padEnd(40)} abgedeckt ${(o.recall * 100).toFixed(0).padStart(3)} %  davon richtig ${(o.prec * 100).toFixed(0).padStart(3)} %`);
    console.log();
  }
}
