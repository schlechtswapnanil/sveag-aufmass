#!/usr/bin/env python3
"""Aufmassblaetter verorten: gezeichnete Strecken -> Koordinaten.

    python3 tools/pdf-georef.py <pdf-verzeichnis> --geom work/geom2.json -o work/georef.json

Die Blaetter enthalten die gemessenen Strecken als Vektorpfade und die Karte
als 256er-Kacheln, aber keine einzige Koordinate - kein BBOX, kein CRS, keine
Kachel-URL. Verortet wird deshalb ueber das Bild: das Kachelmosaik wird gegen
einen groesseren Ausschnitt desselben Landes-Luftbilds geschoben, bis es passt.

Warum das ueberhaupt aufgeht: die Kacheln kommen aus einer Leaflet-WMS-Ebene
und liegen damit im Web-Mercator-Kachelraster. Wird der Vergleichsausschnitt in
EPSG:3857 mit genau der Zoomstufen-Aufloesung geholt, ist nur noch eine
Verschiebung zu finden - keine Drehung, keine Skalierung. Die
Kreuzkorrelation liegt dann typisch ueber 0.95, der zweitbeste Treffer weit
darunter; das ist eindeutig genug, um sich darauf zu verlassen.

Gegenprobe: die verorteten Strecken muessen die Laengen ergeben, die auf dem
Blatt stehen. Stimmt das nicht, wird der Datensatz verworfen statt geraten.
"""

import io
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from importlib import import_module
pdf_geom = import_module("pdf-geom")
pdf_lines = import_module("pdf-lines")

R = 6378137.0
TILE = 256
# Die Zoomstufe steht nicht im Blatt und ist NICHT fuer alle gleich: das Tool
# passt die Karte per fitBounds an die gezeichneten Strecken an, ein kleines
# Grundstueck landet dadurch auf einer feineren Stufe als ein grosses. Mit
# fest angenommenem z19 schlug die Zuordnung bei 50 von 86 Blaettern fehl.
# Abgeleitet wird sie aus dem Massstab: die Beschriftung nennt die Laenge einer
# Strecke in Metern, die im PDF in Einheiten vorliegt.
MERC_UMFANG = 156543.03392804097
SUCHBILD_PX = 1400
MIN_SCORE = 0.70
MAX_LAENGEN_ABWEICHUNG = 0.15            # 15 % gegen die Beschriftung

# Farben aus CATEGORIES des Tools (src/model.js)
KATEGORIE = {
    (1.0, 0.835, 0.0): "gehweg",
    (1.0, 0.231, 0.188): "haustuer",
    (0.0, 0.761, 1.0): "garage",
    (0.71, 0.345, 0.965): "parkplatz",
    (0.204, 0.827, 0.6): "muelltonnen",
}

WMS = {
    "Sachsen": ("https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", "sn_dop_020"),
    "Nordrhein-Westfalen": ("https://www.wms.nrw.de/geobasis/wms_nw_dop", "nw_dop_rgb"),
    "Hamburg": ("https://geodienste.hamburg.de/wms_dop_zeitreihe_unbelaubt", "dop_zeitreihe_unbelaubt"),
}


def to3857(lat, lon):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def to4326(x, y):
    return math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2), math.degrees(x / R)


def geo_len(pts):
    tot = 0.0
    for a, b in zip(pts, pts[1:]):
        la = math.radians((a[0] + b[0]) / 2)
        tot += math.hypot((b[1] - a[1]) * 111320 * math.cos(la), (b[0] - a[0]) * 111320)
    return tot


def zoom_aus_massstab(paths, beschriftet, lat):
    """Zoomstufe aus dem Verhaeltnis PDF-Einheiten zu Metern.

    Gibt (zoom, meter_je_einheit) zurueck, oder (None, None), wenn sich keine
    Strecke zuordnen laesst. Genommen wird die laengste Strecke - dort wirkt
    sich die Rundung der Beschriftung auf ganze Meter am wenigsten aus.
    """
    laengen = []
    for p in paths:
        rgb = tuple(p["rgb"]) if p["rgb"] else None
        if rgb not in KATEGORIE:
            continue
        L = sum(math.dist(a, b) for a, b in zip(p["pts"], p["pts"][1:]))
        if L > 0:
            laengen.append(L)
    werte = [b["m"] for b in beschriftet] if beschriftet and isinstance(beschriftet[0], dict) else list(beschriftet)
    if not laengen or not werte:
        return None, None
    m_je_einheit = max(werte) / max(laengen)
    res_boden = m_je_einheit * 192.0 / TILE          # Meter je Kachelpixel
    if res_boden <= 0:
        return None, None
    z = math.log2(MERC_UMFANG * math.cos(math.radians(lat)) / res_boden)
    return int(round(z)), m_je_einheit


