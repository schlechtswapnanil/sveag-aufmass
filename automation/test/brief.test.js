const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyTier, validateBrief, evidenceErrors, consistencyErrors,
} = require('../src/brief.js');
const {
  briefToObject, briefToImportFile, allAddresses, geocodeQuery,
  buildAssumptionsNote, categoriesToMeasure, formatMeasurement, sectorLabel,
} = require('../src/to-aufmass.js');
const { mapTerm, OBSERVED } = require('../src/vocabulary.js');

const SAMPLES = path.join(__dirname, '..', 'samples');
const load = (tier) => ({
  brief: JSON.parse(fs.readFileSync(path.join(SAMPLES, `tier-${tier}.brief.json`), 'utf8')),
  email: fs.readFileSync(path.join(SAMPLES, `tier-${tier}.email.txt`), 'utf8'),
});
const clone = (o) => JSON.parse(JSON.stringify(o));

// --- Die drei Referenzfaelle muessen sauber durchlaufen ------------------

for (const tier of ['a', 'b', 'c']) {
  test(`Beispiel tier-${tier} ist gueltig und wird als ${tier.toUpperCase()} eingestuft`, () => {
    const { brief, email } = load(tier);
    assert.deepStrictEqual(validateBrief(brief, email), []);
    assert.strictEqual(classifyTier(brief), tier.toUpperCase());
  });
}

// Nachgebaut aus zwei echten Anfragen. Beide nennen die Adresse nur per
// Verweis und zaehlen die Bereiche abschliessend auf - beides fiel in den
// erfundenen Beispielen nicht auf.
for (const name of ['b-flurkarte', 'b-aufzaehlung']) {
  test(`Echtfall tier-${name} ist gueltig und bleibt Stufe B`, () => {
    const { brief, email } = load(name);
    assert.deepStrictEqual(validateBrief(brief, email), []);
    assert.strictEqual(classifyTier(brief), 'B');
    assert.strictEqual(brief.object.addressRaw, null);
  });
}

// --- Tier-Einstufung ----------------------------------------------------

test('A: nur eine Adresse, sonst nichts', () => {
  assert.strictEqual(
    classifyTier({ object: { addressRaw: 'x', objectType: 'unbekannt' }, sectors: [] }),
    'A'
  );
});

test('B: Objekttyp bekannt, aber kein einziges Mass', () => {
  assert.strictEqual(
    classifyTier({ object: { addressRaw: 'x', objectType: 'reihenhaus' }, sectors: [] }),
    'B'
  );
});

test('B: Sektor genannt, aber ohne Mass - auch mit bekanntem Objekttyp', () => {
  assert.strictEqual(
    classifyTier({
      object: { addressRaw: 'x', objectType: 'reihenhaus' },
      sectors: [{ category: 'gehweg', present: true, source: 'email' }],
    }),
    'B'
  );
});

test('C: jeder genannte Sektor hat ein Mass und der Objekttyp steht fest', () => {
  assert.strictEqual(
    classifyTier({
      object: { addressRaw: 'x', objectType: 'reihenhaus' },
      sectors: [
        { category: 'gehweg', present: true, lengthM: 20, source: 'email' },
        { category: 'parkplatz', present: false, source: 'email' },
      ],
    }),
    'C'
  );
});

test('C: ein bemasster Plan hebt auf C, auch ohne jede Zahl im Text', () => {
  assert.strictEqual(
    classifyTier({
      object: { addressRaw: 'x', objectType: 'unbekannt' },
      sectors: [],
      attachments: [{ filename: 'plan.pdf', kind: 'lageplan', hasDimensions: true }],
    }),
    'C'
  );
});

test('tier laesst sich nicht frei behaupten', () => {
  const { brief, email } = load('a');
  const errs = validateBrief({ ...brief, tier: 'C' }, email);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /tier: "C" angegeben, nach den Angaben ist es "A"/);
});

// --- Halluzinations-Bremse ----------------------------------------------

