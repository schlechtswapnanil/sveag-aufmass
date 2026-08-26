# SVEAG Aufmaß — Winterdienst-Automatisierung

Turns a customer's snow-clearing enquiry into a measured, quote-ready sheet.

```
E-Mail  →  geprüfter Brief  →  Objekt im Aufmaß-Tool  →  Messung  →  CSV fürs Sheet
           automation/          Aufmass_*.html                       automation/
```

**Start here: [`automation/TESTING.md`](automation/TESTING.md)** — how to run it,
and the cases that must fail.

---

## Current performance

Measured 26 Aug 2026 against SVEAG's own hand measurements: 86 Aufmaßblätter
plus the measured Leipzig object list (85 usable rows). 87 automated tests pass.

### Gehweg — the position in nearly every enquiry

Derived from the cadastral parcel and the OSM building outline, not from
imagery. Scored against the hand measurements:

| Case | Objects | Median error | within ±20 % |
|---|---:|---:|---:|
| Gehweg is **one run at the street** | 48 | **1,0 m** (7 %) | **77 %** |
| Gehweg is **several segments** | 5 | 36,0 m (61 %) | 0 % |
| combined | 53 | 1,0 m (8 %) | 70 % |

**91 % of scored objects (48 of 53) are the first kind**, and there the estimate
is good — about a metre out on a 19 m median.

The second kind is a private access path crossing the plot, cleared in addition
to the pavement. Nikischstraße 6: `Footpath 14 m` at the street plus
`Footpath 35 m` across the property; the model returns 13,2 m. That path lies on
neither a parcel nor a building edge, so vector data cannot reach it — and it is
**not detectable in advance**: building setback from the street does not separate
the two groups (median 10,9 m vs 12,8 m, every threshold yields more false alarms
than catches).

**The model can flag its own weak cases — partly.** Where the cadastral parcel
and the OSM building outline disagree by more than a factor of two, accuracy
drops sharply, and that is visible *before* comparing to anything:

| Kataster vs Gebäude | Objects | within ±20 % |
|---|---:|---:|
| agree within 2× | 55 (80 %) | **69 %** |
| disagree 2–5× | 9 | 44 % |
| disagree >5× | 5 | 40 % |

Those rows carry `Vorschlag wenig verlaesslich` in the sheet. Taking the smaller
value stays right even there — with the larger one, the median error at >5×
disagreement is 1340 %.

Tuning helped: `extractFrontage()`'s three parameters went from the tool's
`{15, 30, 3}` to `{10, 50, 8}`, fitted by grid search on one half of the data and
scored on the other — median error 4,5 m → **1,9 m** on the held-out half. Refitting
on single-run objects only returns the same three values, so the fit is stable.

The tighter fit costs coverage: **16 of 85 objects get no proposal** instead of 1.
Deliberate — a blank is honest, a wrong number is not.

### Scored as geometry, not just as length

Length agreement flatters the model: at Daumierstraße 20 the figure is 4 % out
while the line sits on the **building facade**, metres from the pavement. With
the sheets georeferenced, prediction and hand measurement can be compared as
*geometry* — how much of the measured path the prediction covers (recall), and
how much of the prediction lies on it (precision), over 35 objects:

| tolerance | recall | precision | F1 |
|---|---:|---:|---:|
| 4 m | 61 % | **80 %** | 69 % |
| 8 m | 71 % | **88 %** | 78 % |
| 12 m | 75 % | 89 % | 81 % |

**Precision is the good news**: when the model draws a line, it is almost always
on pavement that really gets cleared. The weakness is recall — it *under-covers*
rather than inventing. For Freigabe that is the easier failure: add what is
missing, rather than check whether any of it is real.

The 4 m figures were 50 % / 67 % until a systematic offset was corrected. The
frontage lies on the parcel or building edge; the cleared pavement lies a few
metres further out. Shifting the line toward the street — never past the street
axis — was fitted on half the objects and scored on the other half:
**F1 51 % → 63 %**, recall 46 → 58 %, precision 57 → 69 %. Length changes by
2,6 %, so the sheet figures are untouched; this moves the line, it does not
lengthen it.

### A second portfolio: Potsdam

A separate list of 97 Potsdam objects (25 with stated dimensions) is a genuine
out-of-sample test — different city, different state, different convention. The
model **does not transfer**:

| | Median deviation | ±20 % | ±50 % |
|---|---:|---:|---:|
| one address per row (as before) | 91 % | 1/25 | 9/25 |
| **address ranges expanded and summed** | **64 %** | 2/25 | 10/25 |

Expanding the ranges is a real gain — `Hans-Sachs-Straße 3 – 55` is 27 houses,
and treating it as one moved the estimate from 30 m to 908 m against a stated
1800 m. `tools/expand-range.py` resolves the German conventions: a range runs
along one side of the street, so `26 – 38` means 26, 28 … 38; mixed parity
(`5 – 8`) counts in ones; `14 a – c` expands the letters. Neighbouring houses
often share a parcel, so identical frontage lines are counted once.

