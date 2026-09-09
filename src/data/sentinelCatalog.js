// src/data/sentinelCatalog.js
/**
 * Copernicus Data Space STAC catalog — acquisition METADATA for Sentinel-1
 * (SAR) and Sentinel-2 (optical): what was imaged, when, over which bbox.
 * Metadata is the browser-cheap half of SAR awareness: "a new SAR scene
 * exists over your area of interest" pairs with the pass engine's "next
 * pass at 14:32Z". Scene pixels stay server-side; we never fetch imagery.
 *
 * Open data (Copernicus full, free and open), keyless STAC search.
 *
 * Pure query-builder + normalize + injectable fetch. @module data/sentinelCatalog
 */

export const CDSE_STAC_URL = 'https://catalogue.dataspace.copernicus.eu/stac/search';

export const SENTINEL_COLLECTIONS = Object.freeze({
  SAR: 'SENTINEL-1',
  OPTICAL: 'SENTINEL-2',
});

/**
 * Build a STAC /search body. `bbox` is [west, south, east, north];
 * `datetime` is an ISO interval ("from/to"). Original design, standard API.
 */
export function buildStacQuery({ bbox, datetime, collections = [SENTINEL_COLLECTIONS.SAR], limit = 20 }) {
  const body = { collections, limit };
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) body.bbox = bbox;
  if (datetime) body.datetime = datetime;
  return body;
}

/** Centroid of a [w, s, e, n] bbox. */
function bboxCenter(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [w, s, e, n] = bbox;
  if (![w, s, e, n].every(Number.isFinite)) return null;
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

/**
 * Normalize a STAC FeatureCollection into acquisition records.
 * @returns {{count:number, items:Array<object>}}
 */
export function normalizeStacItems(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const items = [];
  for (const f of features) {
    const id = String(f?.id || '').trim();
    const center = bboxCenter(f?.bbox);
    if (!id || !center) continue;
    const props = f?.properties || {};
    items.push({
      id: `sentinel:${id}`,
      collection: String(f?.collection || '').trim(),
      datetime: props.datetime || props.start_datetime || null,
      lat: center.lat,
      lon: center.lon,
      bbox: f.bbox,
      platform: props.platform || null,
      productType: props['sar:product_type'] || props['s2:product_type'] || props.productType || null,
      cloudCoverPct: Number.isFinite(Number(props['eo:cloud_cover'])) ? Number(props['eo:cloud_cover']) : null,
      thumbnail: f?.assets?.thumbnail?.href || null,
    });
  }
  // Newest acquisition first.
  items.sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
  return { count: items.length, items };
}

/** POST the STAC search + normalize. Returns null on any failure. */
export async function fetchSentinelAcquisitions(query, fetchFn = fetch) {
  try {
    const res = await fetchFn(CDSE_STAC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildStacQuery(query)),
    });
    if (!res?.ok) return null;
    return normalizeStacItems(await res.json());
  } catch {
    return null;
  }
}