test('erfundenes Mass ohne Beleg im Mailtext faellt auf', () => {
  const { brief, email } = load('b');
  const bad = clone(brief);
  bad.sectors[0].lengthM = 35;
  bad.sectors[0].evidence = 'Der Gehweg ist 35 m lang.'; // steht so nicht in der Mail
  const errs = evidenceErrors(bad, email);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /steht so nicht im Quelltext/);
});

test('source=email ohne Zitat faellt auf', () => {
  const { brief, email } = load('b');
  const bad = clone(brief);
  delete bad.sectors[0].evidence;
  assert.ok(evidenceErrors(bad, email).some((e) => /kein evidence-Zitat/.test(e)));
});

test('erfundene Adresse faellt auf', () => {
  const { brief, email } = load('a');
  const bad = clone(brief);
  bad.object.addressRaw = 'Lindenstraße 41, 33602 Bielefeld'; // Hausnummer gedreht
  assert.ok(evidenceErrors(bad, email).some((e) => /addressRaw/.test(e)));
});

test('Zitat ueber einen Zeilenumbruch hinweg zaehlt trotzdem', () => {
  const { brief, email } = load('b');
  // In der Mail bricht dieser Satz zwischen "liegt" und "direkt" um.
  assert.ok(brief.sectors.some((s) => /Muelltonnenplatz liegt direkt/.test(s.evidence || '')));
  assert.deepStrictEqual(evidenceErrors(brief, email), []);
});

test('eingefuegtes Komma in der Adresse ist kein Fehler', () => {
  const email = 'Objekt: Lindenstraße 14\n33602 Bielefeld\n';
  const brief = { object: { addressRaw: 'Lindenstraße 14, 33602 Bielefeld' }, sectors: [] };
  assert.deepStrictEqual(evidenceErrors(brief, email), []);
});

// --- Konsistenz ---------------------------------------------------------

test('present=false mit Mass ist widerspruechlich', () => {
  const errs = consistencyErrors({
    object: { addressRaw: 'Musterweg 1', addressSource: 'email-body' },
    sectors: [{ category: 'gehweg', present: false, lengthM: 12, source: 'email', evidence: 'x' }],
  });
  assert.ok(errs.some((e) => /present=false, trotzdem ein Mass/.test(e)));
});

test('doppelte Kategorie faellt auf', () => {
  const errs = consistencyErrors({
    object: { addressRaw: 'Musterweg 1', addressSource: 'email-body' },
    sectors: [
      { category: 'gehweg', present: true, source: 'annahme' },
      { category: 'gehweg', present: true, source: 'annahme' },
    ],
  });
  assert.ok(errs.some((e) => /doppelt/.test(e)));
});

test('sonstiges braucht ein label, zwei verschiedene sonstiges sind erlaubt', () => {
  const obj = { addressRaw: 'Musterweg 1', addressSource: 'email-body' };
  assert.ok(
    consistencyErrors({ object: obj, sectors: [{ category: 'sonstiges', present: true, source: 'annahme' }] })
      .some((e) => /braucht ein label/.test(e))
  );
  // Treppen kamen in beiden echten Anfragen vor - sie sind eine eigene
  // Position, keine Fussnote, und muessen mehrfach nebeneinander passen.
  assert.deepStrictEqual(
    consistencyErrors({
      object: obj,
      sectors: [
        { category: 'sonstiges', label: 'Hauszugangstreppe', present: true, source: 'annahme' },
        { category: 'sonstiges', label: 'Kellertreppe', present: true, source: 'annahme' },
      ],
    }),
    []
  );
});

test('unbekanntes Feld wird abgelehnt, nicht still geschluckt', () => {
  const { brief, email } = load('a');
  const errs = validateBrief({ ...brief, preis: 400 }, email);
  assert.ok(errs.some((e) => /unbekanntes Feld "preis"/.test(e)));
});

test('unzulaessiger Kategorie-Wert wird abgelehnt', () => {
  const { brief, email } = load('a');
  const bad = clone(brief);
  bad.sectors.push({ category: 'dachrinne', present: true, source: 'annahme' });
  assert.ok(validateBrief(bad, email).some((e) => /dachrinne/.test(e)));
});

