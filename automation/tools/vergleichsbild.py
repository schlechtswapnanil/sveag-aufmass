#!/usr/bin/env python3
"""Vorhersage und Handmessung nebeneinander auf dem Luftbild.

    python3 tools/vergleichsbild.py "Daumierstraße 20" -o /tmp/v.png

Gelb  = tatsaechlich gemessener Gehweg (aus dem verorteten Aufmassblatt)
Cyan  = Vorhersage des Modells
Weiss = Flurstueck    Blau = OSM-Gebaeude    Rot = Geocoder-Punkt

Zahlen allein sagen nicht, WARUM eine Vorhersage danebenliegt. Das Bild schon.
"""

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

R = 6378137.0
to3857 = lambda lat, lon: (R * math.radians(lon),
                           R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def norm(s):
    import re
    return re.sub(r"[^a-z0-9]", "", s.lower().replace("ä", "ae").replace("ö", "oe")
                  .replace("ü", "ue").replace("ß", "ss")
                  .replace("straße", "str").replace("strasse", "str").replace("str.", "str"))


def main():
    args = sys.argv[1:]
    out = args[args.index("-o") + 1] if "-o" in args else "/tmp/vergleich.png"
    ziel = norm(args[0])

    georef = json.loads(Path("work/georef.json").read_text())
    geom = json.loads(Path("work/geom2.json").read_text())
    g = next((x for x in georef if x.get("geprueft") and ziel in norm(x["adresse"])), None)
    rec = next((r for r in geom if ziel in norm(r["address"])), None)
    if not g or not rec:
        sys.exit(f"nicht gefunden: {args[0]}")

    wege = [s for s in g["strecken"] if s["kategorie"] == "gehweg"]
    alle = [p for s in wege for p in s["punkte"]] + [rec["pt"]]
    mlat = sum(p[0] for p in alle) / len(alle)
    mlon = sum(p[1] for p in alle) / len(alle)

    # Frischer Ausschnitt, gross genug fuer Flurstueck und beide Linien
    RES = 156543.03392804097 / (2 ** 20)
    N = 900
    cx, cy = to3857(mlat, mlon)
    half = N * RES / 2
    WMS = {"Sachsen": ("https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", "sn_dop_020")}
    url_base, layer = WMS.get(rec["state"], WMS["Sachsen"])
    url = (f"{url_base}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS={layer}&STYLES="
           f"&SRS=EPSG:3857&BBOX={cx-half},{cy-half},{cx+half},{cy+half}"
           f"&WIDTH={N}&HEIGHT={N}&FORMAT=image/png")
    tmp = "/tmp/_vgl.png"
    subprocess.run(["curl", "-sS", "--max-time", "60", "-o", tmp, url], check=True)
    im = Image.open(tmp).convert("RGB")

    def px(p):
        x, y = to3857(p[0], p[1])
        return ((x - (cx - half)) / RES, ((cy + half) - y) / RES)

    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for ring in (rec.get("parcel") or []):
        d.line([px(p) for p in ring] + [px(ring[0])], fill=(255, 255, 255, 230), width=2)
    if rec.get("building"):
        b = rec["building"]
        d.line([px(p) for p in b] + [px(b[0])], fill=(90, 150, 255, 230), width=2)

    sys.path.insert(0, "src")
    vorh = subprocess.run(["node", "-e", f"""
const {{predictGehweg}}=require('./src/frontage.js');
const fs=require('node:fs');
const geom=JSON.parse(fs.readFileSync('work/geom2.json','utf8'));
const r=geom.find(x=>x.address.toLowerCase().includes({json.dumps(args[0].split()[0].lower())}));
const p=predictGehweg({{parcelRings:r.parcel,buildingRing:r.building,streets:r.streets}});
console.log(JSON.stringify(p? p.chains.map(c=>c.points):[]));
"""], capture_output=True, text=True).stdout
    for chain in json.loads(vorh or "[]"):
        d.line([px(p) for p in chain], fill=(0, 220, 255, 255), width=7)
    for s in wege:
        d.line([px(p) for p in s["punkte"]], fill=(255, 213, 0, 255), width=5)
    x, y = px(rec["pt"])
    d.ellipse([x - 7, y - 7, x + 7, y + 7], fill=(255, 40, 40, 255), outline=(255, 255, 255, 255))

    Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB").save(out)
    soll = sum(s["laengeM"] for s in wege)
    print(f"{g['adresse']}: gemessen {soll:.0f} m -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
