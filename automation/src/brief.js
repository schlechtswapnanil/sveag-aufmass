// Regeln rund um den Aufmass-Brief: Tier-Einstufung, Beleg-Pruefung, Validierung.
//
// Die Tier-Einstufung ist bewusst *berechnet* und nicht vom Extraktor frei
// waehlbar. Sonst haengt der 3-Stufen-Fallback am Bauchgefuehl des Modells und
// zwei gleiche Mails landen in unterschiedlichen Stufen.

const fs = require('node:fs');
const path = require('node:path');
const { schemaErrors } = require('./schema-check.js');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'schema', 'brief.schema.json'), 'utf8')
);

// Kategorien, die das Tool kennt (CATEGORIES in src/model.js des Aufmass-Tools).
const TOOL_CATEGORIES = ['gehweg', 'haustuer', 'garage', 'parkplatz', 'muelltonnen'];

const TIER_LABEL = {
  A: 'nur Adresse',
  B: 'Teilangaben',
  C: 'vollstaendig',
};

function hasMeasurement(s) {
  return s.lengthM != null || s.areaM2 != null;
}

// A: die Mail nennt ausser der Adresse nichts Verwertbares.
// C: ein BEMASSTER Plan liegt bei ODER jeder als vorhanden genannte Sektor hat
//    ein Mass und der Objekttyp steht fest.
// B: alles dazwischen.
//
// Entscheidend ist immer, ob Masse vorliegen. Eine Flurkarte mit farbig
// markierten Flaechen beantwortet "welche Bereiche", nicht "wie lang" - sie
// ersetzt das Aufmass also nicht und hebt nicht auf C. Das war in der ersten
// Fassung anders und an zwei echten Anfragen sofort falsch.
function classifyTier(brief) {
  const sectors = brief.sectors || [];
  const attachments = brief.attachments || [];
  const stated = sectors.filter((s) => s.present === true || s.present === false);
  const present = sectors.filter((s) => s.present === true);
  const dimensionedPlan = attachments.some(
    (a) => (a.kind === 'lageplan' || a.kind === 'grundriss') && a.hasDimensions === true
  );
  const typeKnown = Boolean(
    brief.object && brief.object.objectType && brief.object.objectType !== 'unbekannt'
  );

  if (dimensionedPlan) return 'C';
  if (present.length > 0 && present.every(hasMeasurement) && typeKnown) return 'C';
  if (stated.length === 0 && !typeKnown) return 'A';
  return 'B';
}