// --- Uebergabe an das Tool ----------------------------------------------

const GEO = { lat: 52.0211, lon: 8.5347, state: 'Nordrhein-Westfalen', label: 'Lindenstraße 14, 33602 Bielefeld' };
const OPTS = { nowIso: '2026-08-26T10:00:00.000Z', idFn: () => 'id-test0001' };

test('Importdatei hat exakt das Format, das importJson() des Tools erwartet', () => {
  const { brief } = load('a');
  const file = briefToImportFile(brief, GEO, OPTS);
  assert.strictEqual(file.version, 1);
  assert.strictEqual(file.objects.length, 1);
  const obj = file.objects[0];
  for (const key of ['id', 'address', 'lat', 'lon', 'bundesland', 'assumptionsNote', 'lines', 'createdAt', 'updatedAt']) {
    assert.ok(key in obj, `Feld ${key} fehlt`);
  }
  assert.deepStrictEqual(obj.lines, []);
  assert.strictEqual(obj.bundesland, 'Nordrhein-Westfalen');
});

test('Kundenangaben werden nie zu gemessenen Linien', () => {
  const { brief } = load('c');
  const obj = briefToObject(brief, GEO, OPTS);
  assert.deepStrictEqual(obj.lines, []);
});

test('ohne Geocoding-Treffer wird kein Objekt erzeugt', () => {
  const { brief } = load('a');
  assert.throws(() => briefToObject(brief, null, OPTS), /Geocoding/);
});

test('Notiz nennt Stufe, Kundenmasse, Ausschluesse und Besonderheiten', () => {
  const { brief } = load('b');
  const note = buildAssumptionsNote(brief);
  assert.match(note, /Stufe B/);
  assert.match(note, /Garage 12 m \(Kundenschaetzung\)/);
  assert.match(note, /nicht beauftragt: Muelltonnen, Parkplatz/);
  assert.match(note, /Streusalz nicht erlaubt/);
  assert.match(note, /Offen:/);
});

test('zu messen sind alle Kategorien ohne festes Mass; Ausschluesse bleiben aussen vor', () => {
  const { brief: a } = load('a');
  assert.deepStrictEqual(
    categoriesToMeasure(a),
    ['gehweg', 'haustuer', 'garage', 'parkplatz', 'muelltonnen']
  );

  const { brief: b } = load('b');
  // Garage hat zwar 12 m, aber nur als Kundenschaetzung -> trotzdem messen.
  assert.deepStrictEqual(categoriesToMeasure(b), ['gehweg', 'haustuer', 'garage']);

  const { brief: c } = load('c');
  assert.deepStrictEqual(categoriesToMeasure(c), []);
});


// --- Erkenntnisse aus den echten Anfragen -------------------------------

test('markierte Flurkarte ohne Masse bleibt B, bemasster Plan hebt auf C', () => {
  const base = {
    object: { addressRaw: 'x', addressSource: 'email-body', objectType: 'unbekannt' },
    sectors: [{ category: 'gehweg', present: true, source: 'email' }],
  };
  assert.strictEqual(classifyTier({
    ...base, attachments: [{ filename: 'flurkarte.pdf', kind: 'lageplan', hasDimensions: false }],
  }), 'B');
  assert.strictEqual(classifyTier({
    ...base, attachments: [{ filename: 'aufmass.pdf', kind: 'lageplan', hasDimensions: true }],
  }), 'C');
});

test('fehlende Adresse muss als fehlend markiert und nachgefragt werden', () => {
  const withQuestion = {
    object: { addressRaw: null, addressSource: 'fehlt' },
    sectors: [], openQuestions: ['Adresse aus dem Betreff nachziehen.'],
  };
  assert.deepStrictEqual(consistencyErrors(withQuestion), []);

  assert.ok(consistencyErrors({ ...withQuestion, openQuestions: [] })
    .some((e) => /keine offene Frage/.test(e)));
  assert.ok(consistencyErrors({ ...withQuestion, object: { addressRaw: null, addressSource: 'betreff' } })
    .some((e) => /addressSource "fehlt"/.test(e)));
});

