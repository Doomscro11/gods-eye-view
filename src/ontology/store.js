/**
 * Ontology store — the nouns and verbs of the operating picture.
 *
 * Doctrine (owner-ratified, palantir-doctrine Tier 1):
 *  - Layers are a RENDERING choice; the ontology is the system. Every feed
 *    normalizes into typed OBJECTS (Aircraft, Vessel, Satellite, Fire, Quake,
 *    Installation, WeatherCell, Region) with stable identities and
 *    RELATIONSHIPS (near, transits, threatens, covers). Surfaces — the
 *    analyst engine, context store, detection brackets, briefs — read the
 *    objects, never the raw layer arrays.
 *  - The store keeps an append-only EVENT LOG so the picture is a LIVING
 *    digital twin: state can be replayed, diffed, and branched (see
 *    src/scenario/engine.js and src/replay/engine.js).
 *  - ACTIONS are first-class (the verbs). They are declared here with their
 *    guardrails and invoked through `applyAction`, so an alert, a voice
 *    command, and a scenario edit all travel the same governed path.
 *
 * Purity: this module renders nothing, fetches nothing, and touches no DOM.
 * Time is injected (`now()`) so tests are deterministic.
 *
 * @module ontology/store
 */

import { haversineKm } from '../data/analystEngine.js';
import { pointInRing } from '../data/naturalEarthRegions.js';

/** Object types the picture understands, and which feeds birth them. */
export const OBJECT_TYPES = Object.freeze({
  aircraft: { layerKeys: ['flights', 'military'], idFields: ['icao24', 'callsign', 'id'] },
  vessel: { layerKeys: ['ais-live-vessels'], idFields: ['mmsi', 'name', 'id'] },
  satellite: { layerKeys: ['satellites'], idFields: ['noradId', 'name', 'id'] },
  fire: { layerKeys: ['local-firms'], idFields: ['id'] },
  quake: { layerKeys: ['earthquakes'], idFields: ['id'] },
  installation: { layerKeys: [], idFields: ['id'] },
  'weather-cell': { layerKeys: [], idFields: ['id'] },
  region: { layerKeys: [], idFields: ['id'] },
});

/** Relationship kinds the store derives between objects. */
export const RELATIONSHIP = Object.freeze({
  NEAR: 'near',
  INSIDE: 'inside',
  THREATENS: 'threatens',
  COVERS: 'covers',
});

/** Default radii (km) for derived NEAR relationships, by type pair. */
export const DEFAULT_NEAR_RADIUS_KM = Object.freeze({
  'aircraft:installation': 250,
  'vessel:installation': 250,
  'aircraft:weather-cell': 100,
  'vessel:weather-cell': 100,
  'fire:region': 0, // 0 = derived via INSIDE on the region ring instead
  default: 50,
});

/** Mobile types originate relationship edges (mover → fixture). */
const MOBILE_TYPES = new Set(['aircraft', 'vessel', 'satellite']);

const DEFAULT_EVENT_CAPACITY = 5000;

function stableObjectId(type, record) {
  const spec = OBJECT_TYPES[type];
  for (const field of spec?.idFields || ['id']) {
    if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
      return `${type}:${String(record[field])}`;
    }
  }
  return null;
}

function typeForLayerKey(layerKey) {
  for (const [type, spec] of Object.entries(OBJECT_TYPES)) {
    if (spec.layerKeys.includes(layerKey)) return type;
  }
  return null;
}

function nearRadiusFor(typeA, typeB, overrides) {
  return overrides[`${typeA}:${typeB}`]
    ?? overrides[`${typeB}:${typeA}`]
    ?? DEFAULT_NEAR_RADIUS_KM[`${typeA}:${typeB}`]
    ?? DEFAULT_NEAR_RADIUS_KM[`${typeB}:${typeA}`]
    ?? DEFAULT_NEAR_RADIUS_KM.default;
}

/**
 * Create an ontology store.
 * @param {object} [options]
 * @param {() => number} [options.now] Clock, ms epoch. Defaults to Date.now.
 * @param {number} [options.eventCapacity] Ring-buffer capacity for the log.
 * @param {object} [options.nearRadiusKm] Pair overrides for NEAR derivation.
 */
