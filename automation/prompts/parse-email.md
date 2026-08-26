# Extraktionsanweisung: Kundenmail → Aufmaß-Brief

Du bekommst den Volltext einer Winterdienst-Anfrage. Gib **ausschließlich** ein
JSON-Objekt nach `schema/brief.schema.json` zurück — kein Fließtext, kein
Markdown-Fence.

## Grundregel

Der Brief bildet ab, **was in der Mail steht** — nicht, was am Objekt vermutlich
der Fall ist. Die Messung kommt später und hat eigene Quellen (Kataster,
Luftbild). Wer hier ergänzt, verfälscht genau die Unterscheidung, für die es
den Brief gibt.

Konkret:

- **Nie eine Zahl erfinden.** Nennt die Mail keine Länge, ist `lengthM: null`.
- **Nie eine Adresse vervollständigen.** `addressRaw` steht wörtlich so in der
  Quelle. Fehlt die PLZ, bleibt `postcode: null`.
- **Nie einen Sektor annehmen.** Dass ein Einfamilienhaus üblicherweise eine
  Einfahrt hat, ist keine Aussage der Mail. `present: null` oder Sektor weglassen.

`present` hat drei Werte, und der Unterschied trägt die ganze Automatisierung:

| Wert | Bedeutung | Folge in der Messung |
|---|---|---|
| `true` | Mail nennt den Sektor als zu räumen | wird gemessen |
| `false` | Mail schließt ihn ausdrücklich aus | wird **nicht** gemessen, nicht angeboten |
| `null` | Mail sagt nichts dazu | wird gemessen, Ergebnis gilt als Annahme |