// Vergleichsform fuer Zitate: Zeilenumbrueche und Mehrfach-Leerzeichen weg,
// damit ein ueber zwei Zeilen umbrochener Satz noch als Beleg zaehlt.
function normalizeQuote(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// Tolerantere Form fuer Adressen: zusaetzlich Satzzeichen weg. Der Extraktor
// setzt beim Zusammenziehen von "Musterstr. 1 / 12345 Musterstadt" gern ein
// Komma, das im Mailtext nicht steht - das soll kein Fehler sein. Erfundene
// Adressen faengt der Test trotzdem.
function normalizeAddress(s) {
  return normalizeQuote(s).replace(/[.,;/-]/g, '');
}

// Prueft, dass jede behauptete Angabe woertlich im Quelltext steht.
// Das ist die Halluzinations-Bremse: ein Mass, das das Modell erfunden hat,
// hat keinen Beleg und faellt hier auf.
//
// `sourceText` ist alles, was beim Extrahieren vorlag: Betreffzeile, Mailtext
// und zitierte Vorgaenger-Nachrichten. Wird die Anfrage aus Gmail geholt,
// gehoert der Betreff mit hinein - sonst laesst sich die dort genannte
// Adresse nicht belegen.
function evidenceErrors(brief, sourceText) {
  const errors = [];
  const hay = normalizeQuote(sourceText);
  const hayAddr = normalizeAddress(sourceText);

  const obj = brief.object || {};
  const addr = obj.addressRaw;
  // Geprueft wird gegen den *Quelltext*: alles, was beim Extrahieren vorlag -
  // Betreff, Mailtext und die zitierten Vorgaenger-Nachrichten. Frueher war
  // eine Adresse aus dem Betreff von der Pruefung ausgenommen, weil der
  // Betreff nicht mitgeliefert wurde. Das war ein Loch: gerade die Adresse,
  // die nirgends im Text steht, blieb ungeprueft. Wer den Betreff liest,
  // schreibt ihn in den Quelltext - dann traegt auch sie einen Beleg.
  if (addr && !hayAddr.includes(normalizeAddress(addr))) {
    errors.push(
      `object.addressRaw: "${addr}" steht so nicht im Quelltext` +
      ` (addressSource="${obj.addressSource || '?'}")`
    );
  }

  (brief.sectors || []).forEach((s, i) => {
    if (s.source !== 'email') return;
    if (!s.evidence) {
      errors.push(`sectors[${i}] (${s.category}): source=email, aber kein evidence-Zitat`);
      return;
    }
    if (!hay.includes(normalizeQuote(s.evidence))) {
      errors.push(`sectors[${i}] (${s.category}): Zitat "${s.evidence}" steht so nicht im Quelltext`);
    }
  });
  return errors;
}

// Regeln, die sich in JSON Schema nicht ausdruecken lassen.
function consistencyErrors(brief) {
  const errors = [];
  const seen = new Set();

  // Anfragen von Hausverwaltungen nennen die Adresse regelmaessig nur im
  // Betreff ("o. g. Objekt"). Das ist erlaubt - aber es muss als Luecke
  // sichtbar bleiben, sonst geht die Anfrage ohne Objekt in die Messung.
  const obj = brief.object || {};
  if (!obj.addressRaw && obj.addressSource !== 'fehlt') {
    errors.push('object: ohne addressRaw muss addressSource "fehlt" sein');
  }
  if (obj.addressRaw && obj.addressSource === 'fehlt') {
    errors.push('object: addressSource "fehlt", aber addressRaw ist gesetzt');
  }
  if (!obj.addressRaw && !(brief.openQuestions || []).some((q) => /adress/i.test(q))) {
    errors.push('object: Adresse fehlt, aber keine offene Frage danach - so faellt es niemandem auf');
  }

  (brief.sectors || []).forEach((s, i) => {
    // Mehrere Kundenpositionen koennen auf dieselbe Kategorie fallen -
    // "Wohnwege" und "Kellerniedergaenge" sind beide haustuer. Das ist
    // gewollt (siehe vocabulary.js); doppelt ist erst, was auch dasselbe
    // Label traegt, denn dann waere es zweimal dieselbe Position.
    const key = `${s.category}:${s.label || ''}`;
    if (seen.has(key)) {
      errors.push(
        `sectors[${i}]: Position "${s.label || s.category}" doppelt` +
        (s.label ? '' : ' - mehrere Positionen derselben Kategorie brauchen je ein label')
      );
    }
    seen.add(key);

    if (s.category === 'sonstiges' && !s.label) {
      errors.push(`sectors[${i}]: category=sonstiges braucht ein label`);
    }
    if (s.present === false && hasMeasurement(s)) {
      errors.push(`sectors[${i}] (${s.category}): present=false, trotzdem ein Mass angegeben`);
    }
    if (s.present !== true && s.source === 'email' && !s.evidence) {
      errors.push(`sectors[${i}] (${s.category}): source=email braucht ein evidence-Zitat`);
    }
  });
  return errors;
}

// sourceText optional: ohne ihn entfaellt nur die Beleg-Pruefung.
function validateBrief(brief, sourceText) {
  const errors = [
    ...schemaErrors(brief, SCHEMA),
    ...consistencyErrors(brief),
    ...(sourceText ? evidenceErrors(brief, sourceText) : []),
  ];

  // Tier erst pruefen, wenn die Struktur steht - sonst klassifiziert
  // classifyTier() auf Schrott und meldet einen Folgefehler.
  if (errors.length === 0) {
    const expected = classifyTier(brief);
    if (brief.tier !== expected) {
      errors.push(
        `tier: "${brief.tier}" angegeben, nach den Angaben ist es "${expected}" ` +
        `(${TIER_LABEL[expected]}) - tier wird berechnet, nicht geschaetzt`
      );
    }
  }
  return errors;
}

module.exports = {
  SCHEMA, TOOL_CATEGORIES, TIER_LABEL,
  classifyTier, validateBrief, evidenceErrors, consistencyErrors,
  normalizeQuote, normalizeAddress, hasMeasurement,
};
