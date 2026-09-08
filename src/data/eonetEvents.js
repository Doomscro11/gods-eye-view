// src/data/eonetEvents.js
/**
 * NASA EONET — Earth Observatory Natural Event Tracker. Open events (severe
 * storms, volcanoes, wildfires, ice, floods) with point geometry. Public
 * domain NASA data, keyless, CORS-enabled.
 *
 * Complements the FIRMS layer: FIRMS sees thermal anomalies, EONET curates
 * the EVENT — one storm object with a track instead of a thousand dots.
 *
 * Pure normalize + injectable fetch. @module data/eonetEvents
 */

export const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=200';

/** Latest point geometry for an EONET event, or null. */
function latestPoint(event) {
  const geoms = Array.isArray(event?.geometry) ? event.geometry : [];
  for (let i = geoms.length - 1; i >= 0; i -= 1) {
    const g = geoms[i];
    if (g?.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    const [lon, lat] = g.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { latDeg: lat, lonDeg: lon, date: g.date || null };
    }
  }
  return null;
}

/** Normalize an EONET v3 response into spatial event records. */
export function normalizeEonet(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const items = [];
  for (const e of events) {
    const id = String(e?.id || '').trim();
    const point = latestPoint(e);
    if (!id || !point) continue;
    const categories = Array.isArray(e.categories)
      ? e.categories.map((c) => String(c?.title || c?.id || '')).filter(Boolean)
      : [];
    items.push({
      id: `eonet:${id}`,
      title: String(e?.title || '').trim() || id,
      categories,
      category: categories[0] || 'Event',
      closed: Boolean(e?.closed),
      lat: point.latDeg,
      lon: point.lonDeg,
      lastUpdate: point.date,
      sourceUrl: Array.isArray(e?.sources) && e.sources[0]?.url ? e.sources[0].url : null,
    });
  }
  return { count: items.length, items };
}

/** Fetch + normalize. Returns null on any failure (feeds are best-effort). */
export async function fetchEonetEvents(fetchFn = fetch) {
  try {
    const res = await fetchFn(EONET_URL);
    if (!res?.ok) return null;
    return normalizeEonet(await res.json());
  } catch {
    return null;
  }
}
