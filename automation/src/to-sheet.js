// Gemessenes Objekt -> Zeilen fuer die Tabelle.
//
// Eingabe ist der Export des Aufmass-Tools ("Objekte -> Export (JSON)"),
// nachdem gemessen wurde. Die Objekte tragen den Brief in `sveagBrief` mit
// sich (siehe to-aufmass.js), also steckt Kundenangabe und Messung in einer
// Datei und die Zeile kann beides nebeneinander stellen.
//
// Eine Zeile je Position, nicht je Objekt: so schreiben Ausschreibungen ihre
// Flaechen auf, und so muss das Angebot sie zurueckgeben.

const path = require('node:path');
const { sectorLabel, formatMeasurement } = require('./to-aufmass.js');
const { TIER_LABEL } = require('./brief.js');

// Die Laengenrechnung des Tools mitbenutzen statt sie nachzubauen.
// vendor/ entsteht durch cv/extract-vendor.js.
let _model = null;
function model() {
  if (!_model) {
    try {
      _model = require(path.join(__dirname, '..', 'vendor', 'model.js'));
    } catch {
      throw new Error(
        'vendor/model.js fehlt - einmalig "node cv/extract-vendor.js ../Aufmass_2026-08-21.html" ausfuehren.'
      );
    }
  }
  return _model;
}

const COLUMNS = [
  'Datum', 'Objekt', 'Teil', 'Bundesland', 'Stufe',
  'Position', 'Kategorie',
  'Kundenangabe', 'Einheit', 'Gemessen_m', 'Abweichung_%',
  'Quelle', 'Annahme', 'Status',
  'Einsaetze', 'Streugutentsorgung', 'Angebotsfrist',
  'Kontakt', 'Vor_Ort', 'Offene_Fragen', 'Hinweis',
  'Kontrollbild', 'Aufmassblatt',
];