export function createOntologyStore({
  now = Date.now,
  eventCapacity = DEFAULT_EVENT_CAPACITY,
  nearRadiusKm = {},
} = {}) {
  /** @type {Map<string, object>} id → object */
  const objects = new Map();
  /** @type {Map<string, object>} "a|kind|b" → relationship */
  const relationships = new Map();
  /** Append-only event log (ring buffer). */
  const events = [];
  let eventSeq = 0;
  let droppedEvents = 0;
  /** Verb registry: name → {handler, guard} */
  const actions = new Map();

  function appendEvent(kind, payload) {
    const event = { seq: ++eventSeq, t: now(), kind, ...payload };
    events.push(event);
    if (events.length > eventCapacity) {
      events.shift();
      droppedEvents += 1;
    }
    return event;
  }

  /**
   * Insert or update one typed object. `attrs` keeps the ORIGINAL record
   * fields so surfaces lose nothing by reading the ontology instead of the
   * layer (lossless normalization).
   * @returns {object|null} The stored object, or null when identity fails.
   */
  function upsertObject(type, record, { layerKey = null } = {}) {
    if (!OBJECT_TYPES[type] || !record) return null;
    const id = record.__ontologyId || stableObjectId(type, record);
    if (!id) return null;
    const existing = objects.get(id);
    const object = {
      id,
      type,
      layerKey: layerKey ?? existing?.layerKey ?? null,
      lat: Number.isFinite(record.lat) ? record.lat : existing?.lat ?? null,
      lon: Number.isFinite(record.lon) ? record.lon : existing?.lon ?? null,
      attrs: { ...existing?.attrs, ...record },
      ring: record.ring ?? existing?.ring ?? null, // regions carry a boundary
      updatedAt: now(),
      createdAt: existing?.createdAt ?? now(),
    };
    delete object.attrs.__ontologyId;
    objects.set(id, object);
    appendEvent('upsert', { objectId: id, objectType: type, object });
    return object;
  }

  /**
   * Normalize a layer's record array into objects. Returns the objects so a
   * surface can swap `getRecords(layerKey)` for `objectsForLayer(layerKey)`
   * one seam at a time.
   */
  function upsertFromLayer(layerKey, records) {
    const type = typeForLayerKey(layerKey);
    if (!type) return [];
    const out = [];
    for (const record of records || []) {
      const object = upsertObject(type, record, { layerKey });
      if (object) out.push(object);
    }
    return out;
  }

  /**
   * Mark-and-sweep eviction: after a layer sync, drop objects of that layer
   * whose records no longer exist. Viewport-scoped feeds (flights) shrink
   * constantly — without this the store accumulates ghosts and rules fire on
   * contacts that left the picture. Evictions log reason 'feed-evicted' so
   * replay distinguishes feed churn from scenario edits.
   * @returns {string[]} Evicted object ids.
   */
  function evictAbsentFromLayer(layerKey, keepIds) {
    const keep = new Set(keepIds);
    const evicted = [];
    for (const object of objects.values()) {
      if (object.layerKey !== layerKey || keep.has(object.id)) continue;
      if (removeObject(object.id, { reason: 'feed-evicted' })) evicted.push(object.id);
    }
    return evicted;
  }

  function removeObject(id, { reason = 'removed' } = {}) {
    if (!objects.delete(id)) return false;
    for (const [key, rel] of relationships) {
      if (rel.fromId === id || rel.toId === id) relationships.delete(key);
    }
    appendEvent('remove', { objectId: id, reason });
    return true;
  }

  /**
   * Recompute derived relationships from current positions and rings.
   * Deterministic and total: relationships not re-derived are dropped, so a
   * contact leaving a radius never leaves a stale edge behind.
   * @returns {Map<string, object>} The rebuilt relationship set.
   */
  function recomputeRelationships() {
    relationships.clear();
    const list = [...objects.values()].filter(
      (o) => Number.isFinite(o.lat) && Number.isFinite(o.lon),
    );
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.type === b.type) continue; // relationships are cross-type
        // INSIDE: point object within a region ring beats a radius guess.
        const region = a.ring ? a : b.ring ? b : null;
        const point = region === a ? b : a;
        if (region && point !== region && Number.isFinite(point.lat)
            && pointInRing(region.ring, point.lat, point.lon)) {
          setRelationship(point.id, RELATIONSHIP.INSIDE, region.id, { distanceKm: 0 });
          continue;
        }
        const km = nearRadiusFor(a.type, b.type, nearRadiusKm);
        if (km <= 0) continue;
        const distanceKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
        if (distanceKm <= km) {
          // Orient the edge mover → fixture so "what is near X" reads from
          // the object that is DOING something (alert subjects, briefs).
          const aMobile = MOBILE_TYPES.has(a.type);
          const bMobile = MOBILE_TYPES.has(b.type);
          const from = aMobile && !bMobile ? a : bMobile && !aMobile ? b : a;
          const to = from === a ? b : a;
          setRelationship(from.id, RELATIONSHIP.NEAR, to.id, {
            distanceKm: Math.round(distanceKm * 10) / 10,
          });
        }
      }
    }
    appendEvent('relationships', { count: relationships.size });
    return relationships;
  }

  function setRelationship(fromId, kind, toId, extra = {}) {
    const key = `${fromId}|${kind}|${toId}`;
    relationships.set(key, { fromId, kind, toId, ...extra });
  }

  function relationshipsFor(objectId, { kind = null } = {}) {
    const out = [];
    for (const rel of relationships.values()) {
      if (kind && rel.kind !== kind) continue;
      if (rel.fromId === objectId || rel.toId === objectId) out.push(rel);
    }
    return out;
  }

  /**
   * Declare a verb. `guard(object, params, store)` returns true or a string
   * explaining the refusal — guardrails live WITH the action, not in the UI.
   */
  function defineAction(name, { handler, guard = null } = {}) {
    if (!name || typeof handler !== 'function') return false;
    actions.set(name, { handler, guard });
    return true;
  }

  /**
   * Invoke a verb through its guardrail. Every surface — alert button, voice
   * command, scenario edit — takes this one governed path.
   */
  function applyAction(name, { objectId = null, params = {} } = {}) {
    const action = actions.get(name);
    if (!action) return { ok: false, error: `unknown action: ${name}` };
    const object = objectId ? objects.get(objectId) : null;
    if (objectId && !object) return { ok: false, error: `unknown object: ${objectId}` };
    if (action.guard) {
      const verdict = action.guard(object, params, api);
      if (verdict !== true) {
        return { ok: false, error: typeof verdict === 'string' ? verdict : 'guard refused' };
      }
    }
    let result;
    try {
      result = action.handler(object, params, api);
    } catch (err) {
      // The governed path must never throw past the store: log the failure
      // in the audit trail and return it.
      appendEvent('action', {
        action: name, objectId, ok: false, error: String(err?.message || err),
      });
      return { ok: false, error: String(err?.message || err) };
    }
    appendEvent('action', { action: name, objectId, ok: result?.ok !== false });
    return result ?? { ok: true };
  }

  /**
   * Deep-enough snapshot for scenario branching: objects and relationships
   * are plain data, so structuredClone is exact. The event log is shared
   * history and NOT copied — a branch reads the same past, writes its own
   * staged future (see scenario engine).
   */
  function snapshot() {
    return {
      objects: structuredClone([...objects.values()]),
      relationships: structuredClone([...relationships.values()]),
      eventSeq,
    };
  }

  function restore(snap) {
    objects.clear();
    relationships.clear();
    for (const object of snap.objects || []) objects.set(object.id, object);
    for (const rel of snap.relationships || []) {
      relationships.set(`${rel.fromId}|${rel.kind}|${rel.toId}`, rel);
    }
  }

  const api = {
    upsertObject,
    /** Append an audit/marker event (scenario commits, operator notes). */
    recordEvent: (kind, payload = {}) => appendEvent(kind, payload),
    evictAbsentFromLayer,
    upsertFromLayer,
    removeObject,
    getObject: (id) => objects.get(id) ?? null,
    objectsOfType: (type) => [...objects.values()].filter((o) => o.type === type),
    objectsForLayer: (layerKey) => [...objects.values()].filter((o) => o.layerKey === layerKey),
    allObjects: () => [...objects.values()],
    countsByType: () => {
      const counts = {};
      for (const o of objects.values()) counts[o.type] = (counts[o.type] || 0) + 1;
      return counts;
    },
    recomputeRelationships,
    relationshipsFor,
    allRelationships: () => [...relationships.values()],
    defineAction,
    applyAction,
    listActions: () => [...actions.keys()],
    getEvents: ({ since = 0, kind = null } = {}) => events.filter(
      (e) => e.seq > since && (!kind || e.kind === kind),
    ),
    lastEventSeq: () => eventSeq,
    droppedEventCount: () => droppedEvents,
    snapshot,
    restore,
  };
  return api;
}
