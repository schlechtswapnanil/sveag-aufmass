#!/usr/bin/env python3
"""Einzelne Messstrecken aus den Aufmassblaettern lesen.

    python3 tools/pdf-lines.py <verzeichnis> -o work/blaetter.json

Die Blaetter beschriften jede gezeichnete Strecke einzeln ("Footpath 35 m").
Die Tabelle nennt nur die Summe je Kategorie. Erst die Einzelstrecken zeigen,
woraus sich ein Gehweg zusammensetzt - und ob er ueberhaupt an der Strasse
liegt oder ein privater Zuweg ist.

"Sidewalk at street" ohne Laenge ist keine Messung, sondern der Vorschlag des
Tools aus dem Flurstueck (die gestrichelte Linie).
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from importlib import import_module
pdf_text = import_module("pdf-text")

LABEL = re.compile(r"^(Footpath|Front door|Garage|Parking|Bins|Gehweg|Haustür)\s+([\d.,]+)\s*m$")
TABELLE = re.compile(r"^(Gehweg|Haustür|Garage|Parkplatz|Mülltonnen|sidewalk|front door|Gesamt|In total)$", re.I)


def blatt(path):
    raw = path.read_bytes()
    runs = pdf_text.text_runs(raw, pdf_text.font_cmaps(raw))
    strecken = []
    for r in runs:
        m = LABEL.match(r.strip())
        if m:
            strecken.append({"label": m.group(1), "m": float(m.group(2).replace(",", "."))})
    return {
        "datei": path.name,
        "adresse": path.stem.strip(),
        "strecken": strecken,
        "hatVorschlag": any("Sidewalk at" in r or "Gehweg an" in r for r in runs),
    }


def main():
    args = sys.argv[1:]
    out = None
    if "-o" in args:
        i = args.index("-o"); out = args[i + 1]; args = args[:i] + args[i + 2:]
    verzeichnis = Path(args[0])
    alles = []
    for p in sorted(verzeichnis.glob("*.pdf")):
        try:
            alles.append(blatt(p))
        except Exception as e:
            alles.append({"datei": p.name, "fehler": str(e)[:80]})
    ok = [b for b in alles if b.get("strecken")]
    print(f"{len(alles)} Blaetter, {len(ok)} mit lesbaren Strecken", file=sys.stderr)
    text = json.dumps(alles, indent=1, ensure_ascii=False)
    Path(out).write_text(text) if out else print(text)


if __name__ == "__main__":
    main()
