#!/usr/bin/env python3
"""Bildmerkmale entlang der tatsaechlich geraeumten Wege sammeln.

    python3 tools/sample-labels.py -o work/labels.npz

Bisher sind die Schwellen in cv/measure.py geraten - an einer Handvoll Bilder
abgelesen. Mit den verorteten Aufmassblaettern gibt es zum ersten Mal echte
Beschriftungen: 94 Strecken, 1389 m, von Hand gemessen und auf 0,0 % genau
verortet.

Gesammelt wird je Bildpunkt derselbe Merkmalssatz, den paved_mask() benutzt -
normierte Helligkeit, Saettigung, Textur, Vegetationsindex - einmal AUF dem
geraeumten Weg und einmal daneben. Erst der Vergleich sagt, ob die Merkmale
ueberhaupt trennen und wo die Schwelle liegen muesste.
"""

import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

R = 6378137.0
HALB_PX = 1400
GEHWEG_BREITE_M = 1.5   # Regelbreite; Kern des Weges = halbe Breite


def to3857(lat, lon):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def merkmale(rgb):
    """Dieselben vier Groessen wie paved_mask() in cv/measure.py."""
    a = rgb.astype(np.float32)
    Rk, G, B = a[..., 0], a[..., 1], a[..., 2]
    V = a.max(2)
    S = np.where(V > 0, (V - a.min(2)) / np.maximum(V, 1.0), 0.0)
    illum = ndimage.gaussian_filter(V, sigma=25)
    Vn = V / np.maximum(illum, 1.0)
    grau = a.mean(2)
    mu = ndimage.uniform_filter(grau, 9)
    textur = np.sqrt(np.maximum(ndimage.uniform_filter(grau ** 2, 9) - mu ** 2, 0))
    exg = (2 * G - Rk - B) / np.maximum(illum, 1.0) * 128.0
    return np.stack([Vn, S, textur, exg], axis=-1)


def main():
    args = sys.argv[1:]
    out = args[args.index("-o") + 1] if "-o" in args else None
    georef = json.loads(Path("work/georef.json").read_text())
    cache = Path("work/haystack")

    auf, daneben = [], []
    objekte = 0
    for g in georef:
        if not g.get("geprueft"):
            continue
        wege = [s for s in g["strecken"] if s["kategorie"] == "gehweg"]
        if not wege:
            continue
        # Passendes Suchbild ueber die Zoom-Aufloesung finden
        res = 156543.03392804097 / (2 ** g["zoom"])
        treffer = [p for p in cache.glob("hay_*.png") if abs(float(p.stem.split("_")[3]) - res) < 1e-4]
        if not treffer:
            continue
        # Mittelpunkt der Strecken bestimmt, welches Bild passt
        alle = [p for s in wege for p in s["punkte"]]
        mlat = sum(p[0] for p in alle) / len(alle)
        mlon = sum(p[1] for p in alle) / len(alle)
        bild = min(treffer, key=lambda p: (float(p.stem.split("_")[1]) - mlat) ** 2
                                          + (float(p.stem.split("_")[2]) - mlon) ** 2)
        clat, clon = float(bild.stem.split("_")[1]), float(bild.stem.split("_")[2])
        if abs(clat - mlat) > 0.003 or abs(clon - mlon) > 0.005:
            continue

        im = np.asarray(Image.open(bild).convert("RGB"))
        F = merkmale(im)
        cx, cy = to3857(clat, clon)
        half = HALB_PX * res / 2

        def px(lat, lon):
            x, y = to3857(lat, lon)
            return int(round((x - (cx - half)) / res)), int(round(((cy + half) - y) / res))

        maske = np.zeros(im.shape[:2], bool)
        for s in wege:
            pts = [px(*p) for p in s["punkte"]]
            for a, b in zip(pts, pts[1:]):
                n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1])))
                for k in range(n + 1):
                    t = k / n
                    xx, yy = int(a[0] + (b[0] - a[0]) * t), int(a[1] + (b[1] - a[1]) * t)
                    if 0 <= yy < maske.shape[0] and 0 <= xx < maske.shape[1]:
                        maske[yy, xx] = True
        if not maske.any():
            continue
        kern = ndimage.binary_dilation(maske, iterations=max(1, int(GEHWEG_BREITE_M / 2 / res)))
        # Negativ: Umgebung des Weges, aber mit Abstand - so wird gegen das
        # verglichen, was direkt daneben liegt, nicht gegen ein Dach am Bildrand.
        nah = ndimage.binary_dilation(maske, iterations=int(12 / res))
        fern = ndimage.binary_dilation(maske, iterations=int(3 / res))
        neg = nah & ~fern

        auf.append(F[kern])
        daneben.append(F[neg])
        objekte += 1

    A = np.concatenate(auf)
    D = np.concatenate(daneben)
    print(f"{objekte} Objekte | {len(A)} Punkte auf dem Weg, {len(D)} daneben", file=sys.stderr)
    namen = ["Helligkeit_norm", "Saettigung", "Textur", "ExG"]
    print(f"\n{'Merkmal':18s}{'auf dem Weg':>26s}{'daneben':>26s}", file=sys.stderr)
    print(f"{'':18s}{'p10':>8s}{'Median':>9s}{'p90':>9s}{'p10':>8s}{'Median':>9s}{'p90':>9s}", file=sys.stderr)
    for i, n in enumerate(namen):
        a, d = A[:, i], D[:, i]
        print(f"{n:18s}{np.percentile(a,10):8.2f}{np.median(a):9.2f}{np.percentile(a,90):9.2f}"
              f"{np.percentile(d,10):8.2f}{np.median(d):9.2f}{np.percentile(d,90):9.2f}", file=sys.stderr)
    if out:
        np.savez_compressed(out, auf=A, daneben=D)
        print(f"\n-> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
