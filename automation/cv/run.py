#!/usr/bin/env python3
"""Luftbild-Aufmass fuer eine Adresse.

    python3 run.py --lat 51.833204 --lon 6.587885 --state Nordrhein-Westfalen \
                   [--radius 35] [--out ergebnis]

Schreibt <out>.json (Linien im Format des Aufmass-Tools) und <out>.debug.png.
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
import measure as M
import sources as S

HERE = Path(__file__).parent
REG = json.loads((HERE / ".." / "vendor" / "registries.json").read_text())


def build_anchors(frame, osm, parcel_mask):
    """Ankerflaechen, an denen die Zuordnung haengt."""
    building = frame.polygon_mask(osm["buildings"])
    # Dachkante grosszuegig: Traufe und Dachschatten laufen ueber den Grundriss
    # hinaus und wuerden sonst als Weg am Haus entlang durchgehen.
    building_wide = ndimage.binary_dilation(building, np.ones((7, 7), bool))

    street_center = frame.line_mask([s["geom"] for s in osm["streets"]], width_px=3)
    # "Strassenkante" = wo das Flurstueck der Strasse am naechsten kommt.
    # Nicht die Strassenachse selbst: die liegt ausserhalb des Flurstuecks,
    # eine Einfahrt beruehrt sie nie.
    reach = max(2, int(round(8.0 / frame.m_per_px)))
    street_edge = parcel_mask & ndimage.binary_dilation(street_center, np.ones((reach, reach), bool))
    return {"building": building_wide, "street_edge": street_edge, "street_center": street_center}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--radius", type=float, default=35.0)
    ap.add_argument("--px", type=int, default=800)
    ap.add_argument("--out", default="ergebnis")
    args = ap.parse_args()

    wms = REG["WMS_BY_STATE"].get(args.state)
    wfs = REG["WFS_BY_STATE"].get(args.state)
    if not wms:
        sys.exit(f"Kein Landes-Luftbild fuer {args.state} hinterlegt.")
    if not wfs:
        sys.exit(f"Kein Flurstueck-Dienst fuer {args.state} hinterlegt - "
                 "ohne Flurstueck ist die Abgrenzung nicht moeglich.")

    out = Path(args.out)
    bbox = S.bbox_for(args.lat, args.lon, args.radius)
    frame = M.Frame(bbox, args.px)
    print(f"Ausschnitt {2*args.radius:.0f} × {2*args.radius:.0f} m, {frame.m_per_px:.3f} m/px")

    dop_path = out.with_suffix(".dop.png")
    S.fetch_dop(wms, bbox, args.px, dop_path)
    rgb = np.asarray(Image.open(dop_path).convert("RGB"))
    print(f"Luftbild: {wms['name']}")

    osm = S.fetch_osm(bbox)
    print(f"OSM: {len(osm['buildings'])} Gebaeude, {len(osm['streets'])} Wege")

    pq = json.loads(subprocess.run(
        ["node", str(HERE / "parcel-query.js"), str(args.lat), str(args.lon),
         json.dumps(wfs), "100", "25"],
        capture_output=True, text=True, check=True).stdout)

    if not pq["containing"]:
        sys.exit("Kein Flurstueck enthaelt den Punkt - Adresse oder Dienst pruefen. "
                 "Ohne eindeutiges Flurstueck wird nicht geraten.")
    if pq["truncated"]:
        print("! Das count=5 des Tools haette dieses Flurstueck verfehlt "
              "(siehe README, 'Gefundener Fehler').")
    parcel = frame.polygon_mask(pq["containing"])
    parcel_m2 = parcel.sum() * frame.m_per_px_x * frame.m_per_px_y
    print(f"Flurstueck: {len(pq['containing'])} Ring(e), {parcel_m2:.0f} m² im Ausschnitt "
          f"(von {pq['total']} Ringen in der Antwort)")

    anchors = build_anchors(frame, osm, parcel)
    work = parcel & ~anchors["building"]
    print(f"Arbeitsflaeche (Flurstueck ohne Gebaeude): "
          f"{work.sum()*frame.m_per_px_x*frame.m_per_px_y:.0f} m²")

    paved, veg, info = M.paved_mask(rgb, work)
    paved = M.clean(paved, frame.m_per_px)

    # Plausibilitaet vor Klassifikation: lieber nichts melden als etwas
    # Falsches. Was hier durchfaellt, muss von Hand gemessen werden - das
    # steht so auch im Ergebnis, damit es niemand uebersieht.
    work_m2 = work.sum() * frame.m_per_px_x * frame.m_per_px_y
    paved_m2 = paved.sum() * frame.m_per_px_x * frame.m_per_px_y
    anteil = paved_m2 / work_m2 if work_m2 > 0 else 0.0
    unplausibel = anteil > M.MAX_BELAGSANTEIL
    print(f"Befestigt erkannt: {paved_m2:.0f} m² = {anteil*100:.0f} % der Arbeitsflaeche")
    if unplausibel:
        print(f"! Ueber {M.MAX_BELAGSANTEIL*100:.0f} % - das ist keine Wegeflaeche, sondern eine")
        print("  fehlgeschlagene Unterscheidung. Kein Ergebnis, bitte von Hand messen.")
        paved = np.zeros_like(paved)
    if info.get('guete') is not None:
        lage = 'trennbar' if info['schwelle'] else 'einheitlich - keine Flaeche gemeldet'
        print(f"Trennschaerfe: {info['guete']:.2f} ({lage})")
    labels, n = ndimage.label(paved)
    results = []
    for i in range(1, n + 1):
        comp = labels == i
        r = M.classify(comp, frame, anchors)
        if r["lengthM"] < 2.0 and r["areaM2"] < 8.0:
            continue
        r["points"] = [list(frame.to_latlon(p)) for p in r.pop("pxPath")]
        results.append(r)
    results.sort(key=lambda r: -r["areaM2"])

    print(f"\n{len(results)} Sektor(en):")
    for r in results:
        print(f"  {r['category']:11s} {r['lengthM']:6.1f} m  "
              f"Breite ~{r['widthM']:4.1f} m  Flaeche {r['areaM2']:6.1f} m²  "
              f"{'Strasse ' if r['touchesStreet'] else ''}{'Haus' if r['touchesBuilding'] else ''}")

    out.with_suffix(".json").write_text(json.dumps({
        "lat": args.lat, "lon": args.lon, "bundesland": args.state,
        "source": "luftbild-ki", "mPerPx": frame.m_per_px,
        "parcelM2": round(parcel_m2), "workM2": round(work_m2),
        "pavedShare": round(anteil, 3),
        "reliable": not unplausibel,
        "note": None if not unplausibel else
                "Belagsanteil unplausibel - Unterscheidung fehlgeschlagen, von Hand messen",
        "sectors": results,
    }, indent=2, ensure_ascii=False))

    # --- Kontrollbild ---
    dbg = Image.open(dop_path).convert("RGB")
    ov = Image.new("RGBA", dbg.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    ys, xs = np.nonzero(paved)
    for x, y in zip(xs[::3], ys[::3]):
        d.point((int(x), int(y)), fill=(255, 255, 255, 110))
    for r in pq["containing"]:
        d.line([frame.to_px(p) for p in r] + [frame.to_px(r[0])], fill=(255, 220, 0, 255), width=3)
    for g in osm["buildings"]:
        d.polygon([frame.to_px(p) for p in g], outline=(80, 140, 255, 255))
    COLORS = {"garage": (0, 194, 255), "haustuer": (255, 59, 48),
              "parkplatz": (181, 88, 246), "muelltonnen": (52, 211, 153),
              "gehweg": (255, 213, 0), "sonstiges": (255, 255, 255)}
    for r in results:
        if len(r["points"]) >= 2:
            d.line([frame.to_px(p) for p in r["points"]],
                   fill=COLORS[r["category"]] + (255,), width=5)
    Image.alpha_composite(dbg.convert("RGBA"), ov).convert("RGB").save(out.with_suffix(".debug.png"))
    print(f"\ngeschrieben: {out.with_suffix('.json')}  ·  {out.with_suffix('.debug.png')}")


if __name__ == "__main__":
    main()
