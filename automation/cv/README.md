# Luftbild-Schritt (Stufe 2)

Leitet die Sektoren ab, die in **keinem Datenbestand** stehen — Einfahrt,
Haustürweg, Tonnenplatz, Stellfläche. Der Gehweg kommt weiter aus dem
Flurstück (`extractFrontage()` im Tool), nicht von hier.

```
node extract-vendor.js ../../Aufmass_2026-08-21.html      # einmalig
python3 run.py --lat 51.893162 --lon 7.191551 --state Nordrhein-Westfalen --out haus
```

Ergebnis: `haus.json` (Linien in lat/lon) und `haus.debug.png` (Kontrollbild).
Ein gelungener Lauf liegt in [`samples/beispiel-einfahrt.png`](samples/beispiel-einfahrt.png):
Einfahrt von der Straße zum Haus, 18,0 m bei ~2,4 m Breite, aus einem
Grundstück, zu dem OSM und Kataster nichts sagen.

Braucht `numpy`, `scipy`, `scikit-image`, `Pillow` — und `node` für die
WFS-Abfrage, die die UTM- und GML-Logik des Tools mitbenutzt statt sie ein
zweites Mal zu schreiben.

## Warum Farbe allein nicht reicht

Naive Farbsegmentierung auf einem NRW-DOP (10 cm/px) hält **56,8 %** des
Ausschnitts für befestigt — Dächer, Winterrasen, Straße und Einfahrt fallen
in dieselbe Klasse ([`samples/gegenbeispiel-nur-farbe.png`](samples/gegenbeispiel-nur-farbe.png)).

Gemessene Mittelwerte über je einen Bildausschnitt:

| Fläche | Helligkeit | Sättigung | ExG (Grün) | Textur |
|---|---:|---:|---:|---:|
| Winterlicher Garten | 93 | 0,14 | **8,5** | 11,4 |
| Straßenasphalt | 160 | 0,05 | **7,5** | 8,6 |
| Gehweg | 160 | 0,14 | 3,4 | 5,1 |
| Dach hell | 201 | 0,04 | 3,2 | 11,2 |
| Rasen grün | 113 | 0,21 | 29,9 | 19,9 |

Der Vegetationsindex trennt **grünen** Rasen sauber (29,9) und ruhenden Garten
gar nicht (8,5 gegen 7,5 bei Asphalt). Das ist kein Randfall: die brauchbaren
DOP-Serien sind unbelaubt aufgenommen, weil man nur dann den Boden sieht — und
genau dann ist Vegetation farblich tot.

Erst drei Merkmale zusammen tragen: **normierte Helligkeit** (Winterboden 93
gegen Belag 160; die Normierung auf die lokale Beleuchtung rettet die
beschatteten Wegstücke), **Sättigung** und **Textur** (Belag glatt, Boden
nicht). Damit fiel die Fehlfläche im Testgrundstück von 115 m² auf 34 m².

Helle, glatte **Dächer** rutschen durch alle drei Filter. Sie werden über den
OSM-Gebäudegrundriss ausgeschnitten — ohne diese Maske trägt das Verfahren
nicht.

## Was die Zuordnung entscheidet

Einfahrt und Terrassenbelag sehen von oben gleich aus. Unterschieden werden
sie über **Berührung**, nicht über Aussehen:

| Berührt | Breite | → Kategorie |
|---|---|---|
| Straßenkante | ≥ 2,2 m | `garage` (Einfahrt) |
| Straßenkante + Gebäude | < 2,2 m | `haustuer` |
| nur Gebäude | — | `haustuer` |
| nichts davon, ≥ 20 m² | ≥ 3,5 m | `parkplatz` |

„Straßenkante" ist bewusst nicht die Straßenachse: die liegt außerhalb des
Flurstücks, eine Einfahrt berührt sie nie. Genommen wird der Bereich, in dem
das Flurstück der Achse auf 8 m nahekommt.

## Gefundener Fehler im Tool

`wfsGetFeatureUrl()` fragt das Flurstück mit `count: '5'` ab. In dichter
Bebauung liegen mehr als fünf Flurstücke im ±25-m-Fenster, und das **gesuchte
ist nicht zwingend unter den ersten fünf**. Findet `loadParcelFrontage()` dann
keinen Ring, der den Punkt enthält, fällt es auf *alle* zurückgelieferten
Ringe zurück und misst die Straßenfront der **Nachbarn** — stillschweigend,
ohne Hinweis in der Oberfläche.

Fünf NRW-Adressen geprüft, zwei betroffen:

| Adresse | Ringe bei `count=5` | enthaltend | Gehweg-Entwurf | mit `count=50` |
|---|---:|---:|---:|---:|
| Bocholt | 5 | **0** | **128 m** | 35 m (16 Ringe) |
| Dortmund | 5 | **0** | **286 m** | 189 m (12 Ringe) |
| Werl | 3 | 1 | 280 m | 280 m |
| Coesfeld | 5 | 1 | 26 m | 26 m |
| Gütersloh | 5 | 1 | 5 m | 5 m |

