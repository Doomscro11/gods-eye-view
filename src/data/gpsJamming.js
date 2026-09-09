// src/data/gpsJamming.js
/**
 * GNSS-interference indication from ADS-B navigation accuracy.
 *
 * Principle: aircraft continuously broadcast how much they trust their own
 * position (NACp — Navigation Accuracy Category for Position). GNSS jamming,
 * spoofing, receiver faults, coverage effects, and other conditions can reduce
 * that trust. A geographic cell where an unusual share of aircraft report
 * degraded accuracy is therefore an INTERFERENCE INDICATION, not direct proof
 * that a jammer exists.
 *
 * This is a statistical detector over public ADS-B. It observes a fleet-level
 * navigation-accuracy symptom; it does not identify an emitter or determine
 * intent/cause by itself.
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
  gridSizeDeg: 1.0,
  nacpDegradedMax: 6,
  minRatio: 0.25,
  minAircraft: 5,
});

export const JAM_ZONE_SEVERITY = Object.freeze({
  critical: { minRatio: 0.60, minDegraded: 10 },
  warning: { minRatio: 0.40, minDegraded: 5 },
});

export const GNSS_INTERFERENCE_ASSESSMENT = 'GNSS interference indication';
export const GNSS_INTERFERENCE_DERIVATION = 'gnss-interference-nacp-v1';

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
 * Detect candidate GNSS-interference indications from raw ADS-B aircraft records.
 *
 * The legacy object/id vocabulary (`gps-jam:*`, `gps-jam-zone`) is retained for
 * API compatibility. Analyst-facing semantics are deliberately less
 * definitive: the output is evidence of clustered navigation degradation, not
 * proof of jamming or spoofing.
 *
 * Confidence is intentionally null until the detector is calibrated against
 * known-positive/known-negative events. Severity is not a probability.
 *
 * @param {Array<{lat:number, lon:number, nac_p?:number}>} records Raw records
 * @returns {Array<object>} Zones sorted critical-first, then by cell key.
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
      assessment: GNSS_INTERFERENCE_ASSESSMENT,
      evidenceType: 'ads-b-nacp-cluster',
      causeDetermined: false,
      provenance: {
        provider: 'ADS-B navigation accuracy observations',
        derived: true,
        derivation: GNSS_INTERFERENCE_DERIVATION,
        sourceIds: [],
        confidence: null,
        freshness: 'live',
      },
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
