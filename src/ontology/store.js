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
 *  - The store keeps a bounded EVENT LOG plus a replay baseline so the
 *    picture remains reconstructable after old events roll out of memory.
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
import { spatialCandidatePairs } from './spatialIndex.js';

export const OBJECT_TYPES = Object.freeze({
  aircraft: { layerKeys: ['flights', 'military'], idFields: ['icao24', 'callsign', 'id'] },
  vessel: { layerKeys: ['ais-live-vessels'], idFields: ['mmsi', 'name', 'id'] },
  satellite: { layerKeys: ['satellites'], idFields: ['noradId', 'name', 'id'] },
  fire: { layerKeys: ['local-firms'], idFields: ['id'] },
  quake: { layerKeys: ['earthquakes'], idFields: ['id'] },
  installation: { layerKeys: [], idFields: ['id'] },
  'weather-cell': { layerKeys: [], idFields: ['id'] },
  region: { layerKeys: [], idFields: ['id'] },
  'gps-jam-zone': { layerKeys: ['gps-jamming'], idFields: ['id'] },
  'natural-event': { layerKeys: ['eonet'], idFields: ['id'] },
  'cyber-vuln': { layerKeys: ['cisa-kev'], idFields: ['cve', 'id'] },
  'space-weather': { layerKeys: ['space-weather'], idFields: ['id'] },
  imagery: { layerKeys: ['sentinel'], idFields: ['id'] },
});

export const RELATIONSHIP = Object.freeze({
  NEAR: 'near',
  INSIDE: 'inside',
  THREATENS: 'threatens',
  COVERS: 'covers',
});

export const DEFAULT_NEAR_RADIUS_KM = Object.freeze({
  'aircraft:installation': 250,
  'vessel:installation': 250,
  'aircraft:weather-cell': 100,
  'vessel:weather-cell': 100,
  'fire:region': 0,
  default: 50,
});

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

function maximumNearRadius(overrides) {
  const values = [
    ...Object.values(DEFAULT_NEAR_RADIUS_KM),
    ...Object.values(overrides || {}),
  ].filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : 0;
}