def mosaik(objs, tiles):
    """Kacheln in Seitenreihenfolge zu einem Bild zusammensetzen."""
    xs = sorted({round(t["ctm"][4], 2) for t in tiles})
    ys = sorted({round(t["ctm"][5], 2) for t in tiles}, reverse=True)  # PDF-y waechst nach oben
    img = Image.new("RGB", (len(xs) * TILE, len(ys) * TILE))
    for t in tiles:
        obj = objs[t["obj"]]
        m = re.search(rb"stream\r?\n(.*?)\r?\nendstream", obj, re.S)
        kachel = Image.open(io.BytesIO(m.group(1))).convert("RGB")
        img.paste(kachel, (xs.index(round(t["ctm"][4], 2)) * TILE,
                           ys.index(round(t["ctm"][5], 2)) * TILE))
    return img, min(xs), max(ys) + 192.0


def suchbild(lat, lon, state, cache_dir, RES):
    cache = cache_dir / f"hay_{lat:.5f}_{lon:.5f}_{RES:.4f}.png"
    if cache.exists():
        return cv2.imread(str(cache))
    if state not in WMS:
        return None
    url_base, layer = WMS[state]
    cx, cy = to3857(lat, lon)
    half = SUCHBILD_PX * RES / 2
    url = (f"{url_base}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS={layer}"
           f"&STYLES=&SRS=EPSG:3857&BBOX={cx-half},{cy-half},{cx+half},{cy+half}"
           f"&WIDTH={SUCHBILD_PX}&HEIGHT={SUCHBILD_PX}&FORMAT=image/png")
    r = subprocess.run(["curl", "-sS", "--max-time", "60", "-o", str(cache), url],
                       capture_output=True)
    if r.returncode != 0 or not cache.exists() or cache.stat().st_size < 5000:
        return None
    return cv2.imread(str(cache))


