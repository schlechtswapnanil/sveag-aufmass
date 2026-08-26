"""Datenquellen fuer den Luftbild-Schritt.

Alle drei Quellen benutzt das Aufmass-Tool bereits; hier werden sie nur
ausserhalb des Browsers geholt. Netzzugriff laeuft ueber curl, weil der
Python-Build auf manchen Rechnern kein CA-Bundle hat (siehe README).
"""

import json
import math
import subprocess
import tempfile
from pathlib import Path

OSM_MAP = "https://api.openstreetmap.org/api/0.6/map.json"


def _curl(url: str, out: Path | None = None) -> bytes:
    cmd = ["curl", "-sS", "--fail", "-A", "sveag-aufmass", url]
    if out:
        cmd += ["-o", str(out)]
    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        raise RuntimeError(f"Abruf fehlgeschlagen ({url[:80]}…): {res.stderr.decode()[:200]}")
    return res.stdout


def bbox_for(lat: float, lon: float, radius_m: float):
    """Quadratischer Ausschnitt in Grad.

    Laengen- und Breitengrad werden getrennt umgerechnet, damit ein Bild mit
    gleicher Pixelzahl in beiden Achsen dieselbe Bodenaufloesung hat. Sonst
    waeren Pixel in der Breite gestaucht und jede Laengenmessung schief.
    """
    dlat = radius_m / 111320.0
    dlon = radius_m / (111320.0 * math.cos(math.radians(lat)))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def fetch_dop(wms: dict, bbox, size_px: int, out: Path) -> Path:
    """Orthophoto vom Landes-WMS. wms = Eintrag aus WMS_BY_STATE des Tools."""
    params = (
        f"SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS={wms['layers']}"
        f"&STYLES=&SRS=EPSG:4326&BBOX={','.join(f'{v!r}' for v in bbox).replace(chr(39),'')}"
        f"&WIDTH={size_px}&HEIGHT={size_px}&FORMAT=image/png"
    )
    _curl(f"{wms['url']}?{params}", out)
    head = out.read_bytes()[:200]
    if b"ServiceException" in head or b"<?xml" in head:
        raise RuntimeError(f"WMS lieferte kein Bild: {head[:160]!r}")
    return out


def fetch_osm(bbox) -> dict:
    """Gebaeude- und Strassengeometrie.

    Wichtig: die map.json-Antwort enthaelt Gebaeude bereits - das Tool wirft
    sie in osmMapToOverpass() weg (`if (!highway) continue`). Fuer den
    Luftbild-Schritt sind sie die wertvollste Einzelinformation, weil sie das
    Dach vom Hof trennen, was ueber Farbe allein nicht geht.
    """
    raw = _curl(f"{OSM_MAP}?bbox={','.join(str(v) for v in bbox)}")
    data = json.loads(raw)
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in data["elements"] if e["type"] == "node"}
    buildings, streets = [], []
    for e in data["elements"]:
        if e["type"] != "way" or "nodes" not in e:
            continue
        tags = e.get("tags", {})
        geom = [nodes[n] for n in e["nodes"] if n in nodes]
        if len(geom) < 2:
            continue
        if "building" in tags:
            buildings.append(geom)
        elif "highway" in tags:
            streets.append({"geom": geom, "highway": tags["highway"]})
    return {"buildings": buildings, "streets": streets}


def fetch_parcel_rings(node_helper: Path, wfs: dict, lat: float, lon: float,
                       margin_m: float = 25.0, count: int = 100):
    """Flurstuecksringe als [[lat, lon], …].

    count bewusst hoch: mit dem count=5 des Tools faellt in dichter
    Reihenhausbebauung genau das Flurstueck heraus, das den Punkt enthaelt -
    siehe README, Abschnitt "Gefundener Fehler".
    """
    out = json.loads(subprocess.run(
        ["node", str(node_helper), str(lat), str(lon), json.dumps(wfs), str(count), str(margin_m)],
        capture_output=True, text=True, check=True).stdout)
    return out
