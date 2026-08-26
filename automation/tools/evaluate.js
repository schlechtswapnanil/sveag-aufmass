#!/usr/bin/env node
// Kandidaten fuer die Gehweg-Laenge gegen die Handmessung pruefen.
//
//   node tools/evaluate.js <ground-truth.json> <import.json> [-o ergebnis.json]
//
// Drei Vorhersagen je Adresse:
//   flurstueck  - Kanten des Flurstuecks entlang der Strasse (heutiger Stand)
//   gebaeude    - strassenseitige Kanten des OSM-Gebaeudegrundrisses
//   proAdresse  - gebaeude geteilt durch die Zahl der Hausnummern an diesem
//                 Gebaeude. In Leipzig ist eine Gruenderzeitzeile oft EIN
//                 Polygon fuer ein Dutzend Adressen; die Front gehoert dann
//                 nicht einer Hausnummer allein.
//
// Schreibt fortlaufend, damit ein Abbruch die bisherigen Zeilen nicht kostet.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { ringContains, extractFrontage } = require('../vendor/parcel.js');
const { polylineLengthM, haversineM } = require('../vendor/geo.js');
const REG = require('../vendor/registries.json');

const [gtPath, importPath, ...rest] = process.argv.slice(2);
let out = null;
for (let i = 0; i < rest.length; i++) if (rest[i] === '-o') out = rest[++i];

const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
const objects = JSON.parse(fs.readFileSync(importPath, 'utf8')).objects;
const byAddr = new Map(objects.map((o) => [o.address, o]));

// Grundform zum Abgleich: die Handmessung schreibt "Flemmingstraße 9a", der
// Geocoder liefert "Flemmingstraße 9". Hausnummernzusatz faellt weg.
const norm = (s) => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/stra(ss|ß)e|str\./g, 'str')
  .replace(/[^a-z0-9]/g, '');
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
    if (t.building) {
      buildings.push(g);
      // Hausnummer am Gebaeude selbst zaehlt wie ein Adresspunkt.
      if (t['addr:housenumber']) adressPunkte.push(g[0]);
    } else if (t.highway) streets.push(g);
  }
  return { streets, buildings, adressPunkte };
}

const summe = (chains) => Math.round(chains.reduce((n, c) => n + c.lengthM, 0) * 10) / 10;

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

const ergebnisse = [];
let i = 0;
for (const zeile of gt) {
  i++;
  const o = lookup.get(norm(zeile.address)) || lookup.get(numOnly(zeile.address));
  const r = { address: zeile.address, manuell: zeile.Gehweg ?? null };
  if (!o) { r.grund = 'keine Koordinate'; ergebnisse.push(r); continue; }
  const pt = [o.lat, o.lon];
  r.lat = o.lat; r.lon = o.lon; r.state = o.bundesland;
  try {
    const { streets, buildings, adressPunkte } = osm(pt);
    const b = pickBuilding(buildings, pt);
    if (b) {
      r.gebaeude = summe(extractFrontage([b], streets));
      r.gebaeudeUmfang = Math.round(polylineLengthM(b.concat([b[0]])) * 10) / 10;
      r.adressen = adressPunkte.filter((p) => ringContains(b, p)).length || 1;
      r.proAdresse = Math.round((r.gebaeude / r.adressen) * 10) / 10;
    }
    const wfs = REG.WFS_BY_STATE[o.bundesland];
    if (wfs) {
      const pq = JSON.parse(execFileSync('node', [
        path.join(__dirname, '..', 'cv', 'parcel-query.js'),
        String(pt[0]), String(pt[1]), JSON.stringify(wfs), '100', '25'],
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      r.flurstueck = pq.containing.length ? summe(extractFrontage(pq.containing, streets)) : null;
      r.truncated = pq.truncated;
    }
  } catch (e) { r.grund = e.message.slice(0, 80); }
  ergebnisse.push(r);
  process.stderr.write(`\r  ${i}/${gt.length}`);
  if (out && i % 5 === 0) fs.writeFileSync(out, JSON.stringify(ergebnisse, null, 1));
}
process.stderr.write('\n');
if (out) fs.writeFileSync(out, JSON.stringify(ergebnisse, null, 1));
else process.stdout.write(JSON.stringify(ergebnisse, null, 1));
