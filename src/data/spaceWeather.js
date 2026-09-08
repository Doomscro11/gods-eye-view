// src/data/spaceWeather.js
/**
 * NOAA SWPC space weather — planetary K-index and the R/S/G storm scales.
 * Public domain US government data, keyless, CORS-enabled JSON.
 *
 * One non-spatial object in the ontology; it matters because geomagnetic
 * storms degrade the same GNSS and HF links the jamming layer watches —
 * "degraded nav with a G3 in progress" reads differently than jamming.
 *
 * Pure normalize + injectable fetch. @module data/spaceWeather
 */

export const SWPC_KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
export const SWPC_SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';

/**
 * Latest planetary K-index from the SWPC product (rows after the header:
 * [time_tag, kp, a_running, station_count]).
 * @returns {{timeTag:string, kp:number, stationCount:number|null}|null}
 */
export function normalizeKpIndex(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  for (let i = rows.length - 1; i >= 1; i -= 1) {
    const row = rows[i];
    const kp = Number(row?.[1]);
    if (!Number.isFinite(kp)) continue;
    const stations = Number(row?.[3]);
    return {
      timeTag: String(row?.[0] || ''),
      kp,
      stationCount: Number.isFinite(stations) ? stations : null,
    };
  }
  return null;
}

/**
 * Current R/S/G scales from the noaa-scales product (object keyed by
 * "0","-1","1" day offsets; each has R/S/G with Scale + Text).
 * @returns {{R:number, S:number, G:number, stamp:string|null}}
 */
export function normalizeScales(payload) {
  const day0 = payload?.['0'] || payload?.[0] || null;
  const read = (k) => {
    const n = Number(day0?.[k]?.Scale);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    R: read('R'),
    S: read('S'),
    G: read('G'),
    stamp: day0?.DateStamp && day0?.TimeStamp ? `${day0.DateStamp} ${day0.TimeStamp}` : null,
  };
}

/** G-scale severity mapping for the alert rule. */
export function spaceWeatherSeverity(gScale) {
  if (gScale >= 4) return 'critical';
  if (gScale >= 3) return 'warning';
  if (gScale >= 1) return 'watch';
  return 'info';
}

/** Fetch both products + normalize. Returns null on any failure. */
export async function fetchSpaceWeather(fetchFn = fetch) {
  try {
    const [kpRes, scalesRes] = await Promise.all([fetchFn(SWPC_KP_URL), fetchFn(SWPC_SCALES_URL)]);
    if (!kpRes?.ok || !scalesRes?.ok) return null;
    const kp = normalizeKpIndex(await kpRes.json());
    const scales = normalizeScales(await scalesRes.json());
    if (!kp) return null;
    return {
      id: 'space-weather:current',
      ...kp,
      ...scales,
      severity: spaceWeatherSeverity(scales.G),
    };
  } catch {
    return null;
  }
}
