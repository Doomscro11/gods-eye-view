/**
 * Ontology adapters — move existing surfaces onto the store ONE SEAM AT A
 * TIME without rewriting them.
 *
 * Two bridges:
 *  - `ontologyBackedProviders(store, baseProviders)` wraps the analyst
 *    engine's providers so `getRecords(layerKey)` answers from ontology
 *    objects (lossless — `attrs` carries the original record). The engine's
 *    query logic, scopes, and follow-up memory are untouched.
 *  - `publishContextSelection(store, metadata)` mirrors a contextStore
 *    selection into the ontology as an event, so "what is the operator
 *    looking at" becomes part of the living picture instead of a side
 *    channel.
 *
 * @module ontology/adapters
 */

import { haversineKm } from '../data/analystEngine.js';

/** Layers whose records the ontology can serve, and the fields they keep. */
export const ONTOLOGY_BACKED_LAYERS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
  'local-firms',
  'earthquakes',
  'satellites',
]);

/**
 * Wrap analyst-engine providers with an ontology-backed `getRecords`.
 * Refresh order matters: callers sync feeds into the store first
 * (`store.upsertFromLayer`), then the engine reads objects.
 */
export function ontologyBackedProviders(store, baseProviders) {
  return {
    ...baseProviders,
    getRecords(layerKey) {
      if (!ONTOLOGY_BACKED_LAYERS.includes(layerKey)) {
        return baseProviders.getRecords?.(layerKey) ?? [];
      }
      return store.objectsForLayer(layerKey).map((object) => ({
        ...object.attrs,
        lat: object.lat,
        lon: object.lon,
        id: object.attrs.id ?? object.id,
        __ontologyId: object.id,
      }));
    },
  };
}

/**
 * Mirror an operator selection into the ontology event log. The selection
 * itself stays in contextStore (its surfaces own it); the ontology records
 * THAT attention happened, which is what replay and briefs need.
 */
export function publishContextSelection(store, metadata) {
  if (!store || !metadata?.id) return null;
  const type = metadata.ontologyType || 'aircraft';
  const object = store.upsertObject(type, {
    ...metadata,
    __ontologyId: `${type}:${String(metadata.id)}`,
  }, { layerKey: metadata.layerId ?? null });
  return object;
}

/**
 * Nearest objects to a point, ontology-wide — the query every "what's near
 * X?" surface shares instead of re-implementing per layer.
 */
export function nearestObjects(store, { lat, lon, limit = 10, types = null } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return store.allObjects()
    .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon))
    .filter((o) => !types || types.includes(o.type))
    .map((o) => ({ object: o, distanceKm: haversineKm(lat, lon, o.lat, o.lon) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, Math.max(1, limit))
    .map(({ object, distanceKm }) => ({ ...object, distanceKm: Math.round(distanceKm * 10) / 10 }));
}
