// src/ontology/spatialCandidates.js
/**
 * Conservative geographic candidate index for ontology proximity relations.
 *
 * The grid NEVER decides whether two objects are near. It only removes pairs
 * that cannot possibly be within the supplied maximum radius; callers still
 * run the exact haversine/type-specific test. Longitude search windows expand
 * with latitude and become global at the poles, so the optimization is allowed
 * to lose performance in pathological geometry but not correctness.
 *
 * @module ontology/spatialCandidates
 */

const KM_PER_LAT_DEG = 110.574;
const KM_PER_LON_DEG_EQUATOR = 111.320;
const DEFAULT_CELL_DEG = 5;
const EPSILON_DEG = 1e-9;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLon(lon) {
  let value = Number(lon);
  while (value < -180) value += 360;
  while (value >= 180) value -= 360;
  return value;
}

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Conservative longitude span in degrees for a radius around `lat`.
 * Uses the highest absolute latitude reachable inside the latitude radius,
 * where a degree of longitude is shortest. Crossing a pole means every
 * longitude is potentially relevant.
 */
export function longitudeRadiusDeg(lat, radiusKm) {
  if (!Number.isFinite(lat) || !Number.isFinite(radiusKm) || radiusKm <= 0) return 0;
  const latRadius = radiusKm / KM_PER_LAT_DEG;
  const maxAbsLat = Math.max(Math.abs(lat - latRadius), Math.abs(lat + latRadius));
  if (maxAbsLat >= 90) return 180;
  const cos = Math.cos((maxAbsLat * Math.PI) / 180);
  if (cos <= 1e-12) return 180;
  return Math.min(180, radiusKm / (KM_PER_LON_DEG_EQUATOR * cos) + EPSILON_DEG);
}

/**
 * Return index pairs that MAY be within `maxRadiusKm`.
 *
 * Input objects need finite `lat`/`lon`. Output pairs are unique, ordered
 * `[lowerIndex, higherIndex]`, and deterministic by index order.
 */
export function spatialCandidatePairs(objects, maxRadiusKm, { cellSizeDeg = DEFAULT_CELL_DEG } = {}) {
  if (!Array.isArray(objects) || objects.length < 2) return [];
  if (!Number.isFinite(maxRadiusKm) || maxRadiusKm <= 0) return [];
  if (!Number.isFinite(cellSizeDeg) || cellSizeDeg <= 0 || cellSizeDeg > 180) {
    throw new RangeError('cellSizeDeg must be > 0 and <= 180');
  }

  const latCells = Math.ceil(180 / cellSizeDeg);
  const lonCells = Math.ceil(360 / cellSizeDeg);
  const grid = new Map();

  const latCellFor = (lat) => clamp(
    Math.floor((clamp(lat, -90, 90 - Number.EPSILON) + 90) / cellSizeDeg),
    0,
    latCells - 1,
  );
  const lonCellFor = (lon) => clamp(
    Math.floor((normalizeLon(lon) + 180) / cellSizeDeg),
    0,
    lonCells - 1,
  );
  const keyFor = (latCell, lonCell) => `${latCell}:${lonCell}`;

  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    if (!Number.isFinite(object?.lat) || !Number.isFinite(object?.lon)) continue;
    const key = keyFor(latCellFor(object.lat), lonCellFor(object.lon));
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(index);
  }

  const latRadiusDeg = maxRadiusKm / KM_PER_LAT_DEG + EPSILON_DEG;
  const seen = new Set();
  const pairs = [];

  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    if (!Number.isFinite(object?.lat) || !Number.isFinite(object?.lon)) continue;

    const minLatCell = latCellFor(object.lat - latRadiusDeg);
    const maxLatCell = latCellFor(object.lat + latRadiusDeg);
    const lonRadius = longitudeRadiusDeg(object.lat, maxRadiusKm);

    let lonCellCandidates;
    if (lonRadius >= 180) {
      lonCellCandidates = Array.from({ length: lonCells }, (_, value) => value);
    } else {
      const center = lonCellFor(object.lon);
      const span = Math.ceil(lonRadius / cellSizeDeg) + 1;
      const unique = new Set();
      for (let offset = -span; offset <= span; offset += 1) {
        unique.add((center + offset + lonCells) % lonCells);
      }
      lonCellCandidates = [...unique];
    }

    for (let latCell = minLatCell; latCell <= maxLatCell; latCell += 1) {
      for (const lonCell of lonCellCandidates) {
        for (const otherIndex of grid.get(keyFor(latCell, lonCell)) || []) {
          if (otherIndex <= index) continue;
          const key = pairKey(index, otherIndex);
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push([index, otherIndex]);
        }
      }
    }
  }

  pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  return pairs;
}