But 64 % is still unusable, and the reasons are structural rather than tunable:

* **Potsdam prices estates, Leipzig priced properties.** 21 of 25 rows are
  ranges covering up to 27 buildings.
* **The figures combine categories** — *"Gehweg und Zugang Grundstück
  1,5 m × 130 m"* is pavement *and* access path in one number, and the access
  path is precisely the quarter that lies on no vector edge.
* **The confidence flag does not carry over.** On this list the rows marked
  `hoch` are *worse* (125 % median) than those marked `niedrig` (91 %). It was
  calibrated on Leipzig.

### Everything else

| Step | State |
|---|---|
| E-Mail → brief | **works.** Real enquiries incl. Excel attachments and a 95-object portfolio |
| Geocoding | **85 of 95** addresses (Photon alone reached 54). The other 10 are typos and collective names in the customer's own list |
| Gehweg | **works for 91 % of objects**, see above |
| Haustür | not measured — and needn't be: **63 of 85** hand measurements are exactly 1 m, i.e. a convention |
| Containerplätze, Zuwegungen, Parkplatz | **not measured.** Nothing automated sees them yet |
| Luftbild (aerial step) | **works on detached houses, not on apartment blocks.** Of 6 objects: 1 clean (Coesfeld, 44 m² driveway), 1 partly usable, 3 nothing usable, 1 rejected outright |
| Sheet | **works.** 255 rows / 85 objects, appends without duplicating, never overwrites a human edit |

Of those 255 rows, **69 carry a measurement** and 186 read `nicht gemessen`.
That is the honest state, not a failure: everything stays `zu pruefen` and
nothing sets itself to `freigegeben`.

**What it saves today:** reading the mail, finding and geocoding the address,
creating the object, and measuring the pavement on 9 of 10 properties.
**What it does not:** access paths, bin areas and parking. Those still need a
person — and the control-image link in each row is what tells them which rows
to look at.

---

## What would make it better

Ranked by effect:

1. ~~More sheets, then aim an image model at the access paths.~~ **Tested and
   rejected.** With the sheets georeferenced, the image features could be checked
   against real labels — 219 640 pixels on the cleared path against 4,4 million
   beside it. The distributions are indistinguishable (separability 0,23–0,28 at
   every distance band). The cleared pavement looks like everything around it,
   *because* everything around it is also paved. Which strip must be cleared is a
   question of Anliegerpflicht — ownership, not appearance. See
   [`automation/cv/README.md`](automation/cv/README.md).

2. **Fix `count: '5'` in the source repo.** The tool's parcel query truncates, so
   it can silently measure a *neighbour's* frontage. Measured at scale: **28 of 76**
   Leipzig addresses (37 %) — the containing parcel was not among the first five.
   The fix is two lines; it needs the `src/` repo, which is not in this folder.

3. **A geocoder that is not a free public instance.** Photon blocks after ~55
   addresses. The Nominatim fallback carried this portfolio, but an unattended
   scraper feeding lists continuously needs a paid key or a self-hosted Photon.

4. **Control images on Drive.** Links work locally (`file://`) but not in a
   shared sheet. `--image-map` is ready for real URLs; the Gmail connector cannot
   upload, so the images need to reach Drive another way.

5. **Widths, if m² is ever wanted.** Customers quote m², the tool measures running
   metres, and by decision no conversion happens anywhere — both figures sit side
   by side and the row says they are not comparable.

---

## Layout

| | |
|---|---|
| [`Aufmass_2026-08-21.html`](Aufmass_2026-08-21.html) | the measuring tool — a **build artifact**, ~1.8 MB, inlining Leaflet plus `src/geo.js`, `src/model.js`, `src/parcel.js` … The source repo is not here; edits to this file are lost on the next build. |
| [`automation/`](automation/README.md) | email → brief → tool → sheet. Zero dependencies, Node ≥ 20. |
| [`automation/cv/`](automation/cv/README.md) | the aerial step, and what it can and cannot do. |
| [`.claude/skills/aufmass-brief/`](.claude/skills/aufmass-brief/SKILL.md) | the skill that does the Gmail → brief run. |
| [`aufmass/`](aufmass/) | a Chrome MV3 wrapper. **It will not run** — the HTML is 14 inline `<script>` blocks and MV3's CSP blocks all of them. |

The detailed docs are in German, matching the tool and the customer
correspondence; this page is the exception.

## Not in this repository

`automation/work/` — real enquiries carry names, addresses and phone numbers.
Attachments (`*.xlsx`, `*.csv`, `*.zip`, `*.pdf`) are excluded for the same reason.
The fixtures under `automation/samples/` are anonymised rebuilds of the same
mails, and that is what the tests run against.

`automation/vendor/` — extracted from the tool on demand:

```bash
cd automation && node cv/extract-vendor.js ../Aufmass_2026-08-21.html
```
