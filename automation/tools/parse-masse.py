#!/usr/bin/env python3
"""Die Maß-Spalte einer Objektliste auswerten.

    python3 tools/parse-masse.py ../test.xlsx -o work/potsdam-gt.json

Die Angaben stehen als Fließtext: "Gehweg 65mx1,5m + 15mx1,5m Zugänge
Hauseingänge". Zu lesen ist daraus je Posten eine Länge und eine Breite, und
wozu der Posten gehört.

Zwei Fallen:
  * Die Reihenfolge wechselt - mal "1,5mx130m", mal "210mx1,5m". Die 1,5 m ist
    immer die Breite (Regelbreite eines Gehwegs), der andere Wert die Länge.
    Wer stur das erste Maß als Länge nimmt, liest 1,5 m statt 130 m.
  * Die Beschriftung steht mal vor, mal hinter der Zahl. Zugeordnet wird
    deshalb über das nächstliegende Stichwort in beide Richtungen.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

STICHWORT = [
    ("gehweg", "gehweg"), ("gehwege", "gehweg"),
    ("hauseingang", "haustuer"), ("hauseingänge", "haustuer"), ("haustür", "haustuer"),
    ("zugang", "haustuer"), ("zugänge", "haustuer"), ("zuwegung", "haustuer"),
    ("einfahrt", "garage"), ("garage", "garage"), ("garagen", "garage"),
    ("parkplatz", "parkplatz"), ("parkplätze", "parkplatz"), ("parkplatzflächen", "parkplatz"),
    ("mülltonnen", "muelltonnen"), ("müllstandplätze", "muelltonnen"), ("müllstandplatz", "muelltonnen"),
]

MASS = re.compile(r"(\d+(?:[.,]\d+)?)\s*m\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*m", re.I)
FLAECHE = re.compile(r"(\d+(?:[.,]\d+)?)\s*qm", re.I)
zahl = lambda s: float(s.replace(",", "."))


def posten(text):
    """Liste von {laengeM, breiteM, kategorie} bzw. {flaecheM2, kategorie}."""
    out = []
    for m in MASS.finditer(text):
        a, b = zahl(m.group(1)), zahl(m.group(2))
        # Die kleinere Zahl ist die Breite - ein Gehweg ist 1,5 m breit und
        # nicht 130 m. Bei gleichen Werten spielt es keine Rolle.
        laenge, breite = (a, b) if a >= b else (b, a)
        out.append({"laengeM": laenge, "breiteM": breite,
                    "kategorie": naechstes_stichwort(text, m.start(), m.end())})
    for m in FLAECHE.finditer(text):
        out.append({"flaecheM2": zahl(m.group(1)),
                    "kategorie": naechstes_stichwort(text, m.start(), m.end())})
    return out


def naechstes_stichwort(text, start, ende):
    """Kategorie aus dem Stichwort, das der Zahl am nächsten steht."""
    t = text.lower()
    beste, bester_abstand = "sonstiges", 10 ** 9
    for wort, kat in STICHWORT:
        for m in re.finditer(re.escape(wort), t):
            abstand = min(abs(m.start() - ende), abs(start - m.end()))
            if abstand < bester_abstand:
                bester_abstand, beste = abstand, kat
    return beste if bester_abstand < 60 else "sonstiges"


def main():
    args = sys.argv[1:]
    out = None
    if "-o" in args:
        i = args.index("-o"); out = args[i + 1]; args = args[:i] + args[i + 2:]
    text = subprocess.run(["python3", str(Path(__file__).parent / "xlsx-to-text.py"), args[0]],
                          capture_output=True, text=True).stdout
    zeilen = [l for l in text.splitlines() if l.strip() and not l.startswith(("---", "[Blatt"))]
    kopf = zeilen[0].split(", ")
    daten = []
    for z in zeilen[1:]:
        teile = z.split(", ")
        if len(teile) < 4 or not teile[0].strip().isdigit():
            continue
        # Adresse und Ort stehen an fester Position; alles danach ist die
        # Maßangabe, die selbst Kommata enthalten kann.
        nr, gebiet, objekt, ort = teile[0], teile[1], teile[2], teile[3]
        masse = ", ".join(teile[4:]).strip() if len(teile) > 4 else ""
        daten.append({"nr": int(nr), "wohngebiet": gebiet, "objekt": objekt,
                      "ort": ort, "masseRoh": masse, "posten": posten(masse)})
    mit = [d for d in daten if d["posten"]]
    print(f"{len(daten)} Objekte, {len(mit)} mit Maßangabe", file=sys.stderr)
    if out:
        Path(out).write_text(json.dumps(daten, indent=1, ensure_ascii=False))
        print(f"-> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