def verorte(pdf, lat, lon, state, cache_dir, beschriftet):
    objs, images, paths = pdf_geom.extract(pdf)
    tiles = [i for i in images if i["w"] == TILE and i["h"] == TILE]
    if len(tiles) < 4:
        return {"fehler": f"nur {len(tiles)} Kacheln"}

    geschaetzt, _ = zoom_aus_massstab(paths, beschriftet, lat)
    if geschaetzt is None or not (15 <= geschaetzt <= 22):
        return {"fehler": f"Zoomstufe nicht bestimmbar ({geschaetzt})"}

    mos, xmin, ytop = mosaik(objs, tiles)
    m = np.array(mos)[:, :, ::-1]
    mg = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)

    # Die geschaetzte Stufe wird gerundet und kann daneben liegen; die
    # Nachbarstufen kosten nur je einen Abruf und retten die Grenzfaelle.
    bestes = None
    for zoom in (geschaetzt, geschaetzt + 1, geschaetzt - 1):
        if not (15 <= zoom <= 22):
            continue
        RES = MERC_UMFANG / (2 ** zoom)
        hay = suchbild(lat, lon, state, cache_dir, RES)
        if hay is None or m.shape[0] >= hay.shape[0] or m.shape[1] >= hay.shape[1]:
            continue
        korr = cv2.matchTemplate(cv2.cvtColor(hay, cv2.COLOR_BGR2GRAY), mg, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(korr)
        tmp = korr.copy()
        cv2.rectangle(tmp, (loc[0] - 60, loc[1] - 60), (loc[0] + 60, loc[1] + 60), 0, -1)
        zweit = float(cv2.minMaxLoc(tmp)[1])
        if bestes is None or score > bestes[0]:
            bestes = (score, zweit, loc, zoom, RES)
    if bestes is None:
        return {"fehler": "kein Suchbild"}
    score, zweit, loc, zoom, RES = bestes
    if score < MIN_SCORE or score - zweit < 0.15:
        return {"fehler": f"Zuordnung unsicher z{zoom} (bester {score:.2f}, zweiter {zweit:.2f})"}

    cx, cy = to3857(lat, lon)
    half = SUCHBILD_PX * RES / 2
    u2px = TILE / 192.0

    def p2ll(x, y):
        X = cx - half + (loc[0] + (x - xmin) * u2px) * RES
        Y = cy + half - (loc[1] + (ytop - y) * u2px) * RES
        return to4326(X, Y)

    strecken = []
    for p in paths:
        rgb = tuple(p["rgb"]) if p["rgb"] else None
        if rgb not in KATEGORIE:
            continue
        ll = [list(p2ll(*pt)) for pt in p["pts"]]
        strecken.append({"kategorie": KATEGORIE[rgb], "laengeM": round(geo_len(ll), 1),
                         "punkte": [[round(a, 7), round(b, 7)] for a, b in ll]})
    return {"score": round(score, 4), "zweitbester": round(zweit, 4),
            "zoom": zoom, "strecken": strecken}


# Beschriftung -> Kategorie, damit sich Soll und Ist paarweise vergleichen
# lassen. Nur nach Laenge sortiert zu paaren ging schief: die Blaetter zeichnen
# neben den Messstrecken auch Marker-Stummel, wodurch ein "Front door 1 m"
# gegen eine 24-m-Linie verglichen wurde - 2370 % Scheinabweichung.
LABEL_KAT = {"Footpath": "gehweg", "Gehweg": "gehweg",
             "Front door": "haustuer", "Haustür": "haustuer",
             "Garage": "garage", "Parking": "parkplatz", "Bins": "muelltonnen"}


def beschriftet_vorab(pdf):
    try:
        return [{"kategorie": LABEL_KAT.get(s["label"], "sonstiges"), "m": s["m"]}
                for s in pdf_lines.blatt(pdf)["strecken"]]
    except Exception:
        return []


def main():
    args = sys.argv[1:]
    out, geomfile = None, None
    for flag, ziel in (("-o", "out"), ("--geom", "geom")):
        if flag in args:
            i = args.index(flag)
            val = args[i + 1]
            args = args[:i] + args[i + 2:]
            if ziel == "out":
                out = val
            else:
                geomfile = val
    verzeichnis = Path(args[0])
    cache_dir = Path("work/haystack")
    cache_dir.mkdir(parents=True, exist_ok=True)

    geom = json.loads(Path(geomfile).read_text())
    def norm(s):
        return re.sub(r"[^a-z0-9]", "", s.lower().replace("ä", "ae").replace("ö", "oe")
                      .replace("ü", "ue").replace("ß", "ss")
                      .replace("straße", "str").replace("strasse", "str").replace("str.", "str"))

    def nummer(s):
        return re.sub(r"([0-9]+)[a-z](?![0-9])", r"\1", norm(s))

    def kern(s):
        """Strasse + Hausnummer + PLZ, ohne Ort.

        Die Dateinamen der Blaetter sind uneinheitlich: mal fehlt das Komma,
        mal der Ort ("Haertelstrasse 12, 04107"), mal steht "strasse" statt
        "straße". Ueber den vollen String verglichen fielen 27 von 86 Blaettern
        durch, obwohl die Adresse bekannt war.
        """
        k = nummer(s)
        m = re.search(r"^(.*?\d+)(\d{5})", k)
        return m.group(1) + m.group(2) if m else k

    pos = {}
    for r in geom:
        if r.get("pt"):
            for schluessel in (norm(r["address"]), nummer(r["address"]), kern(r["address"])):
                pos.setdefault(schluessel, r)

    ergebnisse = []
    pdfs = sorted(verzeichnis.glob("*.pdf"))
    for i, pdf in enumerate(pdfs, 1):
        adresse = pdf.stem.strip()
        rec = pos.get(norm(adresse)) or pos.get(nummer(adresse)) or pos.get(kern(adresse))
        eintrag = {"adresse": adresse}
        if not rec:
            eintrag["fehler"] = "keine Koordinate"
        else:
            try:
                eintrag.update(verorte(pdf, rec["pt"][0], rec["pt"][1], rec["state"],
                                       cache_dir, beschriftet_vorab(pdf)))
            except Exception as e:
                eintrag["fehler"] = f"{type(e).__name__}: {e}"[:90]
        # Gegenprobe gegen die Beschriftung auf dem Blatt
        beschriftet = beschriftet_vorab(pdf)
        eintrag["beschriftet"] = beschriftet
        if eintrag.get("strecken") and beschriftet:
            # Je Kategorie vergleichen: so viele gezeichnete Strecken wie es
            # dort Beschriftungen gibt, jeweils der Groesse nach.
            paare = []
            for kat in {b["kategorie"] for b in beschriftet}:
                soll = sorted((b["m"] for b in beschriftet if b["kategorie"] == kat), reverse=True)
                ist = sorted((s["laengeM"] for s in eintrag["strecken"]
                              if s["kategorie"] == kat), reverse=True)[:len(soll)]
                paare += list(zip(soll, ist))
            # Beschriftungen sind auf ganze Meter gerundet: bei 1 m sind 0,5 m
            # Rundung schon 50 %. Deshalb absolute Toleranz daneben.
            schlimmste = max((max(0.0, abs(g - s) - 0.6) / s for s, g in paare if s > 0), default=1.0)
            eintrag["laengenAbweichung"] = round(schlimmste, 3)
            eintrag["geprueft"] = bool(paare) and schlimmste <= MAX_LAENGEN_ABWEICHUNG
        sys.stderr.write(f"\r  {i}/{len(pdfs)}  {adresse[:40]:42s}")
        ergebnisse.append(eintrag)
        if out and i % 5 == 0:
            Path(out).write_text(json.dumps(ergebnisse, ensure_ascii=False))
    sys.stderr.write("\n")
    ok = [e for e in ergebnisse if e.get("geprueft")]
    print(f"{len(ok)} von {len(pdfs)} verortet und gegen die Beschriftung geprueft", file=sys.stderr)
    if out:
        Path(out).write_text(json.dumps(ergebnisse, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
