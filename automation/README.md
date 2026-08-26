# Aufmaß-Automatisierung — Stufe 1: E-Mail → Brief

Erster Baustein der Automatisierung: aus einer Kundenanfrage wird ein
**geprüfter Brief** und daraus ein Objekt, das im Aufmaß-Tool
(`../Aufmass_2026-08-21.html`) direkt geladen werden kann.

Keine Abhängigkeiten. Kein `npm install`. Nur Node ≥ 20.

```
node cv/extract-vendor.js ../Aufmass_2026-08-21.html         # einmalig
npm test                                                     # 52 Tests

node src/cli.js validate samples/tier-b.brief.json --source samples/tier-b.email.txt
node src/cli.js prepare  samples/tier-b.brief.json --source samples/tier-b.email.txt -o work/x.import.json
#   -> im Tool unter "Objekte → Import (JSON)" laden, messen,
#      dann "Objekte → Export (JSON)" speichern
node src/cli.js sheet    work/x.measured.json -o work/x.sheet.csv
```

**Wie das geprüft wird, steht in [TESTING.md](TESTING.md)** — inklusive der
Fälle, die absichtlich fehlschlagen müssen.

## Wozu der Brief

Zwischen Mail und Messung fehlte bisher eine Zwischenstufe, in der festgehalten
ist, **woher jede Angabe stammt**. Ohne die lässt sich später nicht mehr sagen,
ob die 12 m in einem Angebot gemessen, vom Kunden geschätzt oder geraten waren —
und genau das fragt ein Kunde, der widerspricht.

Jede Angabe trägt deshalb `source` (`email` · `kataster` · `osm` · `luftbild-ki` ·
`annahme`) und, wo sie aus der Mail kommt, ein wörtliches `evidence`-Zitat.

## Der 3-Stufen-Fallback

`tier` wird **berechnet** (`classifyTier()`), nicht vom Modell geschätzt. Sonst
landen zwei gleichartige Mails in verschiedenen Stufen und der Fallback ist
wertlos.

| Stufe | Auslöser | Was daraus folgt |
|---|---|---|
| **A** — nur Adresse | kein Sektor genannt, Objekttyp unbekannt | alles wird hergeleitet, alles gilt als Annahme |
| **B** — Teilangaben | irgendetwas ist gesagt, aber nicht alles gemessen | Kundenangaben grenzen die Messung ein; Schätzungen werden nachgemessen |
| **C** — vollständig | ein **bemaßter** Plan liegt bei, **oder** jeder genannte Sektor hat ein Maß und der Objekttyp steht fest | Kundenmaße gelten; die Messung prüft nur noch gegen |

Ein `sveagBrief.toMeasure` am Objekt sagt, welche Kategorien überhaupt noch
gemessen werden müssen — Stufe C liefert dort oft eine leere Liste.

## Einheiten und Kategorien

