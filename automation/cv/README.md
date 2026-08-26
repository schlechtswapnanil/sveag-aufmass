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

## Aufmaßblätter verorten

`tools/pdf-georef.py` holt die gezeichneten Strecken aus den Aufmaßblättern und
gibt ihnen Koordinaten. Damit liegt zum ersten Mal die **tatsächlich gemessene
Geometrie** vor, nicht nur die Länge aus der Tabelle.

Die Blätter enthalten keine einzige Koordinate — kein BBOX, kein CRS, keine
Kachel-URL. Verortet wird deshalb über das Bild: das Kachelmosaik wird gegen
einen größeren Ausschnitt desselben Landes-Luftbilds geschoben, bis es passt.
Das geht auf, weil die Kacheln aus einer Leaflet-WMS-Ebene stammen und damit im
Web-Mercator-Raster liegen — wird der Vergleichsausschnitt in EPSG:3857 mit
genau der Zoomstufen-Auflösung geholt, bleibt nur eine Verschiebung zu suchen.

**46 von 86 Blättern verortet**, Kreuzkorrelation im Median 0,999, und jedes
davon gegen die Beschriftung gegengeprüft: **Längenabweichung im Median 0,0 %**.
Ergebnis sind 94 Gehweg-Strecken mit echter Geometrie.

Drei Dinge mussten dafür stimmen, jedes davon hat zunächst gefehlt:

* **Die Zoomstufe ist nicht überall gleich.** Das Tool passt die Karte per
  fitBounds an die Strecken an; ein kleines Grundstück landet auf z21, ein
  großes auf z19. Mit fest angenommenem z19 schlugen 50 von 86 fehl. Sie wird
  jetzt aus dem Maßstab abgeleitet (beschriftete Länge ÷ Pfadlänge) und die
  Nachbarstufen werden mitprobiert.
* **Der Adressabgleich** über den vollen Dateinamen ließ 27 Blätter durchfallen,
  obwohl die Adresse bekannt war — mal fehlt das Komma, mal der Ort. Verglichen
  wird jetzt Straße + Hausnummer + PLZ.
* **Die Gegenprobe** verglich sortierte Längen und paarte dadurch ein
  „Front door 1 m" gegen eine 24-m-Linie (2370 % Scheinabweichung). Verglichen
  wird jetzt je Kategorie, mit absoluter Toleranz für die auf ganze Meter
  gerundeten Beschriftungen.

### Was dabei herauskam

Von der tatsächlich gemessenen Gehweg-Länge liegen innerhalb von 4 m

| von einer | Anteil |
|---|---:|
| Flurstückskante | 72 % |
| Gebäudekante | 53 % |
| einer der beiden | **75 %** |

**29 von 39 Objekten liegen zu mindestens 80 % auf einer Kante** — dort kann ein
geometrisches Verfahren die Strecke grundsätzlich finden. Bei vier Objekten
(Hinrichsenstraße 24, Lessingstraße 10, Siemensstraße 24, Thomasiusstraße 15)
liegen **0 %** auf einer Kante: der geräumte Weg verläuft quer über das
Grundstück. Für die ist kein Parametersatz zu finden, weil die Geometrie in den
Vektordaten schlicht nicht vorkommt.

Das deckt sich mit der Obergrenze von 70 %, die die Auswahlregeln erreichen —
und erklärt sie.

## Warum das Luftbild hier nicht weiterhilft

Mit den verorteten Blättern lassen sich die Bildmerkmale zum ersten Mal an
echten Beschriftungen prüfen: 94 Strecken, 1389 m geräumter Weg, 219 640
Bildpunkte auf dem Weg gegen 4,4 Mio. daneben (`tools/sample-labels.py`).

| Merkmal | auf dem Weg | 3–12 m daneben | 12–25 m | 25–45 m |
|---|---:|---:|---:|---:|
| Helligkeit (normiert) | 0,96 | 0,99 | 0,99 | 0,99 |
| Sättigung | 0,38 | 0,27 | 0,26 | 0,26 |
| Textur | 4,35 | 3,95 | 3,69 | 4,07 |
| ExG | 1,08 | 1,24 | 1,62 | 1,97 |
| **Trennschärfe** | | **0,23** | **0,28** | **0,25** |

Die Verteilungen sind praktisch deckungsgleich — bei jedem Abstand. Der
geräumte Gehweg sieht aus wie alles um ihn herum, **weil** alles um ihn herum
ebenfalls befestigt ist: Fahrbahn, Nachbargehweg, Hofzufahrt.

Damit ist die Aufgabe keine Bildsegmentierung. Welcher befestigte Streifen
geräumt werden muss, ist eine Frage der Anliegerpflicht — also des Eigentums,
nicht des Aussehens. Der Vektorweg über Flurstück und Gebäudegrundriss ist
folglich nicht der Notbehelf, für den er hier zeitweise gehalten wurde,
sondern der sachlich richtige.

**Das korrigiert eine frühere Empfehlung in diesem Repository.** Aus „die Wege
sind im Orthophoto sichtbar" wurde geschlossen, ein Bildmodell auf den
verorteten Blättern sei der Weg nach vorn. Die Messung sagt das Gegenteil.

## Gegenprüfung auf der Karte

`tools/vergleichsbild.py` legt Vorhersage und Handmessung zusammen aufs
Luftbild — gelb die gemessene Strecke aus dem verorteten Blatt, cyan die
Vorhersage, weiß das Flurstück, blau der OSM-Grundriss, rot der
Geocoder-Punkt. Zahlen sagen nicht, *warum* eine Vorhersage danebenliegt.

**Der Geocoder ist nicht die Fehlerquelle.** Abstand zwischen Geocoder-Punkt
und tatsächlich gemessenem Gehweg über 39 Objekte: Median 9,4 m, größter Wert
16 m, keiner über 25 m. Der Versatz entspricht dem Abstand Gebäudemitte →
Straßenkante, ist also genau das Erwartete und keine Fehltreffer.

Zwei Bilder erklären den Rest:

* **Daumierstraße 20** (4 % Abweichung): Die Vorhersage liegt auf der
  *Gebäudefassade*, die Handmessung ein paar Meter weiter auf dem *Gehweg*.
  Gleiche Länge, versetzte Lage — die Zahl stimmt, weil die Grundstücksbreite
  dieselbe ist.
* **Heinrich-Heine-Straße 15** (85 % Abweichung): ein **Eckgrundstück**. Die
  Handmessung läuft über *beide* Straßenfronten, zusammen 64 m. Die Vorhersage
  ist ein 9-m-Stummel an einer Gebäudeecke — die Minimum-Regel hat das kleine
  Gebäude statt des großen Flurstücks gewählt.

Der zweite Fall sieht nach einer Regel aus, ist aber keine: „Eckgrundstück →
Kataster" ergibt über alle Objekte **59 %** statt 64 % innerhalb ±20 %. Und
Kataster ist bei einer Straßenrichtung in 16 von 27 Fällen besser, bei zweien
in 10 von 17 — kein Zusammenhang. Siebte geprüfte Regel, siebtes Mal kein
Gewinn.

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
