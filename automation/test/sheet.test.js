const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sheetRows, rowsForObject, toCsv, COLUMNS, deviationPct } = require('../src/to-sheet.js');

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