`false` ist eine starke Aussage: es unterdrückt einen Sektor im Angebot. Nur
setzen, wenn die Mail ihn wirklich ausschließt („gehört nicht zum Objekt",
„muss nicht geräumt werden"), nicht bei bloßem Schweigen.

## Die Adresse steht oft nicht in der Mail

Anfragen von Hausverwaltungen verweisen auf sie: „für das **o. g.** Objekt",
„in **o. a.** Wohnanlage". Gemeint ist der Betreff oder eine Vorgänger-Mail.
Beides liegt dir hier nicht vor.

Dann gilt: `addressRaw: null`, `addressSource: "fehlt"`, und eine offene
Frage, die das Wort „Adresse" enthält. Erfinde nichts und nimm auch nicht den
Stadtteil als Adresse — „Harburg/Wilstorf" ist kein Objekt, und ein Geocoder
findet darauf irgendeinen Punkt im Bezirk.

`addressSource` sagt, woher sie stammt: `email-body` (im Text, wird gegen ihn
geprüft), `betreff`, `thread`, `anhang`, `fehlt`.

## Aufzählungen sind abschließend

„… wie folgt: * Gehweg * Weg zum Hauseingang * Hauszugangstreppe" oder „in Gelb
markiert sind: …" ist eine **vollständige** Liste. Dann `sectorListIsExhaustive:
true` — nicht Genanntes gilt als nicht beauftragt und wird nicht gemessen.

Ohne dieses Kennzeichen misst der Luftbild-Schritt vorsorglich jede ungenannte
Kategorie aus und bietet womöglich einen Parkplatz an, den niemand bestellt
hat. Setze es, sobald die Mail erkennbar aufzählt statt beispielhaft zu nennen.

## Plan ≠ Aufmaß

Ein beiliegender Plan hebt die Anfrage **nicht** automatisch auf Stufe C. Eine
Flurkarte mit farbig markierten Flächen beantwortet *welche* Bereiche, nicht
*wie lang* — das Aufmaß steht noch aus, das ist Stufe B.

`hasDimensions: true` nur, wenn der Plan Maße trägt. Im Zweifel `false`.

## Belege

Jeder Sektor mit `source: "email"` braucht ein `evidence`-Zitat: **wörtlich**
aus der Mail, lang genug, um die Angabe allein zu tragen. Zeilenumbrüche im
Original darfst du zu Leerzeichen glätten, sonst nichts — kein Kürzen mitten im
Wort, keine Korrektur von Tippfehlern, keine Auslassungszeichen.

Das Zitat wird maschinell gegen den Mailtext geprüft (`evidenceErrors()`). Ein
Zitat, das sich nicht wiederfindet, lässt den ganzen Brief durchfallen. Das ist
Absicht: es ist der einzige Mechanismus, der eine erfundene Zahl abfängt.

## Kategorien

Das Tool hat **fünf** Kategorien, Ausschreibungen benutzen andere Wörter. Bilde
ab — und lege den **Originalbegriff ins `label`**, damit im Angebot und im Sheet
noch steht, wonach der Kunde gefragt hat. `src/vocabulary.js` hält die Tabelle
und `mapTerm()` wendet sie an.

| Kategorie | Kundenbegriffe (belegt) |
|---|---|
| `gehweg` | Gehweg, Bürgersteig, Fußwege, „Öffentliche Gehwege", „Gehweg vor dem Grundstück" |
| `haustuer` | Hauszugang, Hauseingang, „Weg zum Hauseingang", „Zuwegung Haupteingang", **Wohnwege**, **Treppen/Stufen**, **Kellerniedergänge (Podest, Stufen, Rampe)** |
| `garage` | Garagenzufahrt, Einfahrt, Zufahrt, Tiefgaragenrampe |
| `parkplatz` | Stellplätze, Besucherparkplatz, Hoffläche |
| `muelltonnen` | „Mülltonnen Zuwegung", Müllstandort, Müllstandplatz, Tonnenplatz |
| `sonstiges` | nur, wenn wirklich nichts passt — **braucht ein `label`** |

Spezifisch schlägt allgemein: „Mülltonnen Zuwegung" ist `muelltonnen`, nicht
`haustuer`, obwohl „Zuwegung" darin steht. „Garagenzufahrt" ist `garage`, nicht
irgendein Weg.

**Mehrere Positionen dürfen auf dieselbe Kategorie fallen.** „Wohnwege" und
„Kellerniedergänge" sind beide `haustuer` — das ist richtig so, sie werden
gleich gemessen. Sie brauchen dann aber **unterschiedliche `label`**, sonst
gelten sie als dieselbe Position doppelt.

**Treppen sind Sektoren.** Sie kamen in jeder bisher gesehenen Anfrage vor und
kosten beim Räumen mehr Aufwand als der Weg davor. Also `haustuer` mit
`label: "Hauszugangstreppe"` — nicht als Fußnote in `service.specials`, wo sie
aus der Positionsliste verschwinden.

Nach `service.specials` gehört, was keine Fläche ist: Zeitfenster,
Streugutverbote, Zugangsregelungen.

## Maße: nimm, was dasteht

Kunden nennen meist **Quadratmeter** („Wohnwege gesamt 291,00 qm"), manchmal
laufende Meter („Die Einfahrt ist ca. 12 m lang"). Übernimm die Einheit, die
in der Mail steht — `areaM2` bzw. `lengthM`. Rechne **nichts** um und ergänze
keine Breite; eine Breite, die niemand genannt hat, ist geraten.

## `tier` nicht schätzen

Setze `tier` nach dieser Regel — sie wird nachgerechnet und eine Abweichung ist
ein Fehler:

1. Liegt ein Plan mit `hasDimensions: true` bei → **C**
2. Sonst: mindestens ein Sektor `present: true`, **jeder** davon hat ein Maß,
   und `objectType` ist nicht `unbekannt` → **C**
3. Sonst: kein einziger Sektor mit `present` `true`/`false` **und**
   `objectType: "unbekannt"` → **A**
4. Sonst → **B**

Maßgeblich ist immer, ob **Maße** vorliegen. Eine fehlende Adresse ändert die
Stufe nicht — sie ist eine offene Frage, keine Einstufung.

## Schätzungen

`isEstimate: true`, sobald der Kunde selbst relativiert („ca.", „etwa",
„geschätzt", „ungefähr"). Ein geschätztes Maß wird trotzdem nachgemessen; ein
festes Maß nur noch gegengeprüft. Der Unterschied entscheidet, ob eine
Abweichung später gemeldet wird oder nicht.

## `openQuestions`

Nur, was das Angebot wirklich blockiert und was die Messung **nicht** selbst
klären kann. Eine fehlende Gehweglänge ist keine offene Frage — die wird
gemessen. Ein widersprüchlicher Leistungsumfang schon.

Bei Stufe A ist die Liste in aller Regel leer: dort ist nichts offen, dort ist
schlicht nichts gesagt worden, und genau dafür gibt es die Messung.

## Prüfen

Nach dem Schreiben:

```
node src/cli.js validate <brief.json> --email <mail.txt>
```

Bei Fehlern den Brief korrigieren, nicht die Prüfung.