test('auch eine Adresse aus dem Betreff braucht einen Beleg im Quelltext', () => {
  const nurBody = 'wir benoetigen ein Angebot fuer das o. g. Objekt.';
  // Der Quelltext, den die Skill schreibt: Betreffzeile plus Mailtext.
  const mitBetreff = `Betreff: Winterdienst Musterweg 3, 22335 Hamburg\n\n${nurBody}`;
  const brief = { object: { addressRaw: 'Musterweg 3', addressSource: 'betreff' }, sectors: [] };

  // Ohne Betreff im Quelltext ist die Adresse unbelegt - und faellt auf.
  assert.ok(evidenceErrors(brief, nurBody).some((e) => /addressRaw/.test(e)));
  // Mit Betreff im Quelltext traegt sie einen Beleg.
  assert.deepStrictEqual(evidenceErrors(brief, mitBetreff), []);
});

test('bei abschliessender Aufzaehlung wird Ungenanntes nicht gemessen', () => {
  const brief = {
    object: { addressRaw: 'x', addressSource: 'email-body', objectType: 'unbekannt' },
    sectors: [{ category: 'gehweg', present: true, source: 'email' }],
  };
  assert.deepStrictEqual(categoriesToMeasure(brief),
    ['gehweg', 'haustuer', 'garage', 'parkplatz', 'muelltonnen']);
  assert.deepStrictEqual(categoriesToMeasure({ ...brief, sectorListIsExhaustive: true }),
    ['gehweg']);
});

test('Geocoding weist einen leeren Suchbegriff ab, statt irgendwo zu treffen', async () => {
  const { geocode } = require('../src/geocode.js');
  const nie = () => { throw new Error('darf nicht abgefragt werden'); };
  for (const q of [null, undefined, '', '  ', 'ab']) {
    await assert.rejects(() => geocode(q, { fetchImpl: nie }), /Unbrauchbarer Suchbegriff/);
  }
});


// --- Erkenntnisse aus einer echten Ausschreibung ------------------------

test('Echtfall tier-c-flaechen: Flaechen in qm, drei Adressen, Stufe C', () => {
  const { brief, email } = load('c-flaechen');
  assert.deepStrictEqual(validateBrief(brief, email), []);
  assert.strictEqual(classifyTier(brief), 'C');
  // Jede Position ist eine Flaeche, keine Laenge - so fragen echte Kunden an.
  assert.ok(brief.sectors.every((s) => s.areaM2 != null && s.lengthM == null));
  assert.deepStrictEqual(categoriesToMeasure(brief), []);
});

test('eine Wohnanlage ueber drei Strassen ergibt drei Objekte', () => {
  const { brief } = load('c-flaechen');
  assert.strictEqual(allAddresses(brief).length, 3);
  const geos = allAddresses(brief).map((a, i) => ({
    lat: 53.6 + i / 1000, lon: 10.0 + i / 1000, state: 'Hamburg', label: a,
  }));
  const file = briefToImportFile(brief, geos, OPTS);
  assert.strictEqual(file.objects.length, 3);
  // Sonst liegen drei ununterscheidbare Aufmassblaetter auf dem Tisch.
  file.objects.forEach((o, i) => assert.match(o.assumptionsNote, new RegExp(`Teil ${i + 1} von 3`)));
});

test('Suchbegriff ergaenzt Ort und PLZ, ohne addressRaw zu verfaelschen', () => {
  const brief = { object: { addressRaw: 'Beispielweg 83 – 87', city: 'Musterstadt', postcode: '22335' } };
  assert.strictEqual(geocodeQuery(brief, 'Beispielweg 83 – 87'),
    'Beispielweg 83 – 87, 22335, Musterstadt');
  // Schon Enthaltenes wird nicht doppelt angehaengt.
  const brief2 = { object: { addressRaw: 'Beispielweg 1, 22335 Musterstadt', city: 'Musterstadt', postcode: '22335' } };
  assert.strictEqual(geocodeQuery(brief2, 'Beispielweg 1, 22335 Musterstadt'),
    'Beispielweg 1, 22335 Musterstadt');
});

