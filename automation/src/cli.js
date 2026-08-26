#!/usr/bin/env node
// CLI fuer den Brief-Teil der Aufmass-Automatisierung.
//
//   node src/cli.js validate <brief.json> [--source <quelltext.txt>]
//   node src/cli.js prepare  <brief.json> [--source <quelltext.txt>] [-o <import.json>]
//   node src/cli.js sheet    <export.json> [-o <zeilen.csv>]
//                            [--images <verzeichnis>] [--image-map <map.json>]
//
// Der Quelltext ist alles, was beim Extrahieren vorlag: Betreffzeile,
// Mailtext und zitierte Vorgaenger-Nachrichten. Er muss vollstaendig sein -
// gegen ihn werden alle Belege geprueft. Fehlt der Betreff darin, laesst sich
// eine dort genannte Adresse nicht belegen. (--email bleibt als alter Name.)
//
// validate  prueft Schema, Konsistenz, Belege und Tier-Einstufung.
// prepare   validiert, geocodiert die Adresse und schreibt eine Datei, die im
//           Aufmass-Tool unter "Objekte -> Import (JSON)" geladen wird.
// sheet     nimmt den Export des Tools NACH dem Messen und schreibt eine
//           Zeile je Position - Kundenangabe und Messung nebeneinander.
//           --image-map traegt Web-Links zu den Kontrollbildern ein (Drive);
//           --images verlinkt stattdessen lokale Dateien per file:// - das
//           taugt zum Selbstnachsehen, nicht zum Verschicken.

const fs = require('node:fs');
const { validateBrief, classifyTier, TIER_LABEL } = require('./brief.js');
const { briefToImportFile, allAddresses, geocodeQuery, categoriesToMeasure } = require('./to-aufmass.js');
const { geocode } = require('./geocode.js');
const { sheetRows, toCsv, COLUMNS } = require('./to-sheet.js');

function parseArgs(argv) {
  const [command, briefPath, ...rest] = argv;
  const opts = { command, briefPath, email: null, out: null, images: null, imageMap: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--source' || rest[i] === '--email') opts.email = rest[++i];
    else if (rest[i] === '-o' || rest[i] === '--out') opts.out = rest[++i];
    else if (rest[i] === '--images') opts.images = rest[++i];
    else if (rest[i] === '--image-map') opts.imageMap = rest[++i];
    else throw new Error(`Unbekannte Option: ${rest[i]}`);
  }
  return opts;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`${p} nicht lesbar: ${err.message}`);
  }
}

