#!/usr/bin/env python3
"""Text aus einem Aufmassblatt-PDF holen - ohne externe Bibliothek.

    python3 tools/pdf-text.py <datei.pdf>

Die Blaetter benutzen Type0-Fonts mit Identity-Encoding: im Inhaltsstrom
stehen Glyphnummern, keine Buchstaben. Uebersetzt werden sie ueber die
eingebetteten ToUnicode-CMaps. Ohne die kaeme nur Zahlensalat heraus.

Gebraucht wird der Text, weil die Beschriftungen im Kartenbild sagen, WAS
gemessen wurde ("Footpath 35 m", "Sidewalk at street") - und damit, woraus
sich die Gesamtlaenge einer Kategorie zusammensetzt.
"""

import re
import sys
import zlib
from pathlib import Path


def _streams(raw):
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", raw, re.S):
        try:
            yield zlib.decompress(m.group(1))
        except Exception:
            yield m.group(1)


def _objects(raw):
    """Alle nummerierten Objekte: Nummer -> Rohtext des Objekts."""
    out = {}
    for m in re.finditer(rb"(\d+)\s+0\s+obj\b(.*?)\bendobj", raw, re.S):
        out[int(m.group(1))] = m.group(2)
    return out


def _stream_of(obj, raw):
    m = re.search(rb"stream\r?\n(.*?)\r?\nendstream", obj, re.S)
    if not m:
        return None
    try:
        return zlib.decompress(m.group(1))
    except Exception:
        return m.group(1)


def font_cmaps(raw):
    """Je Font-Ressourcenname (F1, F4 ...) eine eigene Tabelle.

    Alle Tabellen in eine einzige zu werfen geht schief: die Blaetter betten
    mehrere Subset-Fonts ein, die dieselben Glyphnummern unterschiedlich
    belegen. Zusammengelegt kam aus "Footpath" ein "Fssxtexl" - lesbar
    verschoben, aber falsch, und bei Zahlen faellt das nicht mehr auf.
    """
    objs = _objects(raw)
    tabellen = {}
    for obj in objs.values():
        for name, ref in re.findall(rb"/(F\d+)\s+(\d+)\s+0\s+R", obj):
            font = objs.get(int(ref))
            if not font:
                continue
            tu = re.search(rb"/ToUnicode\s+(\d+)\s+0\s+R", font)
            # Type0-Fonts verweisen auf einen Nachfahren; ToUnicode haengt aber
            # am Eltern-Font, deshalb genuegt diese eine Ebene.
            if not tu:
                continue
            data = _stream_of(objs.get(int(tu.group(1)), b""), raw)
            if data:
                tabellen[name.decode()] = _parse_cmap(data)
    return tabellen


def _parse_cmap(data):
    table = {}
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", data, re.S):
        for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            table[int(src, 16)] = chr(int(dst[:4], 16))
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", data, re.S):
        for lo, hi, dst in re.findall(
            rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block
        ):
            start = int(dst[:4], 16)
            for i, code in enumerate(range(int(lo, 16), int(hi, 16) + 1)):
                table[code] = chr(start + i)
    return table


def text_runs(raw, tabellen):
    """Zusammenhaengende Textstuecke in Vorkommensreihenfolge.

    Der jeweils aktive Font wird mitgefuehrt (`/F4 20 Tf`), damit jedes
    Glyph mit der richtigen Tabelle uebersetzt wird.
    """
    runs = []
    for data in _streams(raw):
        if b" Tj" not in data:
            continue
        aktuell = []
        font = None
        for m in re.finditer(
            rb"/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\bBT\b|\bET\b", data
        ):
            if m.group(1):
                font = m.group(1).decode()
            elif m.group(2):
                tabelle = tabellen.get(font, {})
                aktuell.append(tabelle.get(int(m.group(2), 16), "?"))
            else:
                if aktuell:
                    runs.append("".join(aktuell))
                    aktuell = []
        if aktuell:
            runs.append("".join(aktuell))
    return runs


def main():
    raw = Path(sys.argv[1]).read_bytes()
    for run in text_runs(raw, font_cmaps(raw)):
        if run.strip():
            print(run)


if __name__ == "__main__":
    main()
