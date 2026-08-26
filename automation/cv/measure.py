"""Luftbild-Schritt: Sektoren eines Grundstuecks aus dem Orthophoto ableiten.

Der Ansatz ist bewusst klassische CV, kein trainiertes Modell. Tragfaehig wird
er nur durch die Vektor-Randbedingungen: Farbe allein trennt Dach, Einfahrt und
winterlichen Rasen nicht (Messung im README). Erst wenn das Flurstueck den
Ausschnitt begrenzt und die Gebaeudeflaeche ausgeschnitten ist, bleiben so
wenige Klassen uebrig, dass eine Schwelle reicht.

Reihenfolge:
  1. Arbeitsflaeche  = Flurstueck ohne Gebaeude
  2. Befestigt       = nicht Vegetation, nicht Dach, geringe Saettigung
  3. Komponenten     = zusammenhaengende befestigte Flaechen ab Mindestgroesse
  4. Mittellinien    = Skelett je Komponente, laengster Pfad, vereinfacht
  5. Zuordnung       = ueber Ankerpunkte (Strassenkante, Gebaeudekante), nicht ueber Aussehen
"""

import math
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage.morphology import skeletonize, remove_small_objects, remove_small_holes

# --- Geometrie zwischen Bild und Welt ------------------------------------

class Frame:
    """Bildausschnitt mit fester Bodenaufloesung.

    Der WMS-Ausschnitt wird so angefragt, dass ein Pixel in beiden Achsen
    gleich viele Meter abdeckt - deshalb genuegt hier lineare Interpolation,
    ohne Projektionsrechnung.
    """

    def __init__(self, bbox, size_px):
        self.minlon, self.minlat, self.maxlon, self.maxlat = bbox
        self.n = size_px
        mid = math.radians((self.minlat + self.maxlat) / 2)
        self.m_per_px_y = (self.maxlat - self.minlat) * 111320.0 / size_px
        self.m_per_px_x = (self.maxlon - self.minlon) * 111320.0 * math.cos(mid) / size_px

    @property
    def m_per_px(self):
        return (self.m_per_px_x + self.m_per_px_y) / 2

    def to_px(self, latlon):
        lat, lon = latlon
        return ((lon - self.minlon) / (self.maxlon - self.minlon) * self.n,
                (1 - (lat - self.minlat) / (self.maxlat - self.minlat)) * self.n)

    def to_latlon(self, xy):
        x, y = xy
        return (self.minlat + (1 - y / self.n) * (self.maxlat - self.minlat),
                self.minlon + (x / self.n) * (self.maxlon - self.minlon))

    def polygon_mask(self, rings):
        img = Image.new("L", (self.n, self.n), 0)
        d = ImageDraw.Draw(img)
        for r in rings:
            if len(r) >= 3:
                d.polygon([self.to_px(p) for p in r], fill=255)
        return np.asarray(img) > 0

    def line_mask(self, lines, width_px):
        img = Image.new("L", (self.n, self.n), 0)
        d = ImageDraw.Draw(img)
        for g in lines:
            if len(g) >= 2:
                d.line([self.to_px(p) for p in g], fill=255, width=max(1, int(width_px)))
        return np.asarray(img) > 0


# --- Schritt 2: befestigte Flaeche ---------------------------------------