// Gibt true zurueck, wenn der Brief sauber ist.
function report(brief, emailText) {
  const errors = validateBrief(brief, emailText);
  if (errors.length > 0) {
    console.error(`✖ ${errors.length} Problem(e):`);
    for (const e of errors) console.error(`  - ${e}`);
    return false;
  }
  const tier = classifyTier(brief);
  const toMeasure = categoriesToMeasure(brief);
  console.error(`✔ Brief gueltig · Stufe ${tier} (${TIER_LABEL[tier]})`);
  console.error(
    toMeasure.length
      ? `  zu messen: ${toMeasure.join(', ')}`
      : '  zu messen: nichts - alle Sektoren sind belegt (nur Gegenpruefung)'
  );
  if (!emailText) console.error('  Hinweis: ohne --source wurden die Belege NICHT geprueft.');
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command || !opts.briefPath || !['validate', 'prepare', 'sheet'].includes(opts.command)) {
    console.error(
      'Aufruf:\n' +
      '  cli.js validate <brief.json> [--source <quelltext.txt>]\n' +
      '  cli.js prepare  <brief.json> [--source <quelltext.txt>] [-o <import.json>]\n' +
      '  cli.js sheet    <export.json> [-o <zeilen.csv>]'
    );
    process.exit(2);
  }

  if (opts.command === 'sheet') {
    const state = readJson(opts.briefPath);
    if (!state || state.version !== 1 || !Array.isArray(state.objects)) {
      console.error('✖ Das ist kein Export des Aufmass-Tools ({ version: 1, objects: [...] }).');
      process.exit(1);
    }
    const rows = sheetRows(state, {
      imagesDir: opts.images,
      imageMap: opts.imageMap ? readJson(opts.imageMap) : null,
    });
    if (rows.length === 0) {
      console.error('✖ Keine Positionen - wurde schon gemessen und exportiert?');
      process.exit(1);
    }
    const ungemessen = rows.filter((r) => r.Status === 'nicht gemessen').length;
    const ungefragt = rows.filter((r) => /nicht genannt/.test(r.Hinweis)).length;
    console.error(`✔ ${rows.length} Zeile(n) aus ${state.objects.length} Objekt(en), ${COLUMNS.length} Spalten`);
    if (ungemessen) console.error(`  ! ${ungemessen} Position(en) ohne Messung - im Tool nachtragen.`);
    if (ungefragt) console.error(`  ! ${ungefragt} gemessene Kategorie(n) hat der Kunde nicht genannt.`);
    const mitBild = new Set(rows.filter((r) => r.Kontrollbild).map((r) => r.Objekt)).size;
    const objekte = state.objects.length;
    if (mitBild < objekte) {
      console.error(`  ! Kontrollbild fehlt bei ${objekte - mitBild} von ${objekte} Objekt(en).`);
    }
    if (rows.some((r) => String(r.Kontrollbild).startsWith('file://'))) {
      console.error('  ! file://-Links funktionieren nur auf diesem Rechner - fuer ein geteiltes');
      console.error('    Sheet die Bilder hochladen und --image-map verwenden.');
    }
    console.error('  Alle Zeilen stehen auf "zu pruefen" - die Freigabe setzt den Status.');
    const csv = toCsv(rows);
    if (opts.out) {
      fs.writeFileSync(opts.out, csv);
      console.error(`✔ geschrieben: ${opts.out} - in Google Sheets über Datei → Importieren einlesen.`);
    } else {
      process.stdout.write(csv);
    }
    return;
  }

  const brief = readJson(opts.briefPath);
  const emailText = opts.email ? fs.readFileSync(opts.email, 'utf8') : null;

  if (!report(brief, emailText)) process.exit(1);
  if (opts.command === 'validate') return;

  const queries = allAddresses(brief);
  if (queries.length === 0) {
    console.error(
      '✖ Der Brief hat keine Adresse (addressSource="' +
      (brief.object.addressSource || '?') + '").\n' +
      '  Anfragen von Hausverwaltungen nennen sie oft nur im Betreff oder in der\n' +
      '  Vorgaenger-Mail. Adresse nachtragen und erneut ausfuehren - ohne sie\n' +
      '  gibt es kein Objekt und keine Messung.'
    );
    process.exit(1);
  }
  if (queries.length > 1) {
    console.error(`  ${queries.length} Adressen im Auftrag - es entstehen ${queries.length} Objekte.`);
  }

  const geos = [];
  for (const address of queries) {
    const query = geocodeQuery(brief, address);
    const geo = await geocode(query);
    if (!geo) {
      console.error(`✖ Kein Geocoding-Treffer fuer "${query}" - Adresse pruefen.`);
      process.exit(1);
    }
    if (geo.countryCode && geo.countryCode !== 'DE') {
      // Ein unvollstaendiger oder vertippter Suchbegriff findet irgendwo auf
      // der Welt irgendetwas. Ausserhalb Deutschlands ist das nie der Ort.
      console.error(
        `✖ Geocoding-Treffer liegt in ${geo.countryCode}, nicht in Deutschland: "${geo.label}".\n` +
        '  Adresse im Brief pruefen.'
      );
      process.exit(1);
    }
    console.error(`  Adresse: ${geo.label} (${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)}) · ${geo.state || 'Bundesland unbekannt'}`);
    if (!geo.state) {
      // Ohne Bundesland findet das Tool weder das Landes-Luftbild (WMS) noch
      // den Flurstuecks-Dienst (WFS) - der Gehweg-Vorschlag entfaellt dann.
      console.error('  ! Ohne Bundesland: kein Landes-Luftbild und kein Flurstueck-Vorschlag im Tool.');
    }
    // Photon liefert bei mehrdeutigen Strassennamen gern die falsche von
    // mehreren gleichnamigen Strassen einer Stadt. Die PLZ aus der Mail ist
    // der billigste Gegencheck.
    const pc = brief.object.postcode;
    if (pc && !geo.label.includes(pc)) {
      console.error(
        `  ! PLZ-Abweichung: Mail nennt ${pc}, Geocoder liefert "${geo.label}". ` +
        'Vor der Freigabe pruefen - vermutlich eine gleichnamige Strasse im selben Ort.'
      );
    }
    geos.push(geo);
  }

  const file = briefToImportFile(brief, geos);
  const json = JSON.stringify(file, null, 2);
  if (opts.out) {
    fs.writeFileSync(opts.out, json);
    console.error(`✔ geschrieben: ${opts.out} - im Tool unter "Objekte → Import (JSON)" laden.`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
