#!/usr/bin/env node
// Zieht geo.js, parcel.js und die beiden Dienst-Register aus dem gebauten
// Aufmass-HTML nach vendor/.
//
// Der Luftbild-Schritt braucht dieselbe UTM-Umrechnung, dieselbe
// GML-Auswertung und dieselben Dienst-URLs wie das Tool - nachprogrammiert
// waeren es zwei Wahrheiten, die auseinanderlaufen. Sobald das Quell-Repo
// vorliegt, sollte hier direkt darauf verwiesen werden statt aufs Bundle.
//
//   node cv/extract-vendor.js ../Aufmass_2026-08-21.html
//
// Ziel ist automation/vendor/ - sowohl der Luftbild-Schritt als auch der
// Sheet-Export brauchen die Modelle des Tools.

const fs = require('node:fs');
const path = require('node:path');

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('Aufruf: node extract-vendor.js <Aufmass_*.html>');
  process.exit(2);
}

const html = fs.readFileSync(srcPath, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const vendorDir = path.join(__dirname, '..', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

// Bloecke werden ueber ihren Kopfkommentar gefunden, nicht ueber ihre
// Position - eine neue Tool-Version darf sie umsortieren.
function findBlock(marker, what) {
  const block = blocks.find((b) => marker.test(b));
  if (!block) {
    console.error(`✖ ${what} nicht gefunden (Marker ${marker}) - Tool-Version geaendert?`);
    process.exit(1);
  }
  return block;
}

const MODULES = {
  'geo.js': /Geodesic length helpers/,
  'model.js': /Data model: objects with categorized measured lines/,
  'parcel.js': /Cadastral parcel helpers/,
};
for (const [file, marker] of Object.entries(MODULES)) {
  const block = findBlock(marker, file);
  fs.writeFileSync(
    path.join(vendorDir, file),
    `// AUTOMATISCH ENTNOMMEN aus ${path.basename(srcPath)} - nicht von Hand aendern.\n${block}`
  );
  console.error(`✔ ../vendor/${file} (${block.length} Zeichen)`);
}

// Die Register sind keine Module, sondern Daten. wfs.js greift auf
// wgs84ToUtm als Global zu, deshalb wird es hineingereicht - dafuer muessen
// die Modul-Dateien oben schon geschrieben sein.
const { wgs84ToUtm } = require('../vendor/parcel.js');
const REGISTRIES = {
  WMS_BY_STATE: /Open state orthophoto/,
  WFS_BY_STATE: /Open cadastral parcel/,
};
const registries = {};
for (const [name, marker] of Object.entries(REGISTRIES)) {
  const block = findBlock(marker, `Register ${name}`);
  registries[name] = new Function('wgs84ToUtm', `${block}\nreturn ${name};`)(wgs84ToUtm);
  console.error(`✔ ${name}: ${Object.keys(registries[name]).length} Bundeslaender`);
}
fs.writeFileSync(path.join(vendorDir, 'registries.json'), JSON.stringify(registries, null, 2));
