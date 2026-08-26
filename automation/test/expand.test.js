const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SKRIPT = path.join(__dirname, '..', 'tools', 'expand-range.py');
const expand = (s) => execFileSync('python3', [SKRIPT, '--plain', s], { encoding: 'utf8' })
  .split('\n').map((x) => x.trim()).filter(Boolean);

test('eine Spanne laeuft auf einer Strassenseite, also in Zweierschritten', () => {
  assert.deepStrictEqual(expand('Hessestraße 1 - 19'),
    [1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map((n) => `Hessestraße ${n}`));
});

test('gemischte Paritaet zaehlt in Einerschritten', () => {
  // "5 - 8" meint beide Strassenseiten oder eine durchgezaehlte Zeile.
  assert.deepStrictEqual(expand('Am Brunnen 5 - 8'),
    ['Am Brunnen 5', 'Am Brunnen 6', 'Am Brunnen 7', 'Am Brunnen 8']);
});

test('Buchstabenspanne wird aufgeloest', () => {
  assert.deepStrictEqual(expand('Puschkinallee 14 a - c'),
    ['Puschkinallee 14a', 'Puschkinallee 14b', 'Puschkinallee 14c']);
});

test('Aufzaehlung und Spanne gemischt', () => {
  assert.deepStrictEqual(expand('Friedrich-Ebert-Straße 38/ 39; 43 - 48').length, 8);
});

test('der Bindestrich im Strassennamen ist keine Spanne', () => {
  // "Friedrich-Ebert-Straße" wurde von einer frueheren Fassung bei ihrem
  // eigenen Bindestrich zerschnitten und als "Friedrich" geocodiert.
  const teile = expand('Hans-Sachs-Straße 3 - 55');
  assert.strictEqual(teile.length, 27);
  assert.ok(teile.every((t) => t.startsWith('Hans-Sachs-Straße ')), teile[0]);
});

test('Abkuerzung ohne Leerzeichen vor der Hausnummer', () => {
  // "Kunersdorfer Str.6 - 8" ergab ohne Behandlung ein "strasse6" und damit
  // eine einzige, unbrauchbare Adresse.
  assert.deepStrictEqual(expand('Kunersdorfer Str.6 - 8'),
    ['Kunersdorfer Straße 6', 'Kunersdorfer Straße 8']);
});

test('eine einzelne Adresse bleibt eine einzelne Adresse', () => {
  assert.deepStrictEqual(expand('Behlertstraße 13'), ['Behlertstraße 13']);
});

test('unsinnige Spannen werden gedeckelt, nicht ausgerollt', () => {
  // Schutz gegen Tippfehler - sonst entstehen aus einem "1 - 1900" tausend
  // Geocoding-Abrufe.
  assert.ok(expand('Teststraße 1 - 400').length <= 40);
});
