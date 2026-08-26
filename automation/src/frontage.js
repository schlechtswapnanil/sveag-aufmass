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
//
// Die Aufmassblaetter der SVEAG (86 PDFs, jede Strecke einzeln beschriftet)
// erlauben eine schaerfere Aussage. Ein Gehweg besteht dort entweder aus
// EINER Strecke an der Strasse - dafuer ist dieses Verfahren gebaut - oder
// aus mehreren, weil zusaetzlich ein privater Zuweg geraeumt wird:
//
//   eine Teilstrecke   (48 Objekte)  Median-Abweichung 1,1 m,  77 % in ±20 %
//   mehrere Strecken   ( 5 Objekte)  Median-Abweichung 35,8 m,  0 % in ±20 %
//
// Der Zuweg liegt weder auf einer Flurstuecks- noch auf einer Gebaeudekante;
// aus Vektordaten ist er nicht herzuleiten. Und er ist vorher nicht
// erkennbar: der Abstand des Gebaeudes zur Strasse trennt die beiden Gruppen
// nicht (Median 10,9 m gegen 12,8 m, jede Schwelle erzeugt mehr Fehlalarme
// als Treffer). Rund ein Siebtel der Objekte wird deshalb zu niedrig
// geschaetzt, und nur der Blick aufs Kontrollbild faengt das ab.
//
// Gegenprobe: dieselbe Rastersuche allein auf den einteiligen Gehwegen
// liefert genau dieselben drei Zahlen. Die Parameter haengen also nicht an
// den Mehrteilern in der Stichprobe.
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
  const groesster = kandidaten[kandidaten.length - 1];

  // Wie weit die beiden Wege auseinanderliegen, ist ein brauchbarer Hinweis
  // auf die Verlaesslichkeit - und anders als der fehlende Zuweg ist er
  // vorher erkennbar. Ueber 69 Objekte mit Handmessung:
  //
  //   Faktor < 2   55 Objekte   69 % innerhalb ±20 %
  //   Faktor 2-5    9 Objekte   44 %
  //   Faktor > 5    5 Objekte   40 %
  //
  // Das kleinere zu nehmen bleibt trotzdem richtig: mit dem groesseren Wert
  // faellt der Median bei Faktor > 5 auf 1340 % Abweichung, weil dort ein
  // Sammelflurstueck oder ein Sammelpolygon dahintersteckt.
  const faktor = gewaehlt.lengthM > 0 ? groesster.lengthM / gewaehlt.lengthM : 1;
  return {
    lengthM: Math.round(gewaehlt.lengthM * 10) / 10,
    source: gewaehlt.quelle,
    chains: gewaehlt.chains,
    spreadM: kandidaten.length > 1
      ? Math.round((groesster.lengthM - gewaehlt.lengthM) * 10) / 10
      : 0,
    spreadFactor: Math.round(faktor * 10) / 10,
    confidence: faktor < 2 ? 'hoch' : 'niedrig',
  };
}

module.exports = { predictGehweg, frontageChains, FITTED };
