# SVEAG Aufmaß — Winterdienst-Automatisierung

Turns a customer's snow-clearing enquiry into a measured quote-ready sheet.

```
E-Mail  →  geprüfter Brief  →  Objekt im Aufmaß-Tool  →  Messung  →  CSV fürs Sheet
           automation/          Aufmass_*.html                       automation/
```

**Start here: [`automation/TESTING.md`](automation/TESTING.md)** — how to run it,
and the cases that must fail.

| | |
|---|---|
| [`Aufmass_2026-08-21.html`](Aufmass_2026-08-21.html) | the measuring tool — a **build artifact**, ~1.8 MB, inlining Leaflet plus `src/geo.js`, `src/model.js`, `src/parcel.js` … The source repo is not here; edits to this file are lost on the next build. |
| [`automation/`](automation/README.md) | email → brief → tool → sheet. Zero dependencies, Node ≥ 20. |
| [`automation/cv/`](automation/cv/README.md) | the aerial step: driveways and door paths from the state orthophoto, bounded by cadastre and OSM buildings. |
| [`.claude/skills/aufmass-brief/`](.claude/skills/aufmass-brief/SKILL.md) | the skill that does the Gmail → brief run. |
| [`aufmass/`](aufmass/) | a Chrome MV3 wrapper. **It will not run** — the HTML is 14 inline `<script>` blocks and MV3's CSP blocks all of them. |

The detailed docs are in German, matching the tool and the customer
correspondence; this page is the exception.

## Two things to know before touching it

**A parcel bug inflates the one thing already automated.** The tool queries the
cadastre with `count: '5'`; in terraced housing the containing plot can fall
outside those five, and it then measures the neighbours' frontage silently —
128 m instead of 35 m at one tested address, 2 of 5 affected. Needs the source
repo. See [`automation/cv/README.md`](automation/cv/README.md).

**Customers quote m², the tool measures running metres.** No conversion happens
anywhere: both figures sit side by side in the sheet and the row says they are
not comparable. That is a deliberate decision, not an oversight.

## Not in this repository

`automation/work/` — real enquiries carry names, addresses and phone numbers,
and stay out of version control. The fixtures under `automation/samples/` are
anonymised rebuilds of the same mails, which is what the tests run against.

`automation/vendor/` — extracted from the tool on demand:

```bash
cd automation && node cv/extract-vendor.js ../Aufmass_2026-08-21.html
```
