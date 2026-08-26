// Gehweg-Vorhersage aus amtlicher Geometrie.
//
// Nicht aus dem Luftbild: das Flurstueck und der Gebaeudegrundriss sind
// vermessen, das Winterluftbild ist es nicht. Fuer den Gehweg - die Position,
// die in fast jeder Anfrage steht - ist der Vektorweg deutlich genauer.
//
// Die drei Parameter sind an 85 Handmessungen der SVEAG ausgerichtet
// (Leipziger Objektliste, Aug. 2026), Rastersuche auf der einen Haelfte,
// Bewertung auf der anderen. Siehe tools/fit.js und README.

const { extractFrontage } = require('../vendor/parcel.js');

// Ausgangswerte des Tools waren {15, 30, 3}. Auf der Testhaelfte:
//   Median-Abweichung 4,5 m -> 1,9 m, innerhalb ±20 % 54 % -> 58 %.
// Ueber den gesamten Datensatz 55 % -> 64 % innerhalb ±20 %.
const FITTED = { maxDistM: 10, maxAngleDeg: 50, minLenM: 8 };

// Der engere Zuschnitt laesst kurze Fronten ganz wegfallen: 7 von 76 Adressen
// liefern damit kein Ergebnis statt 1. Das ist Absicht - keine Zahl ist
// ehrlicher als eine falsche, und die Freigabe sieht die Luecke.
function frontageChains(rings, streets, opts = FITTED) {
  if (!Array.isArray(rings) || rings.length === 0) return [];
  if (!Array.isArray(streets) || streets.length === 0) return [];
  return extractFrontage(rings, streets, opts);
}

const summe = (chains) => chains.reduce((n, c) => n + c.lengthM, 0);

// Flurstueck und Gebaeude liefern beide eine Front; genommen wird die
// kleinere. Grund: die Ausreisser gehen fast immer nach oben - ein
// Gruenderzeit-Karree als EIN Flurstueck (511 m statt 14 m), oder eine ganze
// Haeuserzeile als EIN OSM-Polygon (228 m statt 9 m). Der jeweils andere Weg
// ist dann der vernuenftige. Ueber alle 76 Adressen: Median-Abweichung 3,9 m
// (nur Flurstueck) bzw. 5,6 m (nur Gebaeude) gegen 3,1 m fuer das Minimum.
function predictGehweg({ parcelRings, buildingRing, streets }, opts = FITTED) {
  const kandidaten = [];
  if (parcelRings && parcelRings.length) {
    const c = frontageChains(parcelRings, streets, opts);
    if (summe(c) > 0) kandidaten.push({ quelle: 'kataster', chains: c, lengthM: summe(c) });
  }
  if (buildingRing) {
    const c = frontageChains([buildingRing], streets, opts);
    if (summe(c) > 0) kandidaten.push({ quelle: 'osm-gebaeude', chains: c, lengthM: summe(c) });
  }
  if (!kandidaten.length) return null;
  kandidaten.sort((a, b) => a.lengthM - b.lengthM);
  const gewaehlt = kandidaten[0];
  return {
    lengthM: Math.round(gewaehlt.lengthM * 10) / 10,
    source: gewaehlt.quelle,
    chains: gewaehlt.chains,
    // Wie weit die beiden Wege auseinanderliegen. Ein grosser Abstand heisst
    // nicht "falsch", aber "besonders genau hinsehen" - dort steckt fast
    // immer ein Sammelflurstueck oder ein Sammelpolygon dahinter.
    spreadM: kandidaten.length > 1
      ? Math.round((kandidaten[kandidaten.length - 1].lengthM - gewaehlt.lengthM) * 10) / 10
      : 0,
  };
}

module.exports = { predictGehweg, frontageChains, FITTED };
