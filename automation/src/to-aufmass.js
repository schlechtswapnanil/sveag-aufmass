// Brief -> Import-Datei fuer das Aufmass-Tool.
//
// Das Tool importiert { version: 1, objects: [...] } (importJson in
// src/state.js). Ein Objekt braucht id, address, lat, lon, bundesland,
// assumptionsNote, lines, createdAt, updatedAt.
//
// Kundenangaben werden bewusst NICHT zu lines[]: eine Zahl aus der Mail hat
// keine Geometrie, und eine erfundene Linie waere schlimmer als keine. Sie
// wandern in assumptionsNote - also auf das gedruckte Aufmassblatt, direkt
// neben die gemessenen Werte, wo die Freigabe sie vergleichen kann.

const { classifyTier, TIER_LABEL, TOOL_CATEGORIES, hasMeasurement } = require('./brief.js');

const CATEGORY_LABEL = {
  gehweg: 'Gehweg',
  haustuer: 'Haustuer',
  garage: 'Garage',
  parkplatz: 'Parkplatz',
  muelltonnen: 'Muelltonnen',
  sonstiges: 'Sonstiges',
};

function makeId(rand = Math.random) {
  return 'id-' + rand().toString(36).slice(2, 10) + rand().toString(36).slice(2, 6);
}

// Der Kundenbegriff gewinnt. Er steht so im Angebot und im Sheet, damit die
// Position wiedererkennbar bleibt - "Wohnwege 291 m²", nicht "Haustuer 291 m²".
// Die Tool-Kategorie dahinter steuert nur die Messung.
function sectorLabel(s) {
  return s.label || CATEGORY_LABEL[s.category] || 'Sonstiges';
}

// Flaeche zuerst: Kundenanfragen und die Angebote rechnen in qm, nicht in
// laufenden Metern (siehe README, "Die Einheit stimmt nicht").
function formatMeasurement(s) {
  const parts = [];
  if (s.areaM2 != null) parts.push(`${s.areaM2} m²`);
  if (s.lengthM != null) parts.push(`${s.lengthM} m`);
  if (s.widthM != null) parts.push(`Breite ${s.widthM} m`);
  if (s.count != null) parts.push(`${s.count} Stk.`);
  return parts.join(', ');
}

// Der Text landet im Feld "Annahmen / Notizen" und damit auf dem PDF.
// Kurz halten - das Aufmassblatt hat dafuer eine Zeile, keinen Absatz.
function buildAssumptionsNote(brief) {
  const lines = [];
  const tier = brief.tier;
  lines.push(`Anfrage Stufe ${tier} (${TIER_LABEL[tier]}).`);

  if (brief.object && brief.object.accessNote) {
    lines.push(`Zugang: ${brief.object.accessNote}.`);
  }

  const stated = (brief.sectors || [])
    .filter((s) => s.present === true && hasMeasurement(s))
    .map((s) => `${sectorLabel(s)} ${formatMeasurement(s)}${s.isEstimate ? ' (Kundenschaetzung)' : ''}`);
  if (stated.length) lines.push(`Kundenangabe: ${stated.join('; ')} - gegen Messung pruefen.`);

  const excluded = (brief.sectors || [])
    .filter((s) => s.present === false)
    .map(sectorLabel);
  if (excluded.length) lines.push(`Laut Kunde nicht beauftragt: ${excluded.join(', ')}.`);

  const svc = brief.service || {};
  const svcParts = [];
  if (svc.einsaetze != null) svcParts.push(`${svc.einsaetze} Einsaetze`);
  if (svc.streugutentsorgung === true) svcParts.push('inkl. Streugutentsorgung');
  if (svc.offerDeadline) svcParts.push(`Angebot bis ${svc.offerDeadline}`);
  if (svcParts.length) lines.push(`Leistung: ${svcParts.join(', ')}.`);

  const specials = svc.specials || [];
  if (specials.length) lines.push(`Besonderheiten: ${specials.join('; ')}.`);

  const questions = brief.openQuestions || [];
  if (questions.length) lines.push(`Offen: ${questions.join(' ')}`);

  return lines.join(' ');
}

