const test = require('node:test');
const assert = require('node:assert');
const { predictGehweg, frontageChains, FITTED } = require('../src/frontage.js');

// Ein Quadrat von rund 20 m Kantenlaenge, mit einer Strasse suedlich davon.
const M = 1 / 111320; // Grad je Meter in der Breite
const quadrat = [[0, 0], [20 * M, 0], [20 * M, 20 * M * 1.6], [0, 20 * M * 1.6], [0, 0]];
const strasseSued = [[[-6 * M, -5 * M], [-6 * M, 40 * M]]];

test('ohne Strassen gibt es keine Front', () => {
  assert.deepStrictEqual(frontageChains([quadrat], []), []);
  assert.deepStrictEqual(frontageChains([quadrat], null), []);
});

test('ohne Geometrie gibt es keine Front', () => {
  assert.deepStrictEqual(frontageChains([], strasseSued), []);
  assert.deepStrictEqual(frontageChains(null, strasseSued), []);
});

test('die strassenzugewandte Kante wird erkannt', () => {
  const c = frontageChains([quadrat], strasseSued);
  assert.ok(c.length >= 1, 'mindestens eine Front erwartet');
  const gesamt = c.reduce((n, x) => n + x.lengthM, 0);
  // Die untere Kante ist ~32 m lang (20 m * 1.6 in Laengsrichtung).
  assert.ok(gesamt > 20 && gesamt < 45, `unerwartete Laenge ${gesamt}`);
});

test('ohne jede Geometrie liefert die Vorhersage null statt einer Zahl', () => {
  assert.strictEqual(predictGehweg({ parcelRings: null, buildingRing: null, streets: strasseSued }), null);
  assert.strictEqual(predictGehweg({ parcelRings: [quadrat], buildingRing: quadrat, streets: [] }), null);
});

test('von zwei Kandidaten gewinnt der kleinere', () => {
  // Grosses Sammelflurstueck gegen den einzelnen Gebaeudegrundriss - genau der
  // Fall, der ohne diese Regel 511 m statt 14 m ergab.
  const gross = [[0, 0], [200 * M, 0], [200 * M, 200 * M], [0, 200 * M], [0, 0]];
  // Die Strasse muss am ganzen Sammelflurstueck entlanglaufen, sonst liegt
  // dessen Kantenmitte ausserhalb von maxDistM und zaehlt gar nicht erst.
  const strasseLang = [[[-6 * M, -5 * M], [-6 * M, 210 * M]]];
  const p = predictGehweg({ parcelRings: [gross], buildingRing: quadrat, streets: strasseLang });
  assert.ok(p, 'ein Ergebnis erwartet');
  assert.strictEqual(p.source, 'osm-gebaeude');
  assert.ok(p.spreadM > 0, 'der Abstand zwischen beiden Wegen muss ausgewiesen sein');
});

test('liegt nur eine Geometrie vor, ist der Abstand 0', () => {
  const p = predictGehweg({ parcelRings: [quadrat], buildingRing: null, streets: strasseSued });
  assert.strictEqual(p.source, 'kataster');
  assert.strictEqual(p.spreadM, 0);
});

test('das Ergebnis traegt zeichenbare Punkte, nicht nur eine Laenge', () => {
  // Die Freigabe soll sehen, WO der Gehweg liegt - eine blosse Zahl laesst
  // sich nicht pruefen.
  const p = predictGehweg({ parcelRings: [quadrat], buildingRing: null, streets: strasseSued });
  assert.ok(Array.isArray(p.chains) && p.chains.length >= 1);
  assert.ok(p.chains[0].points.length >= 2);
  assert.ok(p.chains[0].points.every((pt) => Array.isArray(pt) && pt.length === 2));
});

test('die angepassten Parameter sind die dokumentierten', () => {
  // Aendert jemand sie, muss er die Auswertung in tools/fit.js wiederholen -
  // sonst steht im README eine Genauigkeit, die nicht mehr gilt.
  assert.deepStrictEqual(FITTED, { maxDistM: 10, maxAngleDeg: 50, minLenM: 8 });
});

// --- Verlaesslichkeit ---------------------------------------------------

test('weichen die Quellen stark ab, wird das als wenig verlaesslich gemeldet', () => {
  // An 69 Handmessungen: stimmen Kataster und Gebaeude auf Faktor < 2 ueberein,
  // liegen 69 % innerhalb ±20 %; darueber nur gut 40 %. Anders als der
  // fehlende Zuweg ist das vorher erkennbar - also gehoert es in die Zeile.
  const gross = [[0, 0], [200 * M, 0], [200 * M, 200 * M], [0, 200 * M], [0, 0]];
  const strasseLang = [[[-6 * M, -5 * M], [-6 * M, 210 * M]]];

  const weit = predictGehweg({ parcelRings: [gross], buildingRing: quadrat, streets: strasseLang });
  assert.strictEqual(weit.confidence, 'niedrig');
  assert.ok(weit.spreadFactor >= 2, `Faktor ${weit.spreadFactor}`);

  const einig = predictGehweg({ parcelRings: [quadrat], buildingRing: quadrat, streets: strasseSued });
  assert.strictEqual(einig.confidence, 'hoch');
  assert.strictEqual(einig.spreadFactor, 1);
});

test('bei nur einer Quelle gilt der Vorschlag als verlaesslich', () => {
  const p = predictGehweg({ parcelRings: [quadrat], buildingRing: null, streets: strasseSued });
  assert.strictEqual(p.confidence, 'hoch');
  assert.strictEqual(p.spreadFactor, 1);
});
