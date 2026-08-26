// Geocoding gegen Photon (Komoot) - derselbe Dienst und dieselbe
// Feld-Auswertung wie geocode() in src/app.js des Aufmass-Tools, damit ein
// automatisch vorbereitetes Objekt an genau derselben Stelle landet wie eines,
// das jemand von Hand in die Suchleiste tippt.

const PHOTON_URL = 'https://photon.komoot.io/api/';

// Photon liefert fuer Stadtstaaten kein `state` (Stadt- und Landesgrenze sind
// identisch). Ohne diesen Fallback findet das Tool spaeter weder WMS- noch
// WFS-Eintrag fuer Berlin/Hamburg/Bremen.
const CITY_STATES = ['Berlin', 'Hamburg', 'Bremen'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Photon ist ein oeffentlicher Dienst und drosselt. Bei einer Objektliste mit
// 95 Adressen kippt er ab etwa der 55. in HTTP 503 - ohne Wiederholung fehlt
// dann fast die Haelfte der Objekte. Deshalb: bei 429/5xx warten und erneut
// versuchen, mit wachsendem Abstand.
const RETRY_STATUS = /^(429|5\d\d)$/;

async function geocode(query, { fetchImpl = fetch, timeoutMs = 15000, retries = 3, backoffMs = 1200 } = {}) {
  // Ein leerer Suchbegriff ist kein Suchbegriff. Photon liefert darauf
  // trotzdem einen Treffer (bei "null" ein Dorf in Frankreich), und der
  // wandert dann als Objektkoordinate weiter - falsch, aber ohne Fehler.
  if (typeof query !== 'string' || query.trim().length < 3) {
    throw new Error(`Unbrauchbarer Suchbegriff fuer das Geocoding: ${JSON.stringify(query)}`);
  }
  const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=1&lang=de`;
  let data;
  let lastErr;
  for (let versuch = 0; versuch <= retries; versuch++) {
    if (versuch > 0) await sleep(backoffMs * versuch); // 1.2s, 2.4s, 3.6s
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) {
        lastErr = new Error(`Photon HTTP ${res.status}`);
        if (RETRY_STATUS.test(String(res.status))) continue;
        throw lastErr; // 400er sind Programmierfehler, kein Wiederholen
      }
      data = await res.json();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err.name !== 'AbortError' && !/HTTP (429|5\d\d)/.test(err.message)) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr) throw new Error(`${lastErr.message} (nach ${retries} Wiederholungen)`);

  const f = data && data.features && data.features[0];
  if (!f) return null;

  const p = f.properties || {};
  const street = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
  const city = [p.postcode, p.city].filter(Boolean).join(' ');
  return {
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    state: p.state || (CITY_STATES.includes(p.city) ? p.city : null),
    countryCode: p.countrycode || null,
    label: [street, city].filter(Boolean).join(', ') || query,
  };
}

module.exports = { geocode, PHOTON_URL, CITY_STATES };
