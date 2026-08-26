// Kundenbegriffe -> die fuenf Kategorien des Tools.
//
// Ausschreibungen benutzen nicht die Woerter des Tools. Eine Genossenschaft
// schreibt "Wohnwege", "Oeffentliche Gehwege", "Muellstandorte",
// "Kellerniedergaenge"; das Tool kennt gehweg, haustuer, garage, parkplatz,
// muelltonnen. Statt die Kategorien zu vermehren, wird abgebildet - und der
// Originalbegriff wandert ins `label`, damit im Angebot und im Sheet noch
// steht, wonach der Kunde gefragt hat.
//
// Reihenfolge ist bedeutsam: der erste Treffer gewinnt, spezifische Muster
// stehen vor allgemeinen ("Garagenzufahrt" vor "Zufahrt", "Muellstandort"
// vor "Standort").

const TERM_MAP = [
  // Muell zuerst: "Muelltonnen Zuwegung" enthaelt "Zuwegung", das sonst als
  // Hauszugang durchginge.
  { re: /m[üu]ll|tonnen|wertstoff/i, category: 'muelltonnen' },

  // Garage/Einfahrt vor den allgemeinen Weg-Begriffen.
  { re: /garage|tiefgarage|einfahrt|zufahrt|carport|rampe zur garage/i, category: 'garage' },

  // Stellflaechen.
  { re: /stellpl|parkpl|besucherpark|hoffl[äa]che|parkfl/i, category: 'parkplatz' },

  // Oeffentlicher Gehweg / Anliegerpflicht.
  { re: /b[üu]rgersteig|gehweg|gehsteig|fu[ßs]weg/i, category: 'gehweg' },

  // Alles, was zum Haus fuehrt oder daran haengt - inkl. Treppen und
  // Kellerniedergaengen. Sie sind Teil des Hauszugangs; das Original steht im
  // Label, damit die Position im Angebot wiedererkennbar bleibt.
  { re: /wohnweg|hauszugang|hauseingang|haupteingang|haust[üu]r|zuwegung|zugang/i, category: 'haustuer' },
  { re: /treppe|stufen|niedergang|podest|rampe/i, category: 'haustuer' },
];

// Gibt die Tool-Kategorie zu einem Kundenbegriff zurueck, oder null.
// Der Aufrufer behaelt den Originalbegriff und legt ihn ins `label`.
function mapTerm(term) {
  if (typeof term !== 'string') return null;
  for (const { re, category } of TERM_MAP) {
    if (re.test(term)) return category;
  }
  return null;
}

// Belegte Abbildungen aus echten Anfragen. Dient der Nachvollziehbarkeit und
// als Testgrundlage - jede Zeile stammt aus einer tatsaechlichen Mail.
const OBSERVED = [
  ['Fußwege', 'gehweg'],
  ['Gehweg vor dem Grundstück', 'gehweg'],
  ['Öffentliche Gehwege', 'gehweg'],
  ['Hauszugänge + Stufen', 'haustuer'],
  ['Weg zum Hauseingang', 'haustuer'],
  ['Zuwegung Haupteingang', 'haustuer'],
  ['Hauszugangstreppe', 'haustuer'],
  ['Wohnwege', 'haustuer'],
  ['Kellerniedergänge (Podest, Stufen, Rampe)', 'haustuer'],
  ['Garagenzufahrt', 'garage'],
  ['Zufahrt Tiefgarage', 'garage'],
  ['Mülltonnen Zuwegung', 'muelltonnen'],
  ['Müllstandorte', 'muelltonnen'],
  ['Müllstandplatz', 'muelltonnen'],
  ['Stellplaetze Besucher', 'parkplatz'],
];

module.exports = { TERM_MAP, OBSERVED, mapTerm };
