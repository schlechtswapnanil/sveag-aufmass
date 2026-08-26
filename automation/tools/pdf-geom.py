#!/usr/bin/env python3
"""Kartenkacheln und gezeichnete Linien aus einem Aufmassblatt holen.

    python3 tools/pdf-geom.py <datei.pdf> -o work/geo/<name>

Die Blaetter zeichnen die gemessenen Strecken als Vektorpfade, nicht als Bild.
Wer sie herausholt und verortet, bekommt die tatsaechlich gemessene Geometrie -
nicht nur die Laenge aus der Tabelle. Das ist die einzige Wahrheit ueber den
Verlauf, die es ausserhalb des Tools gibt.

Der Inhalt steckt verschachtelt in Form-XObjects. Deshalb wird der Baum mit
einem Matrizen-Stapel durchlaufen (q/Q/cm), damit Kacheln und Pfade am Ende in
denselben Seitenkoordinaten liegen.
"""

import json
import re
import sys
import zlib
from pathlib import Path


def objects(raw):
    out = {}
    for m in re.finditer(rb"(\d+)\s+0\s+obj\b(.*?)\bendobj", raw, re.S):
        out[int(m.group(1))] = m.group(2)
    return out


def stream_of(obj):
    m = re.search(rb"stream\r?\n(.*?)\r?\nendstream", obj, re.S)
    if not m:
        return None
    data = m.group(1)
    if b"FlateDecode" in obj[: m.start()]:
        try:
            return zlib.decompress(data)
        except Exception:
            return None
    return data


def xobject_map(obj, objs):
    """Name -> Objektnummer, aus dem /XObject-Woerterbuch der Ressourcen."""
    out = {}
    # /Resources kann direkt stehen oder auf ein Objekt verweisen
    res = obj
    m = re.search(rb"/Resources\s+(\d+)\s+0\s+R", obj)
    if m:
        res = objs.get(int(m.group(1)), obj)
    m = re.search(rb"/XObject\s*<<(.*?)>>", res, re.S)
    if not m:
        m2 = re.search(rb"/XObject\s+(\d+)\s+0\s+R", res)
        if not m2:
            return out
        inner = objs.get(int(m2.group(1)), b"")
        m = re.search(rb"<<(.*?)>>", inner, re.S)
        if not m:
            return out
    for name, num in re.findall(rb"/(\w+)\s+(\d+)\s+0\s+R", m.group(1)):
        out[name.decode()] = int(num)
    return out


def mul(a, b):
    """PDF-Matrizen [a b c d e f], a danach b."""
    return [
        a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
    ]


def apply(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


NUM = r"-?[\d.]+"
TOKEN = re.compile(
    rb"(?P<nums>(?:-?[\d.]+\s+){6})cm"
    rb"|(?P<q>\bq\b)|(?P<Q>\bQ\b)"
    rb"|/(?P<xo>\w+)\s+Do"
    rb"|(?P<mx>-?[\d.]+)\s+(?P<my>-?[\d.]+)\s+m\b"
    rb"|(?P<lx>-?[\d.]+)\s+(?P<ly>-?[\d.]+)\s+l\b"
    rb"|(?P<rgb>(?:-?[\d.]+\s+){3})RG"
    rb"|(?P<w>-?[\d.]+)\s+w\b"
    rb"|(?P<S>\bS\b)"
)


def walk(data, objs, xmap, ctm, images, paths, depth=0):
    if data is None or depth > 6:
        return
    stack = []
    cur = list(ctm)
    farbe = None
    breite = None
    pfad = []
    for t in TOKEN.finditer(data):
        if t.group("nums"):
            vals = [float(v) for v in t.group("nums").split()]
            cur = mul(vals, cur)
        elif t.group("q"):
            stack.append((list(cur), farbe, breite))
        elif t.group("Q"):
            if stack:
                cur, farbe, breite = stack.pop()
                cur = list(cur)
        elif t.group("xo"):
            num = xmap.get(t.group("xo").decode())
            if num is None:
                continue
            obj = objs.get(num, b"")
            if re.search(rb"/Subtype\s*/Image", obj):
                w = re.search(rb"/Width\s+(\d+)", obj)
                h = re.search(rb"/Height\s+(\d+)", obj)
                images.append({"obj": num, "ctm": list(cur),
                               "w": int(w.group(1)) if w else 0,
                               "h": int(h.group(1)) if h else 0})
            else:
                walk(stream_of(obj), objs, xobject_map(obj, objs) or xmap,
                     list(cur), images, paths, depth + 1)
        elif t.group("rgb"):
            farbe = tuple(round(float(v), 3) for v in t.group("rgb").split())
        elif t.group("w"):
            breite = float(t.group("w"))
        elif t.group("mx"):
            if len(pfad) >= 2:
                paths.append({"pts": pfad, "rgb": farbe, "w": breite})
            pfad = [apply(cur, float(t.group("mx")), float(t.group("my")))]
        elif t.group("lx"):
            if pfad:
                pfad.append(apply(cur, float(t.group("lx")), float(t.group("ly"))))
        elif t.group("S"):
            if len(pfad) >= 2:
                paths.append({"pts": pfad, "rgb": farbe, "w": breite})
            pfad = []
    if len(pfad) >= 2:
        paths.append({"pts": pfad, "rgb": farbe, "w": breite})


def page_object(objs):
    """Das /Type /Page-Objekt. Dort haengen /Resources und /Contents.

    Die Ressourcen stehen NICHT im Inhaltsstrom-Objekt - wer sie dort sucht,
    findet kein einziges XObject und damit keine Kartenkachel.
    """
    for num, obj in objs.items():
        if re.search(rb"/Type\s*/Page[^s]", obj) and b"/Contents" in obj:
            return num, obj
    return None, None


def extract(path):
    raw = Path(path).read_bytes()
    objs = objects(raw)
    _, page = page_object(objs)
    if page is None:
        raise SystemExit("keine Seite gefunden")
    m = re.search(rb"/Contents\s+(\d+)\s+0\s+R", page)
    inhalt = stream_of(objs.get(int(m.group(1)), b"")) if m else None
    if inhalt is None:
        raise SystemExit("kein Seiteninhalt")
    images, paths = [], []
    walk(inhalt, objs, xobject_map(page, objs), [1, 0, 0, 1, 0, 0], images, paths)
    return objs, images, paths


def main():
    args = sys.argv[1:]
    out = None
    if "-o" in args:
        i = args.index("-o"); out = args[i + 1]; args = args[:i] + args[i + 2:]
    objs, images, paths = extract(args[0])
    kacheln = [i for i in images if i["w"] == 256 and i["h"] == 256]
    print(f"{len(kacheln)} Kacheln, {len(images)} Bilder, {len(paths)} Pfade", file=sys.stderr)
    farben = {}
    for p in paths:
        farben[p["rgb"]] = farben.get(p["rgb"], 0) + 1
    for c, n in sorted(farben.items(), key=lambda x: -x[1])[:8]:
        print(f"   Farbe {c}: {n} Pfad(e)", file=sys.stderr)
    if out:
        Path(out).write_text(json.dumps({"tiles": kacheln, "paths": paths}, indent=1))
        print(f"-> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
