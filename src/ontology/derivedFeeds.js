// src/ontology/derivedFeeds.js
/**
 * Phase 5 bridge: derived feeds (GPS jamming, EONET, KEV, space weather,
 * Sentinel acquisitions) enter the ontology as first-class objects, and the
 * orbital layer derives COVERS edges between satellites and the ground
 * picture.
 *
 * These feeds have no Cesium layer module with `getAnalystRecords()` — they
 * are computed or fetched on their own cadence — so they sync through
 * `syncDerivedFeeds` instead of the layer seam in liveSync. Same invariants:
 * mark-and-sweep eviction per layer key, lossless attrs, event log entries.
 *
 * COVERS derivation is O(satellites × watched fixtures) — fixtures are
 * regions, installations, and jam zones (handfuls), not the whole store.
 *
 * @module ontology/derivedFeeds
 */

import { coversAt } from '../data/satPasses.js';
import { RELATIONSHIP } from './store.js';

/** Map of sync key → {type, layerKey, pick(feedResult)} for the feed sync. */
export const DERIVED_FEED_TYPES = Object.freeze({
  jamZones: { layerKey: 'gps-jamming' },
  eonet: { layerKey: 'eonet' },
  kev: { layerKey: 'cisa-kev' },
  spaceWeather: { layerKey: 'space-weather' },
  sentinel: { layerKey: 'sentinel' },
});

function recordsFor(key, value) {
  if (!value) return [];
  switch (key) {
    case 'jamZones': return value; // detectGpsJamZones output array
    case 'eonet': return value.items || [];
    case 'kev': return (value.items || []).slice(0, 100); // newest hundred is plenty
    case 'spaceWeather': return [value];
    case 'sentinel': return value.items || [];
    default: return [];
  }
}

/**
 * Sync one cycle of derived-feed results into the store. Each key is
 * optional; a key ABSENT from `feeds` is untouched (feed didn't run), a key
 * present with an empty result evicts its layer (feed ran, found nothing).
 * @returns {object} {synced: {layerKey: count}}
 */
export function syncDerivedFeeds(store, feeds = {}) {
  const synced = {};
  for (const [key, spec] of Object.entries(DERIVED_FEED_TYPES)) {
    if (!(key in feeds)) continue;
    const upserted = store.upsertFromLayer(spec.layerKey, recordsFor(key, feeds[key]));
    synced[spec.layerKey] = upserted.length;
    synced[`${spec.layerKey}:evicted`] = store.evictAbsentFromLayer(
      spec.layerKey, upserted.map((o) => o.id),
    ).length;
  }
  return { synced };
}

/**
 * Build a COVERS deriver for the store's `relationshipDerivers` option.
 * `getSatrecs` returns catalog entries ({noradId, satrec}) — the Phase 5
 * runtime owns it via its TLE tap; this deriver reads it.
 * An edge lands when a watched fixture sits inside a satellite's current
 * zero-elevation footprint.
 * @param {object} opts
 * @param {() => Array<{noradId:(string|number), satrec:object}>} opts.getSatrecs
 * @param {() => number} [opts.atMs] Clock for the footprint instant.
 * @param {string[]} [opts.coveredTypes] Fixture types that can be covered.
 */
export function coversDeriver({
  getSatrecs,
  atMs = Date.now,
  coveredTypes = ['region', 'installation', 'gps-jam-zone'],
} = {}) {
  return (list, setRelationship) => {
    if (typeof getSatrecs !== 'function') return;
    const fixtures = list.filter((o) => coveredTypes.includes(o.type));
    if (!fixtures.length) return;
    const satByNorad = new Map(
      list.filter((o) => o.type === 'satellite')
        .map((o) => [String(o.attrs?.noradId ?? o.attrs?.id ?? ''), o]),
    );
    const t = atMs();
    for (const entry of getSatrecs() || []) {
      const satrec = entry?.satrec;
      if (!satrec) continue;
      const satObject = satByNorad.get(String(entry.noradId));
      if (!satObject) continue; // satellite not in the picture → no edges
      for (const fixture of fixtures) {
        if (coversAt(satrec, t, fixture.lat, fixture.lon)) {
          setRelationship(satObject.id, RELATIONSHIP.COVERS, fixture.id, {
            atMs: t,
          });
        }
      }
    }
  };
}
