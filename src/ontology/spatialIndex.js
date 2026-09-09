const EARTH_RADIUS_KM = 6371.0088;

function finitePoint(object) {
  return object && Number.isFinite(object.lat) && Number.isFinite(object.lon);
}

function ecefKm(latDeg, lonDeg) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const cosLat = Math.cos(lat);
  return {
    x: EARTH_RADIUS_KM * cosLat * Math.cos(lon),
    y: EARTH_RADIUS_KM * cosLat * Math.sin(lon),
    z: EARTH_RADIUS_KM * Math.sin(lat),
  };
}

function cellKey(x, y, z, cellSizeKm) {
  return `${Math.floor(x / cellSizeKm)}:${Math.floor(y / cellSizeKm)}:${Math.floor(z / cellSizeKm)}`;
}

/**
 * Return conservative candidate index pairs for any two points that could be
 * within `maxRadiusKm` great-circle distance of one another.
 *
 * The index uses Earth-centred Cartesian coordinates rather than latitude /
 * longitude buckets, so dateline and polar wrapping require no special cases.
 * For any pair whose surface distance is <= R, its straight-line chord is also
 * <= R. With an R-wide Cartesian grid, the two points therefore occupy the
 * same cell or one of the 26 immediately adjacent cells. Precise haversine
 * filtering remains the caller's responsibility.
 *
 * This turns the ontology's normal relationship search from all-pairs O(n²)
 * into roughly O(n + local_candidates) while remaining lossless for NEAR.
 */
export function spatialCandidatePairs(objects, maxRadiusKm) {
  if (!Number.isFinite(maxRadiusKm) || maxRadiusKm <= 0) return [];
  const cellSizeKm = maxRadiusKm;
  const buckets = new Map();
  const coords = new Array(objects.length);

  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i];
    if (!finitePoint(object)) continue;
    const point = ecefKm(object.lat, object.lon);
    coords[i] = point;
    const key = cellKey(point.x, point.y, point.z, cellSizeKm);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  const pairs = [];
  for (let i = 0; i < objects.length; i += 1) {
    const point = coords[i];
    if (!point) continue;
    const ix = Math.floor(point.x / cellSizeKm);
    const iy = Math.floor(point.y / cellSizeKm);
    const iz = Math.floor(point.z / cellSizeKm);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = buckets.get(`${ix + dx}:${iy + dy}:${iz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j > i) pairs.push([i, j]);
          }
        }
      }
    }
  }
  return pairs;
}