def _otsu(values):
    """Otsu-Schwelle und ein Mass fuer die Trennschaerfe.

    Gibt (schwelle, guete) zurueck. `guete` ist die Zwischenklassen-Varianz
    geteilt durch die Gesamtvarianz - also der Anteil der Streuung, den die
    Trennung ueberhaupt erklaert. Bei einer einheitlichen Flaeche (Hof nur aus
    nacktem Winterboden) liegt der Wert niedrig: es gibt dort schlicht nichts
    zu trennen.
    """
    v = values[np.isfinite(values)]
    if v.size < 100:
        return None, 0.0
    hist, kanten = np.histogram(v, bins=64)
    mitte = (kanten[:-1] + kanten[1:]) / 2
    w = hist.astype(np.float64)
    gesamt = w.sum()
    if gesamt == 0:
        return None, 0.0
    p = w / gesamt
    w0 = np.cumsum(p)
    m0 = np.cumsum(p * mitte)
    mg = m0[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        zwischen = (mg * w0 - m0) ** 2 / (w0 * (1 - w0))
    zwischen = np.nan_to_num(zwischen)
    i = int(np.argmax(zwischen))
    gesamtvarianz = float(np.sum(p * (mitte - mg) ** 2))
    guete = float(zwischen[i] / gesamtvarianz) if gesamtvarianz > 0 else 0.0
    return float(mitte[i]), guete


# Ab hier gilt eine Flaeche als trennbar. Darunter ist der Ausschnitt
# einheitlich und jede Schwelle wuerde eine Grenze erfinden, die es nicht gibt.
MIN_TRENNSCHAERFE = 0.45

# Anteil der Arbeitsflaeche, ab dem das Ergebnis verworfen wird.
#
# Wege, Einfahrten und Stellflaechen machen einen Teil eines Grundstuecks aus,
# nicht die Haelfte. Kommt die Erkennung auf mehr, hat sie nicht Belag
# gefunden, sondern nicht zwischen Belag und Untergrund unterschieden - im
# Leipziger Testfall ein Hinterhof aus nacktem Winterboden, 103 von 211 m².
# Zum Vergleich: die sauber erkannte Einfahrt in Coesfeld sind 44 von 368 m²,
# also 12 %.
#
# Die Grenze ist bewusst grosszuegig. Sie soll den offensichtlichen Fehlgriff
# abfangen, nicht den knappen Fall entscheiden.
MAX_BELAGSANTEIL = 0.40


def paved_mask(rgb, work, veg_thresh=14.0, sat_thresh=0.26,
               bright_thresh=0.80, texture_thresh=9.0, adaptive=False):
    """Befestigte Flaeche innerhalb der Arbeitsflaeche.

    Drei Merkmale, weil keines allein traegt (Messwerte im README):

    * **Vegetationsindex (ExG)** faengt gruenen Rasen, versagt aber im Winter:
      ruhender Rasen und nackte Beeterde liegen bei ExG ~8, Asphalt bei ~7.
      Genau diese Luftbilder sind aber die brauchbaren, weil unbelaubt.
    * **Helligkeit**, auf die lokale Beleuchtung normiert. Befestigt ist
      deutlich heller als Winterboden (~160 gegen ~93 im Testbild). Die
      Normierung macht daraus einen Wert, der auch im Hausschatten gilt -
      sonst fehlen die beschatteten Wegstuecke, die trotzdem geraeumt werden.
    * **Textur** (lokale Streuung). Belag ist glatt, Boden und Rasen sind es
      nicht. Trennt Winterboden (~11) von Gehweg (~5).

    Daecher sind hell UND glatt und wuerden durchrutschen - sie sind aber
    ueber den OSM-Grundriss schon aus `work` entfernt.

    `adaptive` bestimmt die Helligkeitsschwelle aus dem Ausschnitt selbst statt
    fest vorgegeben. Standardmaessig **aus**: an fuenf Testfaellen raeumte das
    zwar das Rauschen an Mehrfamilienhaeusern weg, zerlegte aber die einzige
    sauber erkannte Einfahrt von 43 m² auf 16 m² in zwei Stuecke. Eine Schwelle
    auf fuenf Faellen zu justieren waere Anpassung an die Stichprobe, keine
    Verbesserung - der Wert wird berechnet und gemeldet, aber nicht benutzt.
    Historisch: Das ist noetig, weil feste Werte an einem
    Einfamilienhaus passen und an einem Hinterhof nicht: dort hat eine feste
    Schwelle nackten Winterboden als Belag ausgegeben (102 m² "Parkplatz" im
    Leipziger Testfall). Laesst sich der Ausschnitt nicht sinnvoll trennen,
    liefert die Funktion eine leere Maske - keine Flaeche ist ein Ergebnis,
    eine erfundene nicht.
    """
    a = rgb.astype(np.float32)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    V = a.max(2)
    S = np.where(V > 0, (V - a.min(2)) / np.maximum(V, 1.0), 0.0)

    illum = ndimage.gaussian_filter(V, sigma=25)
    Vn = V / np.maximum(illum, 1.0)

    gray = a.mean(2)
    mu = ndimage.uniform_filter(gray, 9)
    texture = np.sqrt(np.maximum(ndimage.uniform_filter(gray ** 2, 9) - mu ** 2, 0))

    veg = (2 * G - R - B) / np.maximum(illum, 1.0) * 128.0 > veg_thresh
    kandidat = work & ~veg & (S < sat_thresh)

    schwelle = bright_thresh
    guete = None
    if kandidat.sum() > 500:
        otsu_schwelle, guete = _otsu(Vn[kandidat])
        if adaptive:
            if otsu_schwelle is None or guete < MIN_TRENNSCHAERFE:
                # Einheitlicher Ausschnitt: nichts zu trennen, also nichts melden.
                return np.zeros_like(work), veg, {"schwelle": None, "guete": guete}
            # Die feste Schwelle bleibt Untergrenze: ein durchgehend dunkler Hof
            # soll nicht dadurch zu Belag werden, dass er in sich Kontrast hat.
            schwelle = max(otsu_schwelle, bright_thresh)

    paved = kandidat & (Vn > schwelle) & (texture < texture_thresh)
    return paved, veg, {"schwelle": schwelle, "guete": guete}


def clean(mask, m_per_px, min_area_m2=4.0, close_m=0.5):
    """Rauschen entfernen, ohne schmale Wege zu zerreissen."""
    px_per_m = 1.0 / m_per_px
    r = max(1, int(round(close_m * px_per_m)))
    m = ndimage.binary_closing(mask, np.ones((r, r), bool))
    m = remove_small_holes(m, area_threshold=int(1.0 * px_per_m ** 2))
    m = remove_small_objects(m, min_size=int(min_area_m2 * px_per_m ** 2))
    return m


# --- Schritt 4: Mittellinie ----------------------------------------------

def _longest_path(skel):
    """Laengster Pfad im Skelett, ueber zwei Breitensuchen.

    Ein Skelett ist im Normalfall baumartig; dort liefert die doppelte BFS den
    Durchmesser. Bei einem Zyklus (Weg um ein Beet herum) ist das Ergebnis
    nur noch eine vernuenftige Naeherung, keine exakte Loesung - fuer eine
    Laengenangabe, die ohnehin freigegeben wird, reicht das.
    """
    pts = np.argwhere(skel)
    if len(pts) < 2:
        return []
    index = {(int(y), int(x)): i for i, (y, x) in enumerate(pts)}
    nbrs = [[] for _ in pts]
    for (y, x), i in index.items():
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                j = index.get((y + dy, x + dx))
                if j is not None:
                    nbrs[i].append(j)

    def bfs(start):
        dist = {start: 0}
        prev = {start: None}
        queue = [start]
        while queue:
            nxt = []
            for u in queue:
                for v in nbrs[u]:
                    if v not in dist:
                        dist[v] = dist[u] + 1
                        prev[v] = u
                        nxt.append(v)
            queue = nxt
        far = max(dist, key=dist.get)
        return far, prev

    a, _ = bfs(0)
    b, prev = bfs(a)
    path = []
    cur = b
    while cur is not None:
        y, x = pts[cur]
        path.append((float(x), float(y)))
        cur = prev[cur]
    return path


def _simplify(points, tol_px):
    """Douglas-Peucker, iterativ (Rekursion sprengt bei langen Skeletten den Stack)."""
    if len(points) < 3:
        return list(points)
    keep = np.zeros(len(points), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    P = np.asarray(points, float)
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = P[j] - P[i]
        L = np.hypot(*seg)
        if L == 0:
            d = np.hypot(*(P[i + 1:j] - P[i]).T)
        else:
            d = np.abs(np.cross(seg, P[i + 1:j] - P[i])) / L
        k = int(np.argmax(d))
        if d[k] > tol_px:
            k += i + 1
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [tuple(P[i]) for i in np.flatnonzero(keep)]


def centerline(component, frame, simplify_m=0.6):
    skel = skeletonize(component)
    path = _longest_path(skel)
    if len(path) < 2:
        return []
    return _simplify(path, simplify_m / frame.m_per_px)


def path_length_m(px_points, frame):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(px_points, px_points[1:]):
        total += math.hypot((x2 - x1) * frame.m_per_px_x, (y2 - y1) * frame.m_per_px_y)
    return total


# --- Schritt 5: Zuordnung ------------------------------------------------

def _touches(mask, other, px=3):
    return bool((ndimage.binary_dilation(mask, np.ones((px, px), bool)) & other).any())


def classify(component, frame, anchors):
    """Kategorie aus der Lage ableiten, nicht aus dem Aussehen.

    Eine Einfahrt und ein Terrassenbelag sehen von oben gleich aus. Sie
    unterscheiden sich dadurch, was sie beruehren: die Einfahrt die
    Strassenkante, die Terrasse nur das Haus.
    """
    area_m2 = component.sum() * frame.m_per_px_x * frame.m_per_px_y
    cl = centerline(component, frame)
    length_m = path_length_m(cl, frame) if cl else 0.0
    width_m = area_m2 / length_m if length_m > 0.5 else math.sqrt(max(area_m2, 0.0))

    at_street = _touches(component, anchors["street_edge"])
    at_house = _touches(component, anchors["building"])

    if at_street and width_m >= 2.2:
        cat = "garage"          # Einfahrt: von der Strasse her, fahrzeugbreit
    elif at_street and at_house:
        cat = "haustuer"        # schmale Verbindung Strasse -> Haus
    elif at_street and area_m2 >= 20 and width_m >= 3.5:
        # Stellflaeche - aber nur, wenn sie von der Strasse aus erreichbar
        # ist. Ohne diese Bedingung wurde jede groessere zusammenhaengende
        # Flaeche zum Parkplatz, auch ein Hinterhof aus nacktem Winterboden
        # (102 m² im Leipziger Testfall). Ein Auto muss hinkommen koennen.
        cat = "parkplatz"
    elif at_house:
        cat = "haustuer"
    else:
        cat = "sonstiges"

    return {
        "category": cat,
        "areaM2": round(area_m2, 1),
        "lengthM": round(length_m, 1),
        "widthM": round(width_m, 1),
        "touchesStreet": at_street,
        "touchesBuilding": at_house,
        "pxPath": cl,
    }
