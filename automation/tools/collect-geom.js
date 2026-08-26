#!/usr/bin/env node
// Geometrie je Adresse einmal holen und ablegen.
//
//   node tools/collect-geom.js <ground-truth.json> <import.json> -o geom.json
//
// Damit laesst sich extractFrontage anschliessend beliebig oft mit anderen
// Parametern rechnen, ohne jedes Mal WFS und OSM zu fragen. Ohne das dauert
// eine Rasterssuche ueber drei Parameter Stunden statt Sekunden.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { ringContains } = require('../vendor/parcel.js');
const { haversineM } = require('../vendor/geo.js');
const REG = require('../vendor/registries.json');

const [gtPath, importPath, ...rest] = process.argv.slice(2);
let out = null;
for (let i = 0; i < rest.length; i++) if (rest[i] === '-o') out = rest[++i];

const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
const objects = JSON.parse(fs.readFileSync(importPath, 'utf8')).objects;
const norm = (s) => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/stra(ss|ß)e|str\./g, 'str').replace(/[^a-z0-9]/g, '');
const numOnly = (s) => norm(s).replace(/([0-9]+)[a-z](?![0-9])/g, '$1');
const lookup = new Map();
for (const o of objects) { lookup.set(norm(o.address), o); lookup.set(numOnly(o.address), o); }

function osm(pt, radiusM = 90) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((pt[0] * Math.PI) / 180));
  const bbox = [pt[1] - dLon, pt[0] - dLat, pt[1] + dLon, pt[0] + dLat].join(',');
  const raw = execFileSync('curl', ['-sS', '--fail', '--max-time', '25', '-A', 'sveag-aufmass',
    `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`], { maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(raw);
  const nodes = new Map();
  const adressPunkte = [];
  for (const e of data.elements) {
    if (e.type !== 'node') continue;
    nodes.set(e.id, [e.lat, e.lon]);
    if ((e.tags || {})['addr:housenumber']) adressPunkte.push([e.lat, e.lon]);
  }
  const streets = [], buildings = [];
  for (const e of data.elements) {
    if (e.type !== 'way' || !e.nodes) continue;
    const t = e.tags || {};
    const g = e.nodes.map((n) => nodes.get(n)).filter(Boolean);
    if (g.length < 2) continue;
    if (t.building) buildings.push(g);
    else if (t.highway) streets.push(g);
  }
  return { streets, buildings, adressPunkte };
}

function pickBuilding(buildings, pt) {
  const drin = buildings.filter((b) => ringContains(b, pt));
  if (drin.length) return drin[0];
  let best = null, bestD = Infinity;
  for (const b of buildings) for (const p of b) {
    const d = haversineM(p, pt);
    if (d < bestD) { bestD = d; best = b; }
  }
  return bestD <= 40 ? best : null;
}

const alles = [];
let i = 0;
for (const zeile of gt) {
  i++;
  const o = lookup.get(norm(zeile.address)) || lookup.get(numOnly(zeile.address));
  const rec = { address: zeile.address, manuell: zeile.Gehweg ?? null };
  if (o) {
    const pt = [o.lat, o.lon];
    rec.pt = pt; rec.state = o.bundesland;
    try {
      const { streets, buildings, adressPunkte } = osm(pt);
      const b = pickBuilding(buildings, pt);
      rec.streets = streets;
      rec.building = b;
      // Alle Gebaeude im Ausschnitt mitnehmen: erst daran laesst sich
      // erkennen, ob ein Flurstueck ein Sammelflurstueck ist (viele Gebaeude
      // darin) oder das Grundstueck genau dieses einen Hauses.
      rec.buildings = buildings;
      rec.adressen = b ? (adressPunkte.filter((p) => ringContains(b, p)).length || 1) : null;
      const wfs = REG.WFS_BY_STATE[o.bundesland];
      if (wfs) {
        const pq = JSON.parse(execFileSync('node', [
          path.join(__dirname, '..', 'cv', 'parcel-query.js'),
          String(pt[0]), String(pt[1]), JSON.stringify(wfs), '100', '25'],
          { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
        rec.parcel = pq.containing.length ? pq.containing : null;
      }
    } catch (e) { rec.grund = e.message.slice(0, 80); }
  }
  alles.push(rec);
  process.stderr.write(`\r  ${i}/${gt.length}`);
  if (out && i % 5 === 0) fs.writeFileSync(out, JSON.stringify(alles));
}
process.stderr.write('\n');
fs.writeFileSync(out, JSON.stringify(alles));
console.error(`✔ ${alles.filter((r) => r.streets).length} Datensaetze mit Geometrie -> ${out}`);
