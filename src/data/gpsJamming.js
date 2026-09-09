// src/data/gpsJamming.js
/**
 * GPS-interference detection from ADS-B navigation accuracy.
 *
 * Principle: aircraft continuously broadcast how much they trust their own
 * position (NACp — Navigation Accuracy Category for Position). GNSS jamming
 * and spoofing destroy that trust, so a geographic cell where an unusual
 * share of aircraft report degraded accuracy is a candidate interference
 * zone. This is a statistical detector over public ADS-B — it cannot see a
 * jammer directly, only its footprint in the fleet's self-reported accuracy.
 *
 * NACp scale (0–11): higher is better; 6 = <0.3 NM, 8 = <0.05 NM.
 * NACp 0 means "accuracy unknown" — that is ABSENCE OF EVIDENCE, not
 * degradation, so those aircraft are excluded from the denominator entirely.
 *
 * Pure module: records in, zones out. Thresholds are GEV's own tuning.
 *
 * @module data/gpsJamming
 */

export const GPS_JAM_DEFAULTS = Object.freeze({
  gridSizeDeg: 1.0,      // aggregation cell size
  nacpDegradedMax: 6,    // NACp ≤ this (but > 0) counts as degraded
  minRatio: 0.25,        // fraction of known-accuracy aircraft degraded to flag
  minAircraft: 5,        // minimum known-accuracy aircraft per cell
});

export const JAM_ZONE_SEVERITY = Object.freeze({
  critical: { minRatio: 0.60, minDegraded: 10 },
  warning: { minRatio: 0.40, minDegraded: 5 },
  // anything above GPS_JAM_DEFAULTS.minRatio but below warning → 'watch'
});

/**
 * Per-aircraft nav-accuracy verdict.
 * @returns {'degraded'|'nominal'|'unknown'}
 */
export function navAccuracyVerdict(record, { nacpDegradedMax = GPS_JAM_DEFAULTS.nacpDegradedMax } = {}) {
  const nacp = Number(record?.nac_p ?? record?.nacP);
  if (!Number.isFinite(nacp) || nacp <= 0) return 'unknown';
  return nacp <= nacpDegradedMax ? 'degraded' : 'nominal';
}

function cellKeyFor(latDeg, lonDeg, size) {
  const latCell = Math.floor(latDeg / size);
  const lonCell = Math.floor(lonDeg / size);
  return `${latCell}:${lonCell}`;
}

/** Severity for a flagged cell from its degraded share. */
export function jamZoneSeverity(ratio, degraded, severitySpec = JAM_ZONE_SEVERITY) {
  if (ratio >= severitySpec.critical.minRatio && degraded >= severitySpec.critical.minDegraded) return 'critical';
  if (ratio >= severitySpec.warning.minRatio && degraded >= severitySpec.warning.minDegraded) return 'warning';
  return 'watch';
}

/**
 * Detect candidate interference zones from raw ADS-B aircraft records.
 * @param {Array<{lat:number, lon:number, nac_p?:number}>} records Raw records
 *   (adsb.lol field names; `nacP` camelCase also accepted).
 * @returns {Array<object>} Zones sorted critical-first, then by cell key:
 *   {id, cellKey, latDeg, lonDeg, gridSizeDeg, total, known, degraded, ratio, severity}
 */
export function detectGpsJamZones(records, options = {}) {
  const {
    gridSizeDeg, minRatio, minAircraft, nacpDegradedMax,
  } = { ...GPS_JAM_DEFAULTS, ...options };

  const cells = new Map();
  for (const rec of records || []) {
    const lat = Number(rec?.lat);
    const lon = Number(rec?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = cellKeyFor(lat, lon, gridSizeDeg);
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, latCell: Math.floor(lat / gridSizeDeg), lonCell: Math.floor(lon / gridSizeDeg), total: 0, known: 0, degraded: 0 };
      cells.set(key, cell);
    }
    cell.total += 1;
    const verdict = navAccuracyVerdict(rec, { nacpDegradedMax });
    if (verdict === 'unknown') continue;
    cell.known += 1;
    if (verdict === 'degraded') cell.degraded += 1;
  }

  const zones = [];
  for (const cell of cells.values()) {
    if (cell.known < minAircraft) continue;
    const ratio = cell.degraded / cell.known;
    if (ratio < minRatio) continue;
    zones.push({
      id: `gps-jam:${cell.key}`,
      cellKey: cell.key,
      latDeg: (cell.latCell + 0.5) * gridSizeDeg,
      lonDeg: (cell.lonCell + 0.5) * gridSizeDeg,
      gridSizeDeg,
      total: cell.total,
      known: cell.known,
      degraded: cell.degraded,
      ratio: Math.round(ratio * 1000) / 1000,
      severity: jamZoneSeverity(ratio, cell.degraded, options.severitySpec ?? JAM_ZONE_SEVERITY),
    });
  }

  const rank = { critical: 0, warning: 1, watch: 2 };
  return zones.sort((a, b) => (rank[a.severity] - rank[b.severity])
    || a.cellKey.localeCompare(b.cellKey));
}

/** Is a point inside a zone's cell? Used by the ontology exposure rule. */
export function pointInJamZone(zone, latDeg, lonDeg) {
  if (!zone || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return false;
  const size = zone.gridSizeDeg || GPS_JAM_DEFAULTS.gridSizeDeg;
  return cellKeyFor(latDeg, lonDeg, size) === zone.cellKey;
}