function normalizedConfidence(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeProvenance(record, {
  layerKey = null,
  existing = null,
  ingestedAt = null,
} = {}) {
  const raw = record?.provenance ?? record?.__provenance ?? {};
  const sourceIds = Array.isArray(raw.sourceIds)
    ? [...new Set(raw.sourceIds.map((value) => String(value)).filter(Boolean))]
    : existing?.sourceIds ?? [];
  return {
    provider: raw.provider ?? record?.provider ?? layerKey ?? existing?.provider ?? null,
    observedAt: raw.observedAt ?? record?.observedAt ?? record?.timestamp ?? existing?.observedAt ?? null,
    ingestedAt,
    derived: Boolean(raw.derived ?? existing?.derived ?? false),
    derivation: raw.derivation ?? existing?.derivation ?? null,
    sourceIds,
    confidence: normalizedConfidence(raw.confidence ?? record?.confidence, existing?.confidence ?? null),
    freshness: raw.freshness ?? existing?.freshness ?? 'live',
    license: raw.license ?? existing?.license ?? null,
  };
}

export function createOntologyStore({
  now = Date.now,
  eventCapacity = DEFAULT_EVENT_CAPACITY,
  nearRadiusKm = {},
  relationshipDerivers = [],
} = {}) {
  const objects = new Map();
  const relationships = new Map();
  const events = [];
  const replayBaseObjects = new Map();
  let eventSeq = 0;
  let stateRevision = 0;
  let droppedEvents = 0;
  let replayBaseSeq = 0;
  let replayBaseTime = null;
  const actions = new Map();

  function foldReplayBase(event) {
    if (event.kind === 'upsert' && event.object) {
      replayBaseObjects.set(event.objectId, structuredClone(event.object));
    } else if (event.kind === 'remove') {
      replayBaseObjects.delete(event.objectId);
    }
    replayBaseSeq = event.seq;
    replayBaseTime = event.t;
  }

  function appendEvent(kind, payload) {
    const event = { seq: ++eventSeq, t: now(), kind, ...payload };
    events.push(event);
    if (events.length > eventCapacity) {
      const dropped = events.shift();
      foldReplayBase(dropped);
      droppedEvents += 1;
    }
    return event;
  }

  function markStateChanged() {
    stateRevision += 1;
    return stateRevision;
  }

  function upsertObject(type, record, { layerKey = null } = {}) {
    if (!OBJECT_TYPES[type] || !record) return null;
    const id = record.__ontologyId || stableObjectId(type, record);
    if (!id) return null;
    const existing = objects.get(id);
    const effectiveLayerKey = layerKey ?? existing?.layerKey ?? null;
    const updatedAt = now();
    const object = {
      id,
      type,
      layerKey: effectiveLayerKey,
      lat: Number.isFinite(record.lat) ? record.lat : existing?.lat ?? null,
      lon: Number.isFinite(record.lon) ? record.lon : existing?.lon ?? null,
      attrs: { ...existing?.attrs, ...record },
      ring: record.ring ?? existing?.ring ?? null,
      provenance: normalizeProvenance(record, {
        layerKey: effectiveLayerKey,
        existing: existing?.provenance,
        ingestedAt: updatedAt,
      }),
      updatedAt,
      createdAt: existing?.createdAt ?? updatedAt,
    };
    delete object.attrs.__ontologyId;
    delete object.attrs.__provenance;
    objects.set(id, object);
    markStateChanged();
    appendEvent('upsert', { objectId: id, objectType: type, object });
    return object;
  }

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
    markStateChanged();
    appendEvent('remove', { objectId: id, reason });
    return true;
  }

  function recomputeRelationships() {
    relationships.clear();
    const list = [...objects.values()].filter(
      (o) => Number.isFinite(o.lat) && Number.isFinite(o.lon),
    );

    // Polygon membership is not safely bounded by the polygon object's anchor
    // coordinate, so preserve exact ring semantics with a narrow O(r*n) pass.
    // In practice r (regions/weather polygons) is tiny compared with live mover
    // counts, while the dominant point-to-point NEAR work is indexed below.
    const insidePairs = new Set();
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.type === b.type || (!a.ring && !b.ring)) continue;
        const region = a.ring ? a : b;
        const point = region === a ? b : a;
        if (point !== region && Number.isFinite(point.lat)
            && pointInRing(region.ring, point.lat, point.lon)) {
          setRelationship(point.id, RELATIONSHIP.INSIDE, region.id, { distanceKm: 0 });
          insidePairs.add(`${i}:${j}`);
        }
      }
    }

    const maxRadiusKm = maximumNearRadius(nearRadiusKm);
    const candidatePairs = spatialCandidatePairs(list, maxRadiusKm);
    for (const [i, j] of candidatePairs) {
      const a = list[i];
      const b = list[j];
      if (a.type === b.type || insidePairs.has(`${i}:${j}`)) continue;
      const km = nearRadiusFor(a.type, b.type, nearRadiusKm);
      if (km <= 0) continue;
      const distanceKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
      if (distanceKm <= km) {
        const aMobile = MOBILE_TYPES.has(a.type);
        const bMobile = MOBILE_TYPES.has(b.type);
        const from = aMobile && !bMobile ? a : bMobile && !aMobile ? b : a;
        const to = from === a ? b : a;
        setRelationship(from.id, RELATIONSHIP.NEAR, to.id, {
          distanceKm: Math.round(distanceKm * 10) / 10,
        });
      }
    }

    for (const derive of relationshipDerivers) {
      if (typeof derive === 'function') derive(list, setRelationship);
    }
    appendEvent('relationships', {
      count: relationships.size,
      candidatePairs: candidatePairs.length,
      pointObjects: list.length,
    });
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

  function defineAction(name, { handler, guard = null } = {}) {
    if (!name || typeof handler !== 'function') return false;
    actions.set(name, { handler, guard });
    return true;
  }

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
      appendEvent('action', {
        action: name, objectId, ok: false, error: String(err?.message || err),
      });
      return { ok: false, error: String(err?.message || err) };
    }
    appendEvent('action', { action: name, objectId, ok: result?.ok !== false });
    return result ?? { ok: true };
  }

  function snapshot() {
    return {
      objects: structuredClone([...objects.values()]),
      relationships: structuredClone([...relationships.values()]),
      eventSeq,
      stateRevision,
    };
  }

  function restore(snap, { markStateChange = false } = {}) {
    objects.clear();
    relationships.clear();
    for (const object of snap.objects || []) objects.set(object.id, structuredClone(object));
    for (const rel of snap.relationships || []) {
      const cloned = structuredClone(rel);
      relationships.set(`${cloned.fromId}|${cloned.kind}|${cloned.toId}`, cloned);
    }
    if (markStateChange) markStateChanged();
  }

  function replayBaseline() {
    return {
      seq: replayBaseSeq,
      t: replayBaseTime,
      objects: structuredClone([...replayBaseObjects.values()]),
    };
  }

  const api = {
    upsertObject,
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
    stateRevision: () => stateRevision,
    droppedEventCount: () => droppedEvents,
    replayBaseline,
    snapshot,
    restore,
  };
  return api;
}
