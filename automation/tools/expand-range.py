#!/usr/bin/env python3
"""Adressspannen einer Objektliste in Einzeladressen aufloesen.

    python3 tools/expand-range.py "Hessestraße 1 - 19"

Verwalter schreiben eine Wohnanlage als Spanne: "Hans-Sachs-Straße 3 - 55" sind
27 Haeuser, "Puschkinallee 14 a - c" sind drei. Ein Geocoder liefert dafuer
einen Punkt, das Aufmass gilt aber fuer alle. Ohne Aufloesung vergleicht man
die Front EINES Hauses mit der Summe von zwanzig - im Potsdamer Testsatz war
die Vorhersage dadurch im Median 91 % zu niedrig.

Deutsche Hausnummernspannen laufen ueblicherweise auf einer Strassenseite,
also in Zweierschritten: "26 - 38" meint 26, 28 … 38, nicht 27. Ist die
Paritaet gemischt (3 - 4), wird in Einerschritten gezaehlt.
"""

import re
import sys

MAX_TEILE = 40  # Sicherung gegen Tippfehler wie "1 - 1900"


def expandiere(objekt):
    # "Str." wird zu "straße" - dabei muss ein Leerzeichen vor die Hausnummer,
    # sonst wird aus "Kunersdorfer Str.6 - 8" ein "strasse6" und die Spanne
    # bleibt unerkannt. Ebenso "Kun.1-5" ohne Trennzeichen.
    objekt = re.sub(r"\b([Ss])tr\.\s*", r"\1traße ", objekt)
    objekt = re.sub(r"\.\s*(?=\d)", ". ", objekt).strip().rstrip(";,")
    m = re.match(r"^(.+?)\s+(\d.*)$", objekt)
    if not m:
        return [objekt]
    strasse, rest = m.group(1).strip().rstrip(".,;"), m.group(2)

    nummern = []
    for teil in re.split(r"[;/]", rest):
        teil = teil.strip().rstrip(".,;")
        if not teil:
            continue
        sp = re.match(r"^(\d+)\s*([a-z])?\s*[-–]\s*(\d+)?\s*([a-z])?$", teil, re.I)
        if sp and sp.group(1) and sp.group(3):
            a, b = int(sp.group(1)), int(sp.group(3))
            if b < a or b - a > 200:
                nummern.append(teil)
                continue
            schritt = 2 if (a % 2) == (b % 2) else 1
            nummern += [str(n) for n in range(a, b + 1, schritt)]
        elif sp and sp.group(2) and sp.group(4):
            basis = sp.group(1)
            for c in range(ord(sp.group(2).lower()), ord(sp.group(4).lower()) + 1):
                nummern.append(f"{basis}{chr(c)}")
        else:
            for n in re.findall(r"\d+\s*[a-z]?", teil):
                nummern.append(n.replace(" ", ""))
    if not nummern:
        return [objekt]
    gesehen, sauber = set(), []
    for n in nummern:
        if n not in gesehen:
            gesehen.add(n)
            sauber.append(n)
    return [f"{strasse} {n}" for n in sauber[:MAX_TEILE]]


if __name__ == "__main__":
    args = sys.argv[1:]
    # --plain gibt eine Adresse je Zeile aus, ungekuerzt. Die lesbare Fassung
    # kuerzt ab acht Teilen mit "…" - wer die weiterverarbeitet, verliert bei
    # einer 27er-Anlage zwei Drittel der Haeuser, ohne dass es auffaellt.
    plain = "--plain" in args
    if plain:
        args = [a for a in args if a != "--plain"]
    for arg in args:
        teile = expandiere(arg)
        if plain:
            for t in teile:
                print(t)
        else:
            print(f"{arg}  ->  {len(teile)}: {', '.join(teile[:8])}"
                  f"{' …' if len(teile) > 8 else ''}")
