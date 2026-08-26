const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sheetRows, rowsForObject, toCsv, fromCsv, mergeRows, COLUMNS, deviationPct } = require('../src/to-sheet.js');

const SAMPLES = path.join(__dirname, '..', 'samples');
const brief = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'tier-c-flaechen.brief.json'), 'utf8'));

// Ein gemessenes Objekt bauen, wie es das Tool exportiert.
function objekt({ teil, teile, lines, address = 'Beispielweg 87, 22335 Musterstadt' }) {
  return {
    id: 'id-x', address, lat: 53.63, lon: 10.02, bundesland: 'Hamburg',
    assumptionsNote: teile ? `Teil ${teil} von ${teile}. Anfrage Stufe C.` : 'Anfrage Stufe C.',
    lines, createdAt: '2026-08-26T10:00:00.000Z', updatedAt: '2026-08-26T14:20:00.000Z',
    sveagBrief: { tier: 'C', toMeasure: [], brief },
  };
}

// Zwei Punkte mit bekanntem Nord-Sued-Abstand: 1 Grad Breite ~ 111320 m.
function linie(category, meters, isAssumption = false) {
  return {
    id: `id-${category}`, category, isAssumption,
    points: [[53.63, 10.02], [53.63 + meters / 111320, 10.02]],
  };
}

test('eine Zeile je Kundenposition, in der Reihenfolge der Anfrage', () => {
  const rows = rowsForObject(objekt({ lines: [linie('gehweg', 240)] }));
  assert.strictEqual(rows.length, brief.sectors.length);
  assert.deepStrictEqual(rows.map((r) => r.Position),
    ['Öffentliche Gehwege', 'Wohnwege', 'Müllstandorte', 'Kellerniedergänge (Podest, Stufen, Rampe)']);
});

test('der Kundenbegriff steht in der Zeile, nicht die Tool-Kategorie', () => {
  const rows = rowsForObject(objekt({ lines: [] }));
  const wohnwege = rows.find((r) => r.Position === 'Wohnwege');
  assert.strictEqual(wohnwege.Kategorie, 'haustuer');
  assert.strictEqual(wohnwege.Kundenangabe, 291);
  assert.strictEqual(wohnwege.Einheit, 'm²');
});

test('Kundenangabe steht nur an Teil 1 - sonst zaehlt die Spalte doppelt', () => {
  const state = { version: 1, objects: [
    objekt({ teil: 1, teile: 3, lines: [linie('gehweg', 240)] }),
    objekt({ teil: 2, teile: 3, lines: [linie('gehweg', 210)] }),
    objekt({ teil: 3, teile: 3, lines: [linie('gehweg', 265)] }),
  ] };
  const rows = sheetRows(state);
  const summe = rows.reduce((n, r) => n + (Number(r.Kundenangabe) || 0), 0);
  // Genau die Summe der Ausschreibung, nicht das Dreifache.
  assert.strictEqual(Math.round(summe * 100) / 100, 1077.3);

  // Gemessen wird dagegen je Teil - das gehoert an jede Zeile.
  const gemessen = rows.reduce((n, r) => n + (Number(r.Gemessen_m) || 0), 0);
  assert.strictEqual(gemessen, 240 + 210 + 265);

  assert.ok(rows.filter((r) => r.Teil === '2/3').every((r) => /Teil 1\/3/.test(r.Hinweis)));
});

test('geteilte Kategorie wird als solche ausgewiesen', () => {
  // Wohnwege und Kellerniedergaenge sind beide haustuer - eine Messung, zwei
  // Positionen. Wer das nicht sieht, liest die Zahl doppelt.
  const rows = rowsForObject(objekt({ lines: [linie('haustuer', 95)] }));
  const beide = rows.filter((r) => r.Kategorie === 'haustuer');
  assert.strictEqual(beide.length, 2);
  assert.ok(beide.every((r) => /gesamte Kategorie/.test(r.Hinweis)));
  // Nur die erste traegt den Messwert, sonst waere er doppelt gezaehlt.
  assert.strictEqual(beide[0].Gemessen_m, 95);
  assert.strictEqual(beide[1].Gemessen_m, '');
});

test('qm gegen laufende Meter wird nicht verglichen, sondern angemerkt', () => {
  const rows = rowsForObject(objekt({ lines: [linie('gehweg', 240)] }));
  const gehweg = rows.find((r) => r.Kategorie === 'gehweg');
  assert.strictEqual(gehweg['Abweichung_%'], '');
  assert.match(gehweg.Hinweis, /kein direkter Vergleich/);
});