Echte Anfragen nennen **Quadratmeter** („Wohnwege gesamt 291,00 qm"), gelegentlich
laufende Meter („Einfahrt ca. 12 m"). Der Brief übernimmt beides so, wie es
dasteht (`areaM2`, `lengthM`), rechnet nichts um und ergänzt keine Breite.
Entschieden am 2026-08-26: **keine Breiten-Annahmen** — was nicht gemessen oder
genannt ist, wird auch nicht behauptet.

Die **fünf Tool-Kategorien bleiben**. Ausschreibungen benutzen andere Wörter;
`src/vocabulary.js` bildet sie ab und der Originalbegriff bleibt im `label`
erhalten:

| Kundenbegriff | Kategorie |
|---|---|
| Öffentliche Gehwege, Fußwege, Bürgersteig | `gehweg` |
| Wohnwege, Hauszugang, Treppen, Kellerniedergänge | `haustuer` |
| Garagenzufahrt, Einfahrt, Tiefgaragenrampe | `garage` |
| Stellplätze, Besucherparkplatz | `parkplatz` |
| Müllstandorte, Mülltonnen Zuwegung | `muelltonnen` |

Auf dem Aufmaßblatt steht dann „Wohnwege 291 m²", nicht „Haustür 291 m²" — die
Kategorie steuert nur die Messung, der Kunde liest seinen eigenen Begriff.

Mehrere Positionen dürfen auf dieselbe Kategorie fallen; unterschieden werden
sie am `label`. Gemessen wird eine Kategorie, sobald **eine** ihrer Positionen
kein festes Maß hat.

## Was echte Anfragen geändert haben

Die erfundenen Beispiele hatten drei Annahmen versteckt, die an den ersten
echten Anfragen sofort brachen:

**Die Adresse steht meist nicht im Mailtext.** Beide verwiesen nur auf sie
(„für das o. g. Objekt", „in o. a. Wohnanlage") — gemeint ist der Betreff oder
eine Vorgänger-Mail. Beides gehört in den Quelltext (siehe oben).
`addressRaw` darf `null` sein, mit `addressSource` daneben; fehlt sie ganz,
muss eine offene Frage danach im Brief stehen, und `prepare` bricht ab, statt
ein Objekt ohne Ort anzulegen.

**Ein Plan ist kein Aufmaß.** Die erste Regel hob jede Anfrage mit Anhang auf
Stufe C. Die eine Anfrage hatte eine Flurkarte mit gelb und blau markierten
Flächen — die sagt *welche* Bereiche, nicht *wie lang*. Das ist Stufe B. Nur
`hasDimensions: true` hebt noch auf C.

**Aufzählungen sind abschließend.** Beide Anfragen listen die Bereiche
vollständig auf. Ohne `sectorListIsExhaustive: true` hätte die Messung
vorsorglich auch den Parkplatz ausgemessen, den keine der beiden bestellt hat.

**Eine Wohnanlage läuft über mehrere Straßen.** Die Ausschreibung nennt drei
Straßenzüge für einen Auftrag. Eine Koordinate deckt das nicht ab, also
erzeugt `prepare` jetzt ein Objekt je Adresse (`moreAddresses`), jeweils mit
„Teil n von m" in der Notiz.

**`addressRaw` bleibt wörtlich, der Suchbegriff wird gebaut.** Die Mail
schreibt „Wohnanlagen in Hamburg Fuhlsbüttel Erdkampsweg 83 – 87" — die
Adresse steht dort ohne Ort. Der Extraktor hatte sie umgestellt, was die
Beleg-Prüfung zu Recht abwies. Jetzt trägt `addressRaw` das Zitat und
`geocodeQuery()` ergänzt Ort und PLZ nur für die Suche.

**Der Leistungsumfang hängt an der Einsatzzahl.** „15 Winterdiensteinsätze
inkl. Streugutentsorgung", Standard sind 12, jeder weitere wird berechnet.
Dafür gibt es jetzt `service.einsaetze`, `streugutentsorgung` und
`offerDeadline`.

Dazu zwei kleinere: Treppen sind eine eigene Position (beide Anfragen nennen
sie), und `geocode()` weist einen leeren Suchbegriff jetzt ab — vorher lieferte
Photon auf `null` ein Dorf in Frankreich und legte das Objekt dort an.

Nachgebaute, anonymisierte Fassungen beider Anfragen liegen als
`samples/tier-b-flurkarte.*` und `samples/tier-b-aufzaehlung.*` und laufen als
Regressionstest mit. Die Originale bleiben unter `work/` (nicht versioniert),
weil sie Kundennamen tragen.

## Der Quelltext

Geprüft wird gegen den **Quelltext**: alles, was beim Extrahieren vorlag —
Betreffzeile, Mailtext und die zitierten Vorgänger-Nachrichten. Die Skill
`/aufmass-brief` holt den Thread aus Gmail und schreibt ihn als eine Datei,
Betreff zuerst.

Dass der Betreff mit hineingehört, ist keine Formalie: Anfragen schreiben „für
das o. g. Objekt" und meinen ihn. Eine frühere Fassung nahm Adressen aus dem
Betreff von der Prüfung aus, weil er nicht mitgeliefert wurde — damit blieb
ausgerechnet die Adresse ungeprüft, die nirgends im Text steht. Jetzt trägt
auch sie einen Beleg, und eine gedrehte Hausnummer fällt auf.

## Die Halluzinations-Bremse

Ein Sprachmodell, das Maße aus Mails zieht, erfindet früher oder später eines.
Deshalb wird jedes `evidence`-Zitat maschinell gegen den Quelltext geprüft
(`evidenceErrors()`): findet es sich dort nicht wörtlich wieder, fällt der
ganze Brief durch.

Toleriert wird nur, was harmlos ist — Zeilenumbrüche (ein umbrochener Satz
zählt weiter) und bei Adressen zusätzlich Satzzeichen (ein eingefügtes Komma
zwischen Straße und PLZ ist kein Betrug). Eine gedrehte Hausnummer fällt auf.

## Dateien

| Datei | Inhalt |
|---|---|
| `schema/brief.schema.json` | der Vertrag — was ein Brief enthalten darf |
| `prompts/parse-email.md` | die Extraktionsanweisung fürs Modell |
| `src/vocabulary.js` | Kundenbegriffe → die fünf Tool-Kategorien |
| `src/brief.js` | Tier-Einstufung, Beleg- und Konsistenzprüfung |
| `src/schema-check.js` | schlanker Schema-Validator (statt ajv, damit dependency-frei) |
| `src/to-aufmass.js` | Brief → Objekt im Format von `importJson()` des Tools |
| `src/geocode.js` | Photon, gleiche Auswertung wie `geocode()` im Tool |
| `src/to-sheet.js` | gemessenes Objekt → Zeilen für die Tabelle |
| `src/cli.js` | `validate`, `prepare` und `sheet` |
| `samples/` | je eine Mail + Brief für Stufe A, B und C |

Bequemer als die CLI: die Skill `/aufmass-brief` (`.claude/skills/aufmass-brief/`)
macht denselben Ablauf aus einem Gmail-Thread heraus.

## Zwei bewusste Entscheidungen

**Kundenangaben werden nie zu Linien.** Eine Zahl aus der Mail hat keine
Geometrie; eine dazu erfundene Linie wäre schlimmer als gar keine. Die Angaben
landen in `assumptionsNote` — also auf dem gedruckten Aufmaßblatt, direkt neben
den gemessenen Werten, wo die Freigabe sie vergleichen kann.

**`sveagBrief` ist ein Zusatzfeld**, das das Tool nicht kennt. `importJson()`
und `exportJson()` reichen unbekannte Keys unverändert durch, also reist die
Herkunft mit dem Objekt mit und steht dem späteren Sheet-Export offen. Beim
nächsten Umbau des Tools ist das mit zu bedenken.

## Stufe 2: der Luftbild-Schritt

Liegt in [`cv/`](cv/README.md) — leitet Einfahrt, Haustürweg und Stellfläche
aus dem Landes-Orthophoto ab, begrenzt durch Flurstück und OSM-Gebäude. Das
sind die Sektoren, die in keinem Datenbestand stehen und deshalb heute von
Hand geklickt werden.

Dort steht auch ein **Fehler im Tool** dokumentiert, der den heute schon
automatischen Gehweg-Vorschlag betrifft: `count: '5'` in `wfsGetFeatureUrl()`
lässt in dichter Bebauung das richtige Flurstück aus der Antwort fallen, und
das Tool misst dann stillschweigend die Front der Nachbarn. In zwei von fünf
geprüften NRW-Adressen trat das auf, einmal mit 128 m statt 35 m.

## Der Rücklauf

`sheet` nimmt den Export des Tools **nach** dem Messen und schreibt eine Zeile
je Position — Kundenangabe und Messung nebeneinander, damit die Freigabe
vergleichen kann. Der Brief reist in `sveagBrief` am Objekt mit, also steckt
beides in einer Datei.

Drei Dinge, die die Zeilen bewusst tun:

**Die Kundenangabe steht nur an Teil 1.** Eine Ausschreibung nennt *eine*
Summe für die ganze Anlage („insgesamt 1.077,30 qm"), nicht je Straßenzug.
Stünde sie an jedem der drei Objekte, ergäbe die Spaltensumme das Dreifache.
Gemessen wird umgekehrt je Teil, also steht das an jeder Zeile.

**Geteilte Kategorien werden ausgewiesen.** „Wohnwege" und „Kellerniedergänge"
sind beide `haustuer` — eine Messung, zwei Positionen. Nur die erste Zeile
trägt den Messwert, die zweite sagt im Hinweis, warum sie leer ist.

**qm und laufende Meter werden nicht verrechnet.** Beide Spalten sind gefüllt,
die Abweichung bleibt leer und der Hinweis sagt, dass hier nichts vergleichbar
ist.

Alles steht auf `zu pruefen`. Nichts setzt sich selbst auf freigegeben.

### Kontrollbild je Zeile

Die Spalte `Kontrollbild` verlinkt das Luftbild mit den eingezeichneten
Sektoren — wer die Zeile freigibt, sieht damit sofort, worauf die Zahl beruht.
Gerade wenn sie nicht stimmt, ist das der schnellste Weg, es zu merken.

```
node src/cli.js sheet work/x.measured.json --images work/bilder -o work/x.sheet.csv
node src/cli.js sheet work/x.measured.json --image-map work/drive.json -o work/x.sheet.csv
```

`--images` sucht je Objekt nach `<adress-slug>.debug.png` — genau der Name, den
`cv/run.py --out` schreibt. Daraus werden `file://`-Links: gut zum
Selbstnachsehen, nutzlos in einem Sheet, das jemand anderes öffnet. Der Befehl
sagt das auch.

`--image-map` nimmt eine Zuordnung `{ "<Adresse|Objekt-ID|Slug>": "<URL>" }` und
trägt echte Web-Links ein, etwa aus Google Drive. Einzelne Links lassen sich
auch direkt am Objekt hinterlegen (`sveagLinks.kontrollbild`,
`sveagLinks.aufmassblatt`); die schlagen jede Konvention.

Ein Bild, das es nicht gibt, wird **nicht** verlinkt — ein toter Link sieht aus
wie ein Beleg.

**Das PDF** macht das Tool selbst (Knopf „PDF", A4 mit Karte und Tabelle) —
und zwar in der Freigabe, wo ohnehin jemand draufschaut. Ein kopfloser
Druckdurchlauf wäre möglich (Playwright), spart hier aber nichts.

## Was noch fehlt

- **Kalibrierung des Luftbild-Schritts** gegen von Hand gemessene Objekte.
  Solange die fehlt, sind die Zahlen plausibel, nicht geprüft.
- **`count: '5'`-Fehler** im Tool (siehe `cv/README.md`) — braucht das Quell-Repo.
- **Gegenprüfung** bei Stufe B/C automatisch melden, sobald Messung und
  Kundenangabe dieselbe Einheit haben.
