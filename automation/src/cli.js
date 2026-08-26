#!/usr/bin/env node
// CLI fuer den Brief-Teil der Aufmass-Automatisierung.
//
//   node src/cli.js validate <brief.json> [--source <quelltext.txt>]
//   node src/cli.js prepare  <brief.json> [--source <quelltext.txt>] [-o <import.json>]
//   node src/cli.js sheet    <export.json> [-o <zeilen.csv>]
//                            [--images <verzeichnis>] [--image-map <map.json>]
//                            [--append <sheet.csv>]
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
//           --append schreibt einen bestehenden Bestand fort, ohne Zeilen zu
//           verdoppeln und ohne Freigabe-Vermerke zu ueberschreiben.
//           --image-map traegt Web-Links zu den Kontrollbildern ein (Drive);
//           --images verlinkt stattdessen lokale Dateien per file:// - das
//           taugt zum Selbstnachsehen, nicht zum Verschicken.

const fs = require('node:fs');
const path = require('node:path');
const { validateBrief, classifyTier, TIER_LABEL } = require('./brief.js');
const { briefToImportFile, allAddresses, geocodeQuery, categoriesToMeasure } = require('./to-aufmass.js');
const { geocode, Cache } = require('./geocode.js');
const { sheetRows, toCsv, fromCsv, mergeRows, COLUMNS } = require('./to-sheet.js');

