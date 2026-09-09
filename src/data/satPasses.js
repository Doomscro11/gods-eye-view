// src/data/satPasses.js
/**
 * Generalized satellite pass engine — the orbital layer for ANY satellite,
 * built on the same satellite.js primitives as issPass.js (which stays the
 * voice-answer fast path). Pure module: no Cesium, no DOM, no fetches.
 *
 * Four capabilities:
 *  - `listPasses`    — the next N passes over a ground point (rise/max/set)
 *  - `groundTrack`   — subpoint track over a window, split at the antimeridian
 *  - `footprintAt`   — the visibility circle under the satellite right now
 *  - `coversAt`      — is a ground point inside that circle
 *
 * The footprint math is the horizon geometry: at elevation 0 the central
 * angle λ from subpoint to limb satisfies cos λ = Re / (Re + h).
 *
 * @module data/satPasses
 */

import { propagate, gstime, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';
import { findNextIssPass } from './issPass.js';

export const EARTH_RADIUS_KM = 6378.137;

const D2R = Math.PI / 180;

/** Geodetic subpoint + altitude at an instant, or null on propagation failure. */
export function subpointAt(satrec, dateMs) {
  const pv = propagate(satrec, new Date(dateMs));
  const pos = pv && pv.position;
  if (!pos || typeof pos === 'boolean') return null;
  const geo = eciToGeodetic(pos, gstime(new Date(dateMs)));
  if (!geo || !Number.isFinite(geo.latitude)) return null;
  return {
    latDeg: degreesLat(geo.latitude),
    lonDeg: degreesLong(geo.longitude),
    altKm: geo.height,
  };
}

/** Angular radius (deg) of the zero-elevation footprint at altitude h km. */
export function footprintRadiusDeg(altKm) {
  if (!Number.isFinite(altKm) || altKm <= 0) return 0;
  return (Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm))) / D2R;
}

/** Central angle (deg) between two ground points (haversine form). */
export function centralAngleDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R;
  const dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / D2R;
}

/**
 * The satellite's current visibility circle: everything on the surface within
 * `radiusDeg` of the subpoint can see it above the horizon (and vice versa).
 * @returns {{latDeg:number, lonDeg:number, altKm:number, radiusDeg:number, radiusKm:number}|null}
 */
export function footprintAt(satrec, dateMs) {
  const sub = subpointAt(satrec, dateMs);
  if (!sub) return null;
  const radiusDeg = footprintRadiusDeg(sub.altKm);
  return { ...sub, radiusDeg, radiusKm: radiusDeg * D2R * EARTH_RADIUS_KM };
}

/** Is a ground point inside the satellite's footprint at `dateMs`? */
export function coversAt(satrec, dateMs, latDeg, lonDeg) {
  const fp = footprintAt(satrec, dateMs);
  if (!fp || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return false;
  return centralAngleDeg(fp.latDeg, fp.lonDeg, latDeg, lonDeg) <= fp.radiusDeg;
}

/**
 * The next `count` passes over a ground point. Reuses the issPass scanner,
 * advancing the search past each pass's set time. A decaying/deep-space
 * satrec yields fewer than `count` — callers get what the orbit gives.
 * @returns {Array<{riseMs:number, setMs:number, maxElevMs:number, maxElevDeg:number, riseAzDeg:number}>}
 */
export function listPasses({
  satrec, latDeg, lonDeg, fromMs,
  count = 5, minElevDeg = 10, horizonHours = 24,
  coarseStepSec = 30, fineStepSec = 5,
}) {
  const passes = [];
  let cursor = fromMs;
  for (let i = 0; i < count; i += 1) {
    const pass = findNextIssPass({
      satrec, latDeg, lonDeg, fromMs: cursor,
      minElevDeg, horizonHours, coarseStepSec, fineStepSec,
    });
    if (!pass) break;
    passes.push(pass);
    // Next search starts after this pass sets (+ one coarse step so a pass
    // whose set equals its rise at grazing geometry can't repeat forever).
    cursor = Math.max(pass.setMs, pass.riseMs) + coarseStepSec * 1000;
  }
  return passes;
}

/**
 * Subpoint ground track over a window, as segments split wherever the track
 * jumps more than 180° in longitude (antimeridian crossing) or propagation
 * fails — renderers get clean polylines, never a streak across the globe.
 * @returns {Array<Array<{t:number, latDeg:number, lonDeg:number, altKm:number}>>}
 */
export function groundTrack({ satrec, fromMs, durationSec, stepSec = 30 }) {
  const segments = [];
  let current = [];
  let prevLon = null;
  const endMs = fromMs + durationSec * 1000;
  for (let t = fromMs; t <= endMs; t += stepSec * 1000) {
    const sub = subpointAt(satrec, t);
    if (!sub) {
      if (current.length > 1) segments.push(current);
      current = [];
      prevLon = null;
      continue;
    }
    if (prevLon != null && Math.abs(sub.lonDeg - prevLon) > 180) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push({ t, ...sub });
    prevLon = sub.lonDeg;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
