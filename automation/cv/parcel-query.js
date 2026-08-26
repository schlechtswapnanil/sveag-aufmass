#!/usr/bin/env node
// Flurstueck-Abfrage fuer den Luftbild-Schritt.
//   node parcel-query.js <lat> <lon> <wfsConfigJson> <count> <marginM>
// Gibt { rings, containing, truncated } als JSON auf stdout.

const m = require('../vendor/parcel.js');

const [lat, lon, cfgJson, countArg, marginArg] = process.argv.slice(2);
const cfg = JSON.parse(cfgJson);
const count = Number(countArg || 100);
const margin = Number(marginArg || 25);
const pt = [Number(lat), Number(lon)];

function urlFor(n) {
  let bbox;
  if (cfg.epsg === 25832 || cfg.epsg === 25833) {
    const [e, no] = m.wgs84ToUtm(pt[0], pt[1], cfg.epsg === 25832 ? 32 : 33);
    bbox = [e - margin, no - margin, e + margin, no + margin];
  } else {
    const dLat = margin / 111320;
    const dLon = margin / (111320 * Math.cos((pt[0] * Math.PI) / 180));
    bbox = [pt[0] - dLat, pt[1] - dLon, pt[0] + dLat, pt[1] + dLon];
  }
  const p = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature',
    typeNames: cfg.typeNames, count: String(n),
    bbox: `${bbox.join(',')},urn:ogc:def:crs:EPSG::${cfg.epsg}`,
  });
  if (cfg.outputFormat === 'json') p.set('outputFormat', 'application/json');
  return `${cfg.url}?${p.toString()}`;
}

async function ringsAt(n) {
  const res = await fetch(urlFor(n));
  if (!res.ok) throw new Error(`WFS HTTP ${res.status}`);
  if (cfg.outputFormat === 'json') {
    const data = await res.json();
    return (data.features || [])
      .filter((f) => f.geometry)
      .flatMap((f) => m.ringsFromGeoJson(f.geometry, cfg.epsg));
  }
  return m.ringsFromGml(await res.text(), cfg.epsg);
}

(async () => {
  const rings = await ringsAt(count);
  const containing = rings.filter((r) => m.ringContains(r, pt));

  // Gegenprobe mit dem count=5 des Tools: nur so laesst sich melden, ob die
  // heutige Abfrage an dieser Adresse das richtige Flurstueck ueberhaupt
  // gesehen haette.
  let truncated = false;
  try {
    const few = await ringsAt(5);
    truncated = containing.length > 0 && few.filter((r) => m.ringContains(r, pt)).length === 0;
  } catch { /* Gegenprobe ist optional */ }

  process.stdout.write(JSON.stringify({
    rings, containing, truncated, total: rings.length,
  }));
})().catch((err) => {
  process.stderr.write(String(err.message));
  process.exit(1);
});