// Welche Kategorien muss die Messung noch selbst herleiten? Alles, wozu die
// Mail nichts sagt oder nur eine Schaetzung liefert. Steuert spaeter, welche
// Sektoren ueberhaupt an den Luftbild-Schritt gehen.
//
// Zaehlt die Mail die Bereiche abschliessend auf ("wie folgt:", farbige
// Markierung auf einer Flurkarte), dann ist Schweigen eine Aussage: nicht
// genannt heisst nicht beauftragt. Ohne diese Unterscheidung misst der
// Luftbild-Schritt einen Parkplatz aus, den niemand bestellt hat, und er
// landet im Angebot.
function categoriesToMeasure(brief) {
  const exhaustive = brief.sectorListIsExhaustive === true;
  // Auf eine Kategorie koennen mehrere Kundenpositionen fallen ("Wohnwege"
  // und "Kellerniedergaenge" sind beide haustuer). Gemessen werden muss die
  // Kategorie, sobald EINE ihrer Positionen kein festes Mass hat.
  const byKey = new Map();
  for (const s of brief.sectors || []) {
    if (!byKey.has(s.category)) byKey.set(s.category, []);
    byKey.get(s.category).push(s);
  }
  return TOOL_CATEGORIES.filter((key) => {
    const list = byKey.get(key);
    if (!list) return !exhaustive;                       // Mail schweigt dazu
    const ordered = list.filter((s) => s.present !== false);
    if (ordered.length === 0) return false;              // ausdruecklich nicht beauftragt
    const unknown = ordered.filter((s) => s.present === null);
    if (unknown.length === ordered.length && exhaustive) return false;
    return ordered.some((s) => !hasMeasurement(s) || s.isEstimate);
  });
}

// geo stammt aus geocode(); nowIso und makeId sind injizierbar, damit der Test
// deterministisch bleibt.
function briefToObject(brief, geo, { nowIso = new Date().toISOString(), idFn = makeId } = {}) {
  if (!geo) throw new Error('Ohne Geocoding-Treffer laesst sich kein Objekt anlegen');
  return {
    id: idFn(),
    address: geo.label,
    lat: geo.lat,
    lon: geo.lon,
    bundesland: geo.state || null,
    assumptionsNote: buildAssumptionsNote(brief),
    lines: [], // wird beim Messen gefuellt, nie aus der Mail
    createdAt: nowIso,
    updatedAt: nowIso,

    // Zusatzfeld, das das Tool nicht kennt. importJson/exportJson reichen
    // unbekannte Keys unveraendert durch, also reist die Herkunft mit dem
    // Objekt mit und steht der Freigabe und dem Sheet-Export offen.
    sveagBrief: {
      tier: brief.tier,
      toMeasure: categoriesToMeasure(brief),
      brief,
    },
  };
}

// geos: ein Geocoding-Treffer je Adresse des Auftrags. Eine Wohnanlage ueber
// drei Strassenzuege braucht drei Objekte im Tool - mit einer einzigen
// Koordinate laesst sich die Anlage nicht aufmessen.
function briefToImportFile(brief, geos, opts) {
  const list = Array.isArray(geos) ? geos : [geos];
  if (list.length === 0) throw new Error('Ohne Geocoding-Treffer laesst sich kein Objekt anlegen');
  return {
    version: 1,
    objects: list.map((geo, i) => {
      const obj = briefToObject(brief, geo, opts);
      // "Teil n von m" gilt nur fuer EIN Objekt, das ueber mehrere
      // Strassenzuege laeuft - dort teilen sich die Teile eine Gesamtflaeche.
      // Eine Ausschreibung ueber 95 eigenstaendige Haeuser ist keine Anlage;
      // dort ist jedes Objekt fuer sich, und eine Kundenangabe darf nicht auf
      // "Teil 1" zusammengezogen werden.
      const portfolio = (brief.object || {}).orderType === 'portfolio';
      if (list.length > 1 && !portfolio) {
        obj.assumptionsNote =
          `Teil ${i + 1} von ${list.length} der Anlage. ${obj.assumptionsNote}`;
      }
      return obj;
    }),
  };
}

// Alle Adressen des Auftrags, Haupt- plus Nebenadressen.
function allAddresses(brief) {
  const o = brief.object || {};
  return [o.addressRaw, ...(o.moreAddresses || [])].filter(Boolean);
}

// Suchbegriff fuer den Geocoder. addressRaw steht woertlich in der Mail und
// bleibt der Beleg - fuer die Suche fehlen dort aber oft PLZ und Ort, weil
// die Mail sie an anderer Stelle nennt ("Wohnanlagen in Hamburg Fuhlsbuettel
// Erdkampsweg 83-87"). Beides wird ergaenzt, wenn es nicht ohnehin drinsteht.
function geocodeQuery(brief, address) {
  const o = brief.object || {};
  const parts = [address];
  for (const extra of [o.postcode, o.city]) {
    if (extra && !address.toLowerCase().includes(String(extra).toLowerCase())) {
      parts.push(extra);
    }
  }
  return parts.join(', ');
}

module.exports = {
  briefToObject, briefToImportFile, allAddresses, geocodeQuery, buildAssumptionsNote,
  categoriesToMeasure, sectorLabel, formatMeasurement, makeId, CATEGORY_LABEL,
};
