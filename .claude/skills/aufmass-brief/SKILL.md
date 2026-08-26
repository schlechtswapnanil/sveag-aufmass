---
name: aufmass-brief
description: Holt eine Winterdienst-Anfrage aus Gmail (oder nimmt eingefügten Text), macht daraus einen geprüften Aufmaß-Brief und eine Importdatei für das Aufmaß-Tool. Nutzen, wenn eine Kundenanfrage für ein Aufmaß vorbereitet werden soll.
---

# Aufmaß-Brief aus einer Kundenanfrage

Erzeugt aus einer Anfrage eine JSON-Datei, die im Aufmaß-Tool unter
**Objekte → Import (JSON)** geladen wird — mit Adresse, Bundesland,
Kundenangaben in der Notiz und der Liste der noch zu messenden Sektoren.

Arbeitsverzeichnis: `automation/work/` (nicht versioniert, enthält Kundendaten).

## 1. Quelltext beschaffen — vollständig

Aus Gmail:

```
search_threads  query: "Winterdienst" OR "Angebot" …    → Thread finden
get_thread      threadId, messageFormat: PLAIN_TEXT     → Volltext holen
```

Schreibe daraus **eine** Datei `work/<kunde>.source.txt` mit, in dieser
Reihenfolge:

```
Betreff: <subject>
Von: <sender>
Datum: <date>
Anhänge: <filename> (<mimeType>), …

<plaintextBody der aktuellen Nachricht>

--- Vorgänger ---
<plaintextBody der älteren Nachrichten des Threads>
```

**Der Betreff muss mit hinein.** Anfragen von Hausverwaltungen schreiben „für
das o. g. Objekt" und meinen den Betreff. Steht er nicht im Quelltext, lässt
sich die Adresse später nicht belegen und der Brief fällt durch die Prüfung —
das ist Absicht, nicht ein Fehler, den man umgehen sollte.

Anhänge kann der Gmail-Connector **nicht** herunterladen. Notiere sie nur mit
Namen und Typ; ob ein Plan Maße trägt, ist von außen nicht erkennbar, also
`hasDimensions: false`, solange niemand hineingesehen hat.

## 2. Brief extrahieren

`automation/prompts/parse-email.md` vollständig lesen und befolgen. Ergebnis
nach `work/<kunde>.brief.json`.

Die Regeln dort sind nicht optional. Vor allem: keine Zahl, keine Adresse und
keinen Sektor ergänzen, der nicht im Quelltext steht. Für die Zuordnung der
Kundenbegriffe auf die fünf Tool-Kategorien gilt `src/vocabulary.js`; der
Originalbegriff bleibt im `label`.

## 3. Prüfen

```
cd automation
node src/cli.js validate work/<kunde>.brief.json --source work/<kunde>.source.txt
```

Bei Fehlern den **Brief** korrigieren, nie die Prüfung oder den Quelltext. Ein
durchgefallenes `evidence`-Zitat heißt fast immer: die Angabe stand so nicht da.

## 4. Importdatei bauen

```
node src/cli.js prepare work/<kunde>.brief.json --source work/<kunde>.source.txt \
  -o work/<kunde>.import.json
```

Bei mehreren Adressen entsteht ein Objekt je Adresse. Warnungen (`!`)
weitergeben statt schlucken — eine PLZ-Abweichung bedeutet meist die falsche
von zwei gleichnamigen Straßen.

## 5. Zurückmelden

Stufe (A/B/C), geocodierte Adresse(n) mit Bundesland, die zu messenden
Sektoren, alle Warnungen und die offenen Fragen an den Kunden.

## Was diese Skill nicht tut

Sie misst nichts und sie antwortet dem Kunden nicht. Sie legt das Objekt an und
sagt, was noch zu messen ist. Gemessen wird im Aufmaß-Tool — dort greifen
Flurstück-Vorschlag (Gehweg) und die manuelle Erfassung der übrigen Sektoren;
der Luftbild-Schritt in `automation/cv/` liefert Einfahrt und Zuwegung.