test('Flaeche wird vor der Laenge genannt - qm ist die Einheit der Angebote', () => {
  assert.strictEqual(formatMeasurement({ areaM2: 714.3, lengthM: 120 }), '714.3 m², 120 m');
});

test('Notiz nennt Einsatzzahl, Streugutentsorgung und Angebotsfrist', () => {
  const { brief } = load('c-flaechen');
  const note = buildAssumptionsNote(brief);
  assert.match(note, /15 Einsaetze/);
  assert.match(note, /inkl\. Streugutentsorgung/);
  assert.match(note, /Angebot bis 2026-06-09/);
});


// --- Kundenbegriffe auf die fuenf Kategorien ---------------------------

test('jeder aus echten Anfragen belegte Begriff bildet auf die richtige Kategorie ab', () => {
  for (const [term, expected] of OBSERVED) {
    assert.strictEqual(mapTerm(term), expected, `"${term}"`);
  }
});

test('spezifische Begriffe schlagen allgemeine', () => {
  // "Muelltonnen Zuwegung" enthaelt "Zuwegung" - trotzdem Muell, nicht Haustuer.
  assert.strictEqual(mapTerm('Mülltonnen Zuwegung'), 'muelltonnen');
  // "Garagenzufahrt" enthaelt "Zufahrt" - Garage, nicht irgendein Weg.
  assert.strictEqual(mapTerm('Garagenzufahrt'), 'garage');
  assert.strictEqual(mapTerm('Dachrinne'), null);
});

test('der Kundenbegriff bleibt sichtbar, die Kategorie steuert nur die Messung', () => {
  assert.strictEqual(sectorLabel({ category: 'haustuer', label: 'Wohnwege' }), 'Wohnwege');
  assert.strictEqual(sectorLabel({ category: 'gehweg', label: null }), 'Gehweg');

  const { brief } = load('c-flaechen');
  const note = buildAssumptionsNote(brief);
  assert.match(note, /Wohnwege 291 m²/);
  assert.match(note, /Öffentliche Gehwege 714\.3 m²/);
  assert.doesNotMatch(note, /Haustuer 291/);
});

test('mehrere Positionen derselben Kategorie sind erlaubt, solange die Labels sich unterscheiden', () => {
  const obj = { addressRaw: 'Musterweg 1', addressSource: 'email-body' };
  const zwei = {
    object: obj,
    sectors: [
      { category: 'haustuer', label: 'Wohnwege', present: true, source: 'annahme' },
      { category: 'haustuer', label: 'Kellerniedergänge', present: true, source: 'annahme' },
    ],
  };
  assert.deepStrictEqual(consistencyErrors(zwei), []);

  // Zweimal dieselbe Position bleibt ein Fehler.
  const doppelt = {
    object: obj,
    sectors: [
      { category: 'haustuer', label: 'Wohnwege', present: true, source: 'annahme' },
      { category: 'haustuer', label: 'Wohnwege', present: true, source: 'annahme' },
    ],
  };
  assert.ok(consistencyErrors(doppelt).some((e) => /doppelt/.test(e)));
});

test('eine Kategorie wird gemessen, sobald EINE ihrer Positionen kein Mass hat', () => {
  const base = {
    object: { addressRaw: 'x', addressSource: 'email-body', objectType: 'unbekannt' },
    sectorListIsExhaustive: true,
  };
  const beide = { ...base, sectors: [
    { category: 'haustuer', label: 'Wohnwege', present: true, areaM2: 291, source: 'email' },
    { category: 'haustuer', label: 'Treppe', present: true, areaM2: 15, source: 'email' },
  ] };
  assert.deepStrictEqual(categoriesToMeasure(beide), []);

  const eineOffen = { ...base, sectors: [
    { category: 'haustuer', label: 'Wohnwege', present: true, areaM2: 291, source: 'email' },
    { category: 'haustuer', label: 'Treppe', present: true, source: 'email' },
  ] };
  assert.deepStrictEqual(categoriesToMeasure(eineOffen), ['haustuer']);
});