// Dateiname-Grundform einer Adresse. Muss zu dem passen, was bei
// `cv/run.py --out` herauskommt, sonst findet das Kontrollbild seine Zeile
// nicht: "Erdkampsweg 87, 22335 Hamburg" -> "erdkampsweg-87-22335-hamburg".
function slugFor(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Link zum Kontrollbild eines Objekts.
//
// Zwei Wege, weil sie unterschiedlich weit tragen:
//   imageMap  - { "<Adresse oder Objekt-ID>": "<URL>" }. Echte Web-Links,
//               z. B. aus Google Drive. Nur die funktionieren in einem Sheet,
//               das jemand anderes oeffnet.
//   imagesDir - lokales Verzeichnis. Ergibt file://-Links, die nur auf dem
//               Rechner funktionieren, auf dem gemessen wurde. Zum Selbst-
//               nachsehen gut, zum Verschicken nicht.
function imageLink(obj, { imageMap, imagesDir } = {}) {
  if (imageMap) {
    const hit = imageMap[obj.address] || imageMap[obj.id] || imageMap[slugFor(obj.address)];
    if (hit) return hit;
  }
  if (imagesDir) {
    const file = path.join(imagesDir, `${slugFor(obj.address)}.debug.png`);
    // Nur verlinken, was es gibt - ein toter Link ist schlimmer als eine
    // leere Zelle, weil er nach einem Beleg aussieht.
    try {
      if (require('node:fs').existsSync(file)) return `file://${path.resolve(file)}`;
    } catch { /* Verzeichnis nicht lesbar - dann eben kein Link */ }
  }
  return '';
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Gemessene Meter je Kategorie, aus den Linien des Objekts.
function measuredByCategory(obj) {
  const out = new Map();
  for (const t of model().categoryTotals(obj)) {
    out.set(t.key, { meters: t.meters, isAssumption: t.isAssumption });
  }
  return out;
}

// Abweichung nur, wo sie etwas bedeutet: beide Werte in Metern, und der
// Kundenwert ist keine Schaetzung. Eine Flaeche gegen eine Laenge zu
// vergleichen ergibt keine Zahl, sondern einen Fehler.
function deviationPct(sector, measuredM) {
  if (!sector || measuredM == null) return null;
  if (sector.isEstimate) return null;
  if (sector.lengthM == null) return null;
  if (sector.lengthM === 0) return null;
  return round1(((measuredM - sector.lengthM) / sector.lengthM) * 100);
}

function unitOf(sector) {
  if (!sector) return '';
  if (sector.areaM2 != null) return 'm²';
  if (sector.lengthM != null) return 'm';
  return '';
}

function statedValue(sector) {
  if (!sector) return '';
  if (sector.areaM2 != null) return sector.areaM2;
  if (sector.lengthM != null) return sector.lengthM;
  return '';
}

// obj: ein Objekt aus dem Tool-Export. Gibt die Zeilen dieses Objekts zurueck.
//
// Bei einer Anlage ueber mehrere Adressen nennt die Ausschreibung EINE Summe
// fuer das Ganze ("insgesamt 1.077,30 qm"), nicht je Strasse. Die Kundenangabe
// darf deshalb nur an Teil 1 haengen - stuende sie an jedem Teil, ergaebe die
// Spaltensumme das Dreifache.
function rowsForObject(obj, opts = {}) {
  const carried = obj.sveagBrief || {};
  const brief = carried.brief || {};
  const svc = brief.service || {};
  const contact = brief.contact || {};
  const measured = measuredByCategory(obj);

  const teil = (obj.assumptionsNote || '').match(/Teil (\d+) von (\d+)/);
  const istFolgeteil = Boolean(teil) && teil[1] !== '1';
  const base = {
    Datum: (obj.updatedAt || '').slice(0, 10),
    Objekt: obj.address || '',
    Teil: teil ? `${teil[1]}/${teil[2]}` : '',
    Bundesland: obj.bundesland || '',
    Stufe: carried.tier ? `${carried.tier} (${TIER_LABEL[carried.tier] || ''})` : '',
    Einsaetze: svc.einsaetze ?? '',
    Streugutentsorgung: svc.streugutentsorgung == null ? '' : (svc.streugutentsorgung ? 'ja' : 'nein'),
    Angebotsfrist: svc.offerDeadline || '',
    Kontakt: [contact.name, contact.email].filter(Boolean).join(' · '),
    Vor_Ort: (brief.object && brief.object.onSiteContact) || '',
    Offene_Fragen: (brief.openQuestions || []).join(' | '),
    // Am Objekt hinterlegte Links schlagen alles andere - sie stehen dort,
    // weil jemand sie bewusst gesetzt hat.
    Kontrollbild: (obj.sveagLinks && obj.sveagLinks.kontrollbild) || imageLink(obj, opts),
    Aufmassblatt: (obj.sveagLinks && obj.sveagLinks.aufmassblatt) || '',
  };

  const rows = [];
  const seenCategories = new Set();

  // Zuerst die Positionen, die der Kunde genannt hat - in seiner Reihenfolge.
  for (const sector of brief.sectors || []) {
    if (sector.present === false) continue;
    const m = measured.get(sector.category);
    // Mehrere Kundenpositionen auf einer Kategorie (Wohnwege + Treppe sind
    // beide haustuer) teilen sich EINE Messung. Die laesst sich nicht
    // aufteilen - das muss in der Zeile stehen, sonst wird sie doppelt
    // gelesen.
    const shared = (brief.sectors || []).filter(
      (s) => s.category === sector.category && s.present !== false
    ).length > 1;
    const first = !seenCategories.has(sector.category);
    seenCategories.add(sector.category);

    const hinweise = [];
    if (istFolgeteil) {
      hinweise.push(`Kundenangabe gilt fuer die Gesamtanlage und steht an Teil 1/${teil[2]}`);
    }
    if (shared) {
      hinweise.push(`Messung gilt fuer die gesamte Kategorie "${sector.category}", nicht nur fuer diese Position`);
    }
    // Kunde nennt qm, gemessen werden laufende Meter. Das ist kein Fehler,
    // aber die beiden Spalten stehen dann nebeneinander, ohne vergleichbar zu
    // sein - wer die Zeile liest, muss das wissen.
    if (m && first && sector.areaM2 != null) {
      hinweise.push('Kundenangabe in m², Messung in m - kein direkter Vergleich');
    }

    rows.push({
      ...base,
      Position: sectorLabel(sector),
      Kategorie: sector.category,
      Kundenangabe: istFolgeteil ? '' : statedValue(sector),
      Einheit: istFolgeteil ? '' : unitOf(sector),
      Gemessen_m: m && first ? m.meters : '',
      'Abweichung_%': first && !istFolgeteil ? (deviationPct(sector, m ? m.meters : null) ?? '') : '',
      Quelle: istFolgeteil ? '' : (sector.source || ''),
      Annahme: m && m.isAssumption ? 'ja' : '',
      Status: m ? 'zu pruefen' : 'nicht gemessen',
      Hinweis: hinweise.join('; '),
    });
  }

  // Dann, was gemessen wurde, ohne dass der Kunde es genannt hat.
  for (const [category, m] of measured) {
    if (seenCategories.has(category)) continue;
    rows.push({
      ...base,
      Position: category,
      Kategorie: category,
      Kundenangabe: '',
      Einheit: '',
      Gemessen_m: m.meters,
      'Abweichung_%': '',
      Quelle: 'aufmass',
      Annahme: m.isAssumption ? 'ja' : '',
      Status: 'zu pruefen',
      Hinweis: 'vom Kunden nicht genannt - vor dem Angebot klaeren',
    });
  }

  return rows;
}

function sheetRows(state, opts = {}) {
  return (state.objects || []).flatMap((obj) => rowsForObject(obj, opts));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// BOM voran: sonst zerlegt Excel Umlaute, und "Mülltonnen" im Angebot ist
// schlechte Werbung.
function toCsv(rows, { separator = ',', bom = true } = {}) {
  const head = COLUMNS.join(separator);
  const body = rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(separator));
  return (bom ? '﻿' : '') + [head, ...body].join('\n') + '\n';
}

module.exports = {
  COLUMNS, sheetRows, rowsForObject, toCsv, deviationPct, measuredByCategory,
  slugFor, imageLink,
};
