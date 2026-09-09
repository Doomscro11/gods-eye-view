// src/ontology/jamZoneOverlay.js
/**
 * GNSS-interference indication globe overlay — the visible surface of the
 * Phase 5 navigation-degradation detector.
 *
 * Legacy `gps-jam-zone` object/type names are retained for compatibility, but
 * the analyst-facing surface does not assert that a jammer exists. The
 * detector observes clustered ADS-B navigation-accuracy degradation, which is
 * evidence consistent with interference and can have other causes.
 *
 * Split per repo convention: pure helpers (zoneBounds, zoneLabel,
 * severityColor, planZoneSync) are node-testable; createJamZoneOverlay is
 * the thin Cesium-bound shell. Mark-and-sweep mirrors the ontology: a zone
 * that leaves the store leaves the globe.
 *
 * @module ontology/jamZoneOverlay
 */

import * as Cesium from 'cesium';

/**
 * Severity → RGB spec. Alphas are applied at render time (fill vs outline)
 * so the spec stays color-only and unit-testable.
 */
export const JAM_ZONE_COLORS = Object.freeze({
  critical: Object.freeze({ red: 1.0, green: 0.16, blue: 0.12 }),
  warning: Object.freeze({ red: 1.0, green: 0.55, blue: 0.1 }),
  watch: Object.freeze({ red: 1.0, green: 0.85, blue: 0.2 }),
});

export const JAM_ZONE_FILL_ALPHA = 0.16;
export const JAM_ZONE_OUTLINE_ALPHA = 0.85;

/**
 * Cell bounds from a zone's center + grid size. Zones carry latDeg/lonDeg as
 * the CELL CENTER (see gpsJamming.js), so bounds are center ± size/2.
 * @returns {{west:number, south:number, east:number, north:number}|null}
 */
export function zoneBounds(zone) {
  if (!zone || !Number.isFinite(zone.latDeg) || !Number.isFinite(zone.lonDeg)) return null;
  const size = Number.isFinite(zone.gridSizeDeg) && zone.gridSizeDeg > 0 ? zone.gridSizeDeg : 1;
  const half = size / 2;
  return {
    west: zone.lonDeg - half,
    south: zone.latDeg - half,
    east: zone.lonDeg + half,
    north: zone.latDeg + half,
  };
}

/** Compact, evidence-honest readout for the entity label/description. */
export function zoneLabel(zone) {
  if (!zone) return 'GNSS INTERFERENCE INDICATION';
  const pct = Number.isFinite(zone.ratio) ? ` · ${Math.round(zone.ratio * 100)}% degraded` : '';
  const counts = Number.isFinite(zone.degraded) && Number.isFinite(zone.known)
    ? ` (${zone.degraded}/${zone.known})` : '';
  return `GNSS INTERFERENCE INDICATION · ${zone.severity || 'watch'}${pct}${counts}`;
}

/**
 * Diff plan between rendered zone ids and the current store picture.
 * Pure: the overlay applies it, tests assert it.
 * @returns {{add: object[], remove: string[], keep: string[]}}
 */
export function planZoneSync(renderedIds, zones) {
  const rendered = new Set(renderedIds);
  const current = new Set();
  const add = [];
  for (const zone of zones || []) {
    if (!zone || !zone.id || !zoneBounds(zone)) continue;
    current.add(zone.id);
    if (!rendered.has(zone.id)) add.push(zone);
  }
  const remove = [...rendered].filter((id) => !current.has(id));
  const keep = [...current].filter((id) => rendered.has(id));
  return { add, remove, keep };
}

function severityColor(severity, alpha) {
  const spec = JAM_ZONE_COLORS[severity] ?? JAM_ZONE_COLORS.watch;
  return new Cesium.Color(spec.red, spec.green, spec.blue, alpha);
}

/**
 * Create the overlay. Polls `store.objectsOfType('gps-jam-zone')` and keeps
 * one rectangle entity per zone, refreshed in place on severity/geometry
 * changes and removed when the zone evicts. Fail-soft: a throwing poll is
 * logged, never thrown past the timer.
 * @returns {{sync(): void, destroy(): void, entityCount(): number}}
 */
export function createJamZoneOverlay({
  viewer,
  store,
  pollMs = 15000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!viewer || !store) return null;
  /** @type {Map<string, Cesium.Entity>} zone id → entity */
  const rendered = new Map();

  function upsertZoneEntity(zone) {
    const bounds = zoneBounds(zone);
    const severity = zone.severity || 'watch';
    const description = zoneLabel(zone);
    const existing = rendered.get(zone.id);
    if (existing) {
      existing.rectangle.coordinates = Cesium.Rectangle.fromDegrees(
        bounds.west, bounds.south, bounds.east, bounds.north,
      );
      existing.rectangle.material = severityColor(severity, JAM_ZONE_FILL_ALPHA);
      existing.rectangle.outlineColor = severityColor(severity, JAM_ZONE_OUTLINE_ALPHA);
      existing.description = description;
      return;
    }
    const entity = viewer.entities.add({
      id: `jam-zone-overlay:${zone.id}`,
      name: description,
      description,
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(
          bounds.west, bounds.south, bounds.east, bounds.north,
        ),
        material: severityColor(severity, JAM_ZONE_FILL_ALPHA),
        outline: true,
        outlineColor: severityColor(severity, JAM_ZONE_OUTLINE_ALPHA),
        outlineWidth: 2,
        height: 0,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    rendered.set(zone.id, entity);
  }

  function sync() {
    const zones = store
      .objectsOfType('gps-jam-zone')
      .map((object) => ({ id: object.id, ...object.attrs }));
    const plan = planZoneSync([...rendered.keys()], zones);
    for (const id of plan.remove) {
      const entity = rendered.get(id);
      if (entity) viewer.entities.remove(entity);
      rendered.delete(id);
    }
    for (const zone of [...plan.add, ...zones.filter((z) => plan.keep.includes(z.id))]) {
      upsertZoneEntity(zone);
    }
    viewer.scene?.requestRender?.();
  }

  const safeSync = () => {
    try {
      sync();
    } catch (error) {
      console.warn('[JamZoneOverlay] sync failed:', error?.message || error);
    }
  };

  safeSync();
  const timer = setIntervalFn(safeSync, pollMs);

  return {
    sync: safeSync,
    entityCount: () => rendered.size,
    destroy() {
      clearIntervalFn(timer);
      for (const entity of rendered.values()) viewer.entities.remove(entity);
      rendered.clear();
    },
  };
}
