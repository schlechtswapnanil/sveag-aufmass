# How to test this

Everything below runs from `automation/`. No `npm install` — Node ≥ 20 only.
The aerial step additionally needs Python with numpy/scipy/scikit-image/Pillow.

```bash
cd /Users/neil/Documents/Cito/sveag-aufmass/automation
node cv/extract-vendor.js ../Aufmass_2026-08-21.html   # once, populates vendor/
```

That last step pulls `geo.js`, `model.js`, `parcel.js` and the WMS/WFS
registries out of the built HTML. Re-run it whenever the tool is rebuilt — if
the tool's structure changed, it fails loudly rather than working on stale
copies.

---

## 1. Does it still work at all — 30 seconds

```bash
npm test
```

Expect **52 passing, 0 failing**. This covers the tier rules, the evidence
check, the vocabulary mapping and the sheet export, against five fixtures
rebuilt from real enquiries.

---

## 2. Parse a canned enquiry — 1 minute

```bash
node src/cli.js validate samples/tier-c-flaechen.brief.json \
  --source samples/tier-c-flaechen.email.txt
```

```
✔ Brief gueltig · Stufe C (vollstaendig)
  zu messen: nichts - alle Sektoren sind belegt (nur Gegenpruefung)
```

Try the other fixtures — `tier-a`, `tier-b`, `tier-b-flurkarte`,
`tier-b-aufzaehlung`. The two `tier-b-*` ones are your own enquiries,
anonymised; both must come out **B**, not C, despite one having a plan
attached.

---

## 3. Prove the guards actually bite

This is the part worth your attention. Each of these **must fail**.

**a) An invented measurement**

```bash
python3 -c "
import json;d=json.load(open('samples/tier-b.brief.json'))
d['sectors'][0]['lengthM']=35
d['sectors'][0]['evidence']='Der Gehweg ist 35 m lang.'
json.dump(d,open('/tmp/t.json','w'))"
node src/cli.js validate /tmp/t.json --source samples/tier-b.email.txt
```
→ `Zitat "…" steht so nicht im Quelltext`

**b) A transposed house number, claimed to come from the subject line**

```bash
python3 -c "
import json;d=json.load(open('samples/tier-c-flaechen.brief.json'))
d['object']['addressRaw']='Beispielweg 38 – 87';d['object']['addressSource']='betreff'
json.dump(d,open('/tmp/t.json','w'))"
node src/cli.js validate /tmp/t.json --source samples/tier-c-flaechen.email.txt
```
→ `object.addressRaw: "…" steht so nicht im Quelltext`

**c) A brief with no address at all**

```bash
node src/cli.js prepare samples/tier-b-aufzaehlung.brief.json -o /dev/null
```
→ refuses, exit 1. It does **not** geocode an empty string. (An earlier version
did, and matched a village in France.)

If any of these three *passes*, something is broken — stop and say so.

---

## 4. Run one of your own enquiries

Paste the mail into a file. **Put the subject line at the top** — enquiries say
„für das o. g. Objekt" and mean the subject; without it the address cannot be
evidenced and the brief will (correctly) fail.

```
Betreff: <subject>
Von: <sender>
Datum: <date>
Anhänge: <filename> (<type>), …

<body>

--- Vorgänger ---
<older messages>
```

Then ask Claude: **„/aufmass-brief für work/<kunde>.source.txt"**. It follows
`prompts/parse-email.md`, writes the brief, validates, and builds the import
file. For the Gmail path just say which thread — the skill searches, fetches
and assembles the source file itself.

Check by hand:
- Is the **tier** right? C only if a plan carries dimensions, or every named
  sector has a figure.
- Are the sectors mapped sensibly, and is the **customer's own wording** in
  `label`?
- Does `openQuestions` name anything genuinely missing?

---

## 5. The round trip: brief → tool → sheet

```bash
node src/cli.js prepare work/<kunde>.brief.json \
  --source work/<kunde>.source.txt -o work/<kunde>.import.json
```

Watch for `!` warnings — a postcode mismatch usually means the wrong one of two
identically-named streets.

Then, in the tool (`Aufmass_2026-08-21.html`):

1. **Objekte → Import (JSON)** → pick `work/<kunde>.import.json`
2. Open the object. The address, Bundesland and the customer's figures should
   already be in the notes field, and those notes print on the Aufmaßblatt.
3. Measure. Then **Objekte → Export (JSON)** → save as `work/<kunde>.measured.json`

```bash
node src/cli.js sheet work/<kunde>.measured.json \
  --images work/bilder -o work/<kunde>.sheet.csv
```

`--images` fills the `Kontrollbild` column by matching each object's address
slug against `<slug>.debug.png` — the name `cv/run.py --out` writes. Those are
`file://` links: fine on this machine, useless in a shared sheet. For that,
upload the images and pass `--image-map` with `{"<address>": "<url>"}`.

In Google Sheets: **Datei → Importieren → Hochladen**, separator comma.

**The check that matters:** sum the `Kundenangabe` column. It must equal the
total the customer stated — not a multiple of it. For a Wohnanlage spanning
three streets the figure is the whole order's, so it sits on part 1 only.

`Gemessen_m` is the opposite: per part, so its sum is the measured total.

Every row lands on `zu pruefen`. Nothing sets itself to freigegeben.

---

## 6. The aerial step

```bash
python3 cv/run.py --lat 51.893162 --lon 7.191551 \
  --state Nordrhein-Westfalen --out /tmp/haus
```

Expect a driveway at roughly 18 m / 2.4 m wide, classified `garage`. Open
`/tmp/haus.debug.png` and look: does the coloured line lie on the driveway?

Then try **an address you have already measured by hand** and compare. That
comparison has not been done — until it has, the numbers are plausible, not
verified.

Only 9 Bundesländer have both services: BW, BB, HH, MV, NI, NRW, SL, SN, RP.
Elsewhere `run.py` stops instead of guessing.

---

## 7. Known-bad cases — expected to fail

These are limits, not regressions:

- **Attachments.** The Gmail connector cannot download them, so a Flurkarte
  stays `hasDimensions: false` and the enquiry stays at tier B. Correct: nobody
  has looked inside it.
- **m² vs running metres.** Customers state m², the tool measures m. Both
  columns are filled and the row says they aren't comparable. No conversion
  happens, by your decision.
- **Shared categories.** „Wohnwege" and „Kellerniedergänge" are both
  `haustuer`, so one measurement covers two rows. The second row's
  `Gemessen_m` is deliberately blank — the note says why.
- **Parcel truncation.** The tool's own `count: '5'` can pick a neighbour's
  plot in terraced housing (128 m instead of 35 m in Bocholt). Not fixable
  without the source repo — see `cv/README.md`.
