#!/usr/bin/env python3
"""Excel-Anhang in Quelltext umwandeln.

    python3 tools/xlsx-to-text.py "Objektliste.xlsx" >> work/kunde.source.txt

Objektlisten kommen als Tabelle. Damit die Beleg-Pruefung greift, muss der
Quelltext die Zeilen so enthalten, wie der Brief sie spaeter zitiert - also
"Strasse 1, 04155 Leipzig, Stadtteil" und nicht mit Pipes oder Tabulatoren
getrennt. normalizeAddress() in src/brief.js entfernt Punkt, Komma, Semikolon,
Schraegstrich und Bindestrich; alles andere bleibt stehen und wuerde den
Vergleich scheitern lassen.

Kein openpyxl noetig - xlsx ist ein ZIP mit XML darin.
"""

import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
M = "{%s}" % NS


def _text_of(node):
    return "".join(t.text or "" for t in node.iter(M + "t"))


def _col(ref):
    return re.match(r"[A-Z]+", ref).group()


def _col_index(col):
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch) - 64)
    return n


def sheet_rows(path):
    """Alle Blaetter als (name, [[zelle, …], …]). Leerzeilen fallen weg."""
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        shared = [_text_of(si) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(M + "si")]

    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target")
            for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}

    out = []
    for sheet in wb.find(M + "sheets"):
        target = rels.get(sheet.get("{%s}id" % REL), "")
        name = "xl/" + target.lstrip("/")
        if name not in z.namelist():
            continue
        rows = []
        for row in ET.fromstring(z.read(name)).iter(M + "row"):
            cells = {}
            for c in row.iter(M + "c"):
                v, is_ = c.find(M + "v"), c.find(M + "is")
                if c.get("t") == "s" and v is not None:
                    val = shared[int(v.text)]
                elif is_ is not None:
                    val = _text_of(is_)
                elif v is not None:
                    val = v.text
                else:
                    continue
                if val and val.strip():
                    cells[_col_index(_col(c.get("r")))] = val.strip()
            if cells:
                rows.append([cells.get(i, "") for i in range(1, max(cells) + 1)])
        if rows:
            out.append((sheet.get("name"), rows))
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit("Aufruf: xlsx-to-text.py <datei.xlsx>")
    path = sys.argv[1]
    print(f"--- Anhang: {path.split('/')[-1]} ---")
    for name, rows in sheet_rows(path):
        print(f"\n[Blatt: {name}, {len(rows)} Zeilen]")
        for row in rows:
            # Komma als Trenner, damit eine Adresszeile genau so aussieht, wie
            # sie in einer Anfrage stuende - und damit zitierbar ist.
            print(", ".join(c for c in row if c))


if __name__ == "__main__":
    main()