In Bocholt wird das Dreifache angeboten. Betroffen ist gerade die
Reihenhausbebauung, also der typische Kundenfall.

**Zwei Änderungen** in `src/wfs.js` / `src/app.js` (Quell-Repo, nicht im
Bundle):

1. `count: '5'` → `count: '100'`. Die Antwort bleibt klein (16 Ringe ≈ 9 KB).
2. In `loadParcelFrontage()` bei leerem `containing` **nicht** auf alle Ringe
   zurückfallen, sondern melden: „Flurstück nicht eindeutig — Gehweg manuell
   zeichnen". Ein stiller falscher Wert ist schlechter als keiner.

`parcel-query.js` prüft beides schon gegen und meldet `truncated: true`, wenn
die heutige Abfrage danebengegriffen hätte.

## Was verworfen wird

Zwei Fehlgriffe kamen aus derselben Ursache: die Erkennung unterschied nicht
zwischen Belag und nacktem Winterboden und meldete trotzdem eine Zahl.

**Ein Parkplatz braucht eine Straßenanbindung.** `parkplatz` wurde früher
allein nach Größe und Breite vergeben — ohne jeden Ankerpunkt. Ein Leipziger
Hinterhof wurde so zu 103 m² Stellfläche. Ein Auto muss hinkommen können.

**Ein Weg ist nicht die halbe Parzelle.** Kommt die Erkennung auf mehr als
**40 %** der Arbeitsfläche, ist das keine Wegefläche, sondern eine
fehlgeschlagene Unterscheidung. Dann liefert `run.py` `reliable: false` und
**kein** Ergebnis.

| Fall | Anteil | Ergebnis |
|---|---:|---|
| Coesfeld, Einfamilienhaus | 13 % | Einfahrt 44 m² — brauchbar |
| Heschredder, Wohnanlage HH | 16 % | Einfahrt 46 m², Zuwegung 46 m² — teils brauchbar |
| Erdkampsweg / Herrnhuter / Flemmingstraße | 2–7 % | nur `sonstiges`, nichts Verwertbares |
| Theodor-Neubauer, Hinterhof | **49 %** | **verworfen** |

Die Grenze ist bewusst grob. Sie fängt den offensichtlichen Fehlgriff ab, nicht
den knappen Fall.

## Was nicht half

Eine **adaptive Helligkeitsschwelle** (Otsu über die Arbeitsfläche, mit einer
Prüfung auf Trennschärfe) räumte an Mehrfamilienhäusern das Rauschen weg —
zerlegte aber die einzige sauber erkannte Einfahrt von 44 m² auf 16 m² in zwei
Stücke. An fünf Fällen eine Schwelle zu justieren, die 0,54 von 0,60 trennt,
wäre Anpassung an die Stichprobe, keine Verbesserung.

Der Code steht noch da (`paved_mask(..., adaptive=True)`), der Trennschärfe-Wert
wird berechnet und gemeldet, benutzt wird er nicht. Mit mehr Vergleichsfällen
lohnt ein zweiter Blick.

## Grenzen

- **Nur 9 Bundesländer** haben Luftbild *und* Flurstück offen: BW, BB, HH, MV,
  NI, NRW, SL, SN, RP. In BY, HE, ST, SH, TH fehlt der Flurstücksdienst, in
  HB und RP das Landes-Luftbild — dort bleibt es beim Zeichnen von Hand.
- **Parkende Autos** verdecken Einfahrt und Gehweg und reißen Flächen
  auseinander. Ein Auto auf der Einfahrt kostet Länge.
- **Der Geocoder trifft die Hausmitte, nicht das Grundstück.** Liegt der Punkt
  im Nachbargebäude, ist das Flurstück falsch — und der Fehler ist von hier
  aus nicht erkennbar. Deshalb bricht `run.py` ab, statt zu raten.
- **Mehrfamilienhäuser bleiben schwach.** Von sechs geprüften Objekten liefert
  eines (Einfamilienhaus) ein sauberes Ergebnis, eines (Wohnanlage) ein
  teilweise brauchbares, drei nichts Verwertbares, eines wird verworfen. Für
  Wohnanlagen ist das kein Messverfahren, sondern bestenfalls ein Hinweis.
- **Kein Freigabe-Ersatz.** Alles hier ist `isAssumption: true`. Die Schwellen
  sind an NRW-Winterbildern kalibriert; andere Länder und Jahreszeiten
  brauchen eigene Werte.

## Offen

- Einbau ins Tool: entweder als kleiner Dienst neben dem Browser oder auf
  Canvas portiert. Für die Freigabe im Tool spricht, dass die Linien dort
  ohnehin bearbeitet werden.
- Kalibrierung gegen von Hand gemessene Objekte — solange die fehlt, ist
  „18,0 m" eine plausible Zahl, keine geprüfte.