test('Abweichung nur bei vergleichbaren, nicht geschaetzten Laengen', () => {
  assert.strictEqual(deviationPct({ lengthM: 100 }, 120), 20);
  assert.strictEqual(deviationPct({ lengthM: 100, isEstimate: true }, 120), null);
  assert.strictEqual(deviationPct({ areaM2: 100 }, 120), null);
  assert.strictEqual(deviationPct({ lengthM: 100 }, null), null);
});

test('was gemessen, aber nicht angefragt wurde, faellt auf', () => {
  const rows = rowsForObject(objekt({ lines: [linie('parkplatz', 40)] }));
  const extra = rows.find((r) => r.Kategorie === 'parkplatz');
  assert.strictEqual(extra.Gemessen_m, 40);
  assert.strictEqual(extra.Kundenangabe, '');
  assert.match(extra.Hinweis, /nicht genannt/);
});

test('nicht gemessene Positionen bekommen den Status, nicht eine Null', () => {
  const rows = rowsForObject(objekt({ lines: [] }));
  assert.ok(rows.every((r) => r.Status === 'nicht gemessen'));
  assert.ok(rows.every((r) => r.Gemessen_m === ''));
});

test('alles steht auf "zu pruefen" - nichts gilt automatisch als freigegeben', () => {
  const rows = rowsForObject(objekt({ lines: [linie('gehweg', 240)] }));
  assert.ok(rows.every((r) => r.Status !== 'freigegeben'));
});

test('Luftbild-Linien werden als Annahme markiert', () => {
  const rows = rowsForObject(objekt({ lines: [linie('gehweg', 240, true)] }));
  assert.strictEqual(rows.find((r) => r.Kategorie === 'gehweg').Annahme, 'ja');
});

test('CSV: Kopfzeile, BOM, und Trennzeichen im Text brechen die Spalten nicht', () => {
  const csv = toCsv([{ ...Object.fromEntries(COLUMNS.map((c) => [c, ''])),
    Position: 'Wohnwege, innen', Hinweis: 'Er sagte "ja"' }]);
  assert.ok(csv.startsWith('﻿'), 'BOM fehlt - Excel zerlegt sonst die Umlaute');
  const [head, row] = csv.replace('﻿', '').trim().split('\n');
  assert.strictEqual(head.split(',').length, COLUMNS.length);
  assert.match(row, /"Wohnwege, innen"/);
  assert.match(row, /"Er sagte ""ja"""/);
});

// --- Links zu den Kontrollbildern --------------------------------------

const os = require('node:os');
const { slugFor, imageLink } = require('../src/to-sheet.js');

test('Slug passt zu dem, was cv/run.py --out erzeugt', () => {
  assert.strictEqual(slugFor('Erdkampsweg 87, 22335 Hamburg'), 'erdkampsweg-87-22335-hamburg');
  assert.strictEqual(slugFor('Hermann-Löns-Weg 51, 22335 Hamburg'), 'hermann-loens-weg-51-22335-hamburg');
  assert.strictEqual(slugFor('Straße Ärger Übung'), 'strasse-aerger-uebung');
});

test('image-map schlaegt Verzeichnis, Adresse und ID werden beide erkannt', () => {
  const obj = { id: 'id-7', address: 'Erdkampsweg 87, 22335 Hamburg' };
  assert.strictEqual(imageLink(obj, { imageMap: { 'Erdkampsweg 87, 22335 Hamburg': 'https://drive/a' } }), 'https://drive/a');
  assert.strictEqual(imageLink(obj, { imageMap: { 'id-7': 'https://drive/b' } }), 'https://drive/b');
  assert.strictEqual(imageLink(obj, { imageMap: { 'erdkampsweg-87-22335-hamburg': 'https://drive/c' } }), 'https://drive/c');
});

test('ein Bild, das es nicht gibt, wird nicht verlinkt', () => {
  // Ein toter Link ist schlimmer als eine leere Zelle - er sieht aus wie ein Beleg.
  const obj = { id: 'x', address: 'Gibtsnicht 1, 12345 Nirgendwo' };
  assert.strictEqual(imageLink(obj, { imagesDir: os.tmpdir() }), '');
  assert.strictEqual(imageLink(obj, {}), '');
});

test('vorhandenes Bild ergibt einen file://-Link', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aufmass-'));
  const obj = { id: 'x', address: 'Beispielweg 1, 22335 Musterstadt' };
  fs.writeFileSync(path.join(dir, `${slugFor(obj.address)}.debug.png`), 'x');
  assert.match(imageLink(obj, { imagesDir: dir }), /^file:\/\/.*beispielweg-1-22335-musterstadt\.debug\.png$/);
});