function parseArgs(argv) {
  const [command, briefPath, ...rest] = argv;
  const opts = { command, briefPath, email: null, out: null, images: null, imageMap: null, append: null, cache: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--source' || rest[i] === '--email') opts.email = rest[++i];
    else if (rest[i] === '-o' || rest[i] === '--out') opts.out = rest[++i];
    else if (rest[i] === '--images') opts.images = rest[++i];
    else if (rest[i] === '--image-map') opts.imageMap = rest[++i];
    else if (rest[i] === '--append') opts.append = rest[++i];
    else if (rest[i] === '--cache') opts.cache = rest[++i];
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
    let ausgabe = rows;
    if (opts.append) {
      if (!fs.existsSync(opts.append)) {
        console.error(`  Bestand ${opts.append} existiert noch nicht - er wird neu angelegt.`);
      } else {
        const bestehend = fromCsv(fs.readFileSync(opts.append, 'utf8'));
        const { rows: zusammen, angehaengt, abweichungen } = mergeRows(bestehend, rows);
        console.error(`  Bestand: ${bestehend.length} Zeile(n), davon ${rows.length - angehaengt.length} schon bekannt.`);
        console.error(`  ${angehaengt.length} Zeile(n) neu angehaengt.`);
        if (abweichungen.length) {
          console.error(`  ! ${abweichungen.length} bekannte Zeile(n) haben jetzt andere Werte.`);
          console.error('    Nicht ueberschrieben - vorhandene Zeilen bleiben, wie die Freigabe sie hinterlassen hat:');
          for (const a of abweichungen.slice(0, 10)) {
            console.error(`      ${a.objekt} · ${a.position} · ${a.feld}: "${a.alt}" -> "${a.neu}"`);
          }
          if (abweichungen.length > 10) console.error(`      … und ${abweichungen.length - 10} weitere`);
        }
        ausgabe = zusammen;
      }
    }
    const csv = toCsv(ausgabe);
    if (opts.out) {
      fs.writeFileSync(opts.out, csv);
      console.error(`✔ geschrieben: ${opts.out} (${ausgabe.length} Zeile(n)) - in Google Sheets über Datei → Importieren einlesen.`);
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

  // Bei einer Objektliste (Portfolio-Anfrage) darf eine unauffindbare Adresse
  // nicht die ganze Vorbereitung kippen. Fehlschlaege werden gesammelt und am
  // Ende benannt - uebersprungen, aber nicht verschwiegen.
  // Zwischenspeicher neben der Ausgabedatei, sonst im Arbeitsverzeichnis.
  // Ein zweiter Lauf ueber dieselbe Liste kostet damit keinen einzigen Aufruf.
  const cache = new Cache(opts.cache || path.join(path.dirname(opts.out || '.'), 'geocode-cache.json'));
  const vorher = cache.size;

  const geos = [];
  const failures = [];
  const leise = queries.length > 5;
  // Bei langen Listen bewusst langsam: der oeffentliche Photon-Dienst drosselt
  // sonst, und eine halbe Objektliste ist schlimmer als eine langsame ganze.
  const abstandMs = queries.length > 20 ? 400 : 0;
  for (const [i, address] of queries.entries()) {
    if (abstandMs && i > 0) await new Promise((r) => setTimeout(r, abstandMs));
    const query = geocodeQuery(brief, address);
    let geo = null;
    try {
      geo = await geocode(query, { cache });
    } catch (err) {
      failures.push(`${address}: ${err.message}`);
      continue;
    }
    if (!geo) {
      failures.push(`${address}: kein Treffer`);
      continue;
    }
    if (geo.countryCode && geo.countryCode !== 'DE') {
      failures.push(`${address}: Treffer liegt in ${geo.countryCode} ("${geo.label}")`);
      continue;
    }
    const warnungen = [];
    if (!geo.state) {
      // Ohne Bundesland findet das Tool weder das Landes-Luftbild (WMS) noch
      // den Flurstuecks-Dienst (WFS) - der Gehweg-Vorschlag entfaellt dann.
      warnungen.push('kein Bundesland: kein Landes-Luftbild, kein Flurstueck-Vorschlag');
    }
    // Photon liefert bei mehrdeutigen Strassennamen gern die falsche von
    // mehreren gleichnamigen Strassen einer Stadt. Die PLZ ist der billigste
    // Gegencheck - hier aus der Adresse selbst, weil eine Objektliste je
    // Zeile eine eigene PLZ hat.
    const pc = (address.match(/\b(\d{5})\b/) || [])[1] || brief.object.postcode;
    if (pc && !geo.label.includes(pc)) {
      warnungen.push(`PLZ-Abweichung: erwartet ${pc}, Treffer "${geo.label}"`);
    }
    // Taucht der Strassenname im Treffer gar nicht auf, lohnt ein Blick -
    // meist hat der Geocoder bei unbekannter Hausnummer etwas aus der Naehe
    // gegriffen. Es kann aber auch stimmen: "Aurelienstrasse 4" loest zu
    // "Malwerk" auf, und das ist tatsaechlich der Name des Objekts - die
    // Handmessung der SVEAG fuehrt es genauso. Deshalb ein Hinweis, keine
    // Ablehnung.
    const strasse = (address.match(/^[^0-9,]+/) || [''])[0].trim()
      .replace(/(stra(ss|ß)e|str\.?)$/i, '').trim();
    if (strasse.length >= 4 && !geo.label.toLowerCase().includes(strasse.toLowerCase())) {
      warnungen.push(
        `Strassenname fehlt im Treffer: "${address}" -> "${geo.label}" ` +
        '(kann ein Objektname sein - pruefen, nicht verwerfen)'
      );
    }
    if (!leise) {
      console.error(`  Adresse: ${geo.label} (${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)}) · ${geo.state || 'Bundesland unbekannt'}` +
        (geo.cached ? ' · zwischengespeichert' : ` · ${geo.provider}`));
      for (const w of warnungen) console.error(`  ! ${w}`);
    } else if (warnungen.length) {
      console.error(`  ! ${address} → ${warnungen.join('; ')}`);
    }
    geos.push(geo);
    if (leise && (i + 1) % 25 === 0) console.error(`  … ${i + 1}/${queries.length}`);
  }

  cache.save();
  if (leise) {
    const neu = cache.size - vorher;
    console.error(`  ${geos.length} von ${queries.length} Adressen geocodiert` +
      (neu < queries.length ? ` (${queries.length - neu} aus dem Zwischenspeicher)` : '') + '.');
  }
  if (failures.length) {
    console.error(`  ! ${failures.length} Adresse(n) ohne Objekt - im Tool von Hand anlegen:`);
    for (const f of failures) console.error(`      ${f}`);
  }
  if (geos.length === 0) {
    console.error('✖ Keine einzige Adresse aufloesbar - Abbruch.');
    process.exit(1);
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