test('am Objekt hinterlegte Links schlagen jede Konvention', () => {
  const obj = objekt({ lines: [] });
  obj.sveagLinks = { kontrollbild: 'https://drive/x', aufmassblatt: 'https://drive/y' };
  const row = rowsForObject(obj, { imageMap: { [obj.address]: 'https://drive/anders' } })[0];
  assert.strictEqual(row.Kontrollbild, 'https://drive/x');
  assert.strictEqual(row.Aufmassblatt, 'https://drive/y');
});

// --- Portfolio vs. Einzelobjekt ----------------------------------------

test('beim Portfolio gilt keine Kundenangabe fuer "alle zusammen"', () => {
  // Eine Ausschreibung ueber viele eigenstaendige Haeuser hat keine
  // Gesamtflaeche - jedes Objekt steht fuer sich. Fehlt der Teil-Vermerk,
  // darf die Kundenangabe auch nicht auf Teil 1 zusammengezogen werden.
  const ohneTeil = objekt({ lines: [linie('gehweg', 30)] });   // keine "Teil n von m"-Notiz
  const rows = rowsForObject(ohneTeil);
  assert.ok(rows.every((r) => r.Teil === ''));
  assert.strictEqual(rows.find((r) => r.Kategorie === 'gehweg').Kundenangabe, 714.3);
  assert.ok(rows.every((r) => !/Gesamtanlage/.test(r.Hinweis)));
});

// --- Fortschreiben ------------------------------------------------------

test('Zeilen-ID ist stabil und haengt nicht an der Objekt-ID', () => {
  // prepare wuerfelt bei jedem Lauf neue Objekt-IDs. Haenge die Zeilen-ID
  // daran, verdoppelt sich der Bestand bei jedem Durchlauf.
  const a = objekt({ lines: [] }); a.id = 'id-erster-lauf';
  const b = objekt({ lines: [] }); b.id = 'id-zweiter-lauf';
  assert.deepStrictEqual(rowsForObject(a).map((r) => r.ID), rowsForObject(b).map((r) => r.ID));
});

test('derselbe Lauf zweimal verdoppelt nichts', () => {
  const rows = rowsForObject(objekt({ lines: [linie('gehweg', 30)] }));
  const { rows: zusammen, angehaengt } = mergeRows(rows, rows);
  assert.strictEqual(angehaengt.length, 0);
  assert.strictEqual(zusammen.length, rows.length);
});

test('Handarbeit im Bestand ueberlebt einen erneuten Lauf', () => {
  const rows = rowsForObject(objekt({ lines: [linie('gehweg', 30)] }));
  const bestand = rows.map((r) => ({ ...r }));
  bestand[0].Status = 'freigegeben';
  bestand[0].Gemessen_m = '12';          // von Hand korrigiert

  const { rows: zusammen, abweichungen } = mergeRows(bestand, rows);
  assert.strictEqual(zusammen[0].Status, 'freigegeben', 'Freigabe darf nicht verlorengehen');
  assert.strictEqual(zusammen[0].Gemessen_m, '12', 'Korrektur darf nicht ueberschrieben werden');
  // Aber die Abweichung muss gemeldet werden - stillschweigen waere schlimmer.
  assert.ok(abweichungen.some((a) => a.feld === 'Gemessen_m' && a.alt === '12'));
});

test('eine zweite Anfrage haengt an, statt zu ersetzen', () => {
  const a = rowsForObject(objekt({ lines: [], address: 'Aweg 1, 04177 Leipzig' }));
  const b = rowsForObject(objekt({ lines: [], address: 'Bweg 2, 22335 Hamburg' }));
  const { rows: zusammen, angehaengt } = mergeRows(a, b);
  assert.strictEqual(angehaengt.length, b.length);
  assert.strictEqual(zusammen.length, a.length + b.length);
  assert.strictEqual(new Set(zusammen.map((r) => r.ID)).size, zusammen.length);
});

test('CSV überlebt den Rundlauf, auch mit Komma und Anführungszeichen', () => {
  const rows = rowsForObject(objekt({ lines: [linie('gehweg', 30)] }));
  rows[0].Hinweis = 'Er sagte "ja", dann "nein"';
  const zurueck = fromCsv(toCsv(rows));
  assert.strictEqual(zurueck.length, rows.length);
  assert.strictEqual(zurueck[0].Hinweis, 'Er sagte "ja", dann "nein"');
  assert.strictEqual(zurueck[0].ID, rows[0].ID);
});
