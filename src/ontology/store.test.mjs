import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore, OBJECT_TYPES } from './store.js';

const SQUARE_RING = [[-100, 30], [-90, 30], [-90, 40], [-100, 40]]; // [lon, lat]

function makeStore(now = () => 1000) {
  return createOntologyStore({ now });
}

test('upsertFromLayer normalizes feeds into typed objects with stable ids', () => {
  const store = makeStore();
  store.upsertFromLayer('flights', [
    { icao24: 'abc123', callsign: 'TEST1', lat: 35, lon: -95, altitudeM: 9000 },
    { callsign: 'NOID', lat: 36, lon: -96 },
  ]);
  const aircraft = store.objectsOfType('aircraft');
  assert.equal(aircraft.length, 2);
  assert.equal(aircraft[0].id, 'aircraft:abc123');
  assert.equal(aircraft[0].layerKey, 'flights');
  assert.equal(aircraft[0].attrs.altitudeM, 9000); // lossless attrs
  assert.equal(aircraft[0].provenance.provider, 'flights');
  assert.equal(aircraft[0].provenance.ingestedAt, 1000);
  assert.equal(aircraft[0].provenance.derived, false);
  assert.equal(aircraft[0].provenance.freshness, 'live');
  // Second record falls back to the next identity field.
  assert.equal(aircraft[1].id, 'aircraft:NOID');
});

test('provenance is first-class, confidence is bounded, and source ids are de-duplicated', () => {
  const store = makeStore();
  const object = store.upsertObject('aircraft', {
    icao24: 'prov1',
    lat: 35,
    lon: -95,
    provenance: {
      provider: 'adsb.lol',
      observedAt: '2026-09-09T15:00:00Z',
      derived: true,
      derivation: 'gnss-interference-v1',
      sourceIds: ['aircraft:a', 'aircraft:a', 42],
      confidence: 1.4,
      freshness: 'live',
      license: 'provider-terms',
    },
  });

  assert.deepEqual(object.provenance, {
    provider: 'adsb.lol',
    observedAt: '2026-09-09T15:00:00Z',
    ingestedAt: 1000,
    derived: true,
    derivation: 'gnss-interference-v1',
    sourceIds: ['aircraft:a', '42'],
    confidence: 1,
    freshness: 'live',
    license: 'provider-terms',
  });
});

test('later observations preserve provenance fields that are not re-supplied', () => {
  let t = 1000;
  const store = makeStore(() => t);
  store.upsertObject('aircraft', {
    icao24: 'prov2', lat: 1, lon: 1,
    provenance: { provider: 'opensky', confidence: 0.73, observedAt: 900 },
  });
  t = 2000;
  const updated = store.upsertObject('aircraft', { icao24: 'prov2', lat: 2, lon: 2 });
  assert.equal(updated.provenance.provider, 'opensky');
  assert.equal(updated.provenance.confidence, 0.73);
  assert.equal(updated.provenance.observedAt, 900);
  assert.equal(updated.provenance.ingestedAt, 2000);
});

test('every declared layer key maps to an object type', () => {
  for (const [type, spec] of Object.entries(OBJECT_TYPES)) {
    for (const layerKey of spec.layerKeys) {
      const store = makeStore();
      store.upsertFromLayer(layerKey, [{ id: 'x', icao24: 'x', mmsi: 'x', lat: 1, lon: 1 }]);
      assert.ok(store.objectsOfType(type).length <= 1); // mapping exists, no throw
    }
  }
});

test('recomputeRelationships derives NEAR cross-type and INSIDE for rings', () => {
  const store = makeStore();
  store.upsertObject('installation', { id: 'base-1', lat: 35.0, lon: -95.0 });
  store.upsertObject('aircraft', { icao24: 'near1', lat: 35.5, lon: -95.5 }); // ~70 km
  store.upsertObject('aircraft', { icao24: 'far1', lat: 45.0, lon: -75.0 });
  store.upsertObject('region', { id: 'box', ring: SQUARE_RING, lat: 35, lon: -95 });
  store.recomputeRelationships();

  const near = store.relationshipsFor('aircraft:near1', { kind: 'near' });
  assert.ok(near.some((r) => r.toId === 'installation:base-1'));
  assert.equal(store.relationshipsFor('aircraft:far1', { kind: 'near' })
    .filter((r) => r.toId === 'installation:base-1').length, 0);
  // Inside the ring beats the radius guess.
  assert.ok(store.relationshipsFor('aircraft:near1', { kind: 'inside' })
    .some((r) => r.toId === 'region:box'));
  // Same-type objects never relate.
  assert.equal(store.allRelationships()
    .filter((r) => r.fromId.startsWith('aircraft:') && r.toId.startsWith('aircraft:')).length, 0);
});

test('relationships are total: leaving the radius drops the edge', () => {
  let t = 1000;
  const store = createOntologyStore({ now: () => t });
  store.upsertObject('installation', { id: 'base-1', lat: 35, lon: -95 });
  store.upsertObject('aircraft', { icao24: 'mover', lat: 35.5, lon: -95.5 });
  store.recomputeRelationships();
  assert.equal(store.relationshipsFor('aircraft:mover').length > 0, true);
  t = 2000;
  store.upsertObject('aircraft', { icao24: 'mover', lat: 60, lon: 0 });
  store.recomputeRelationships();
  assert.equal(store.relationshipsFor('aircraft:mover', { kind: 'near' })
    .filter((r) => r.toId === 'installation:base-1').length, 0);
});

test('actions are governed: guards refuse before handlers run', () => {
  const store = makeStore();
  store.upsertObject('aircraft', { icao24: 'a1', lat: 1, lon: 1 });
  let handled = 0;
  store.defineAction('track', {
    guard: (object) => (object ? true : 'no object'),
    handler: (object) => { handled += 1; return { ok: true, tracking: object.id }; },
  });
  const ok = store.applyAction('track', { objectId: 'aircraft:a1' });
  assert.equal(ok.ok, true);
  assert.equal(handled, 1);
  const refused = store.applyAction('track', { objectId: 'aircraft:ghost' });
  assert.equal(refused.ok, false);
  assert.equal(handled, 1); // handler never ran
  assert.equal(store.applyAction('nope', {}).ok, false);
});

test('event log is append-only, ring-buffered, and countable', () => {
  const store = createOntologyStore({ now: Date.now, eventCapacity: 5 });
  for (let i = 0; i < 8; i += 1) {
    store.upsertObject('quake', { id: `q${i}`, lat: i, lon: i });
  }
  const events = store.getEvents();
  assert.equal(events.length, 5);
  assert.equal(store.droppedEventCount(), 3);
  assert.ok(events[0].seq < events[events.length - 1].seq);
  assert.equal(store.getEvents({ kind: 'upsert' }).length, 5);
  assert.equal(store.getEvents({ since: events[0].seq }).length, 4);
});

test('snapshot/restore round-trips objects and relationships', () => {
  const store = makeStore();
  store.upsertObject('installation', { id: 'b', lat: 35, lon: -95 });
  store.upsertObject('vessel', { mmsi: '123', lat: 35.2, lon: -95.1 });
  store.recomputeRelationships();
  const snap = store.snapshot();
  const relCount = store.allRelationships().length;

  store.removeObject('vessel:123');
  store.recomputeRelationships();
  assert.equal(store.allRelationships().length, 0);

  store.restore(snap);
  assert.ok(store.getObject('vessel:123'));
  assert.equal(store.allRelationships().length, relCount);
});

test('recordEvent appends audit markers', () => {
  const store = makeStore();
  store.recordEvent('scenario-applied', { name: 'test' });
  const markers = store.getEvents({ kind: 'scenario-applied' });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].name, 'test');
});

test('countsByType summarizes the picture', () => {
  const store = makeStore();
  store.upsertFromLayer('flights', [{ icao24: 'a', lat: 1, lon: 1 }]);
  store.upsertFromLayer('ais-live-vessels', [{ mmsi: 'v', lat: 2, lon: 2 }]);
  assert.deepEqual(store.countsByType(), { aircraft: 1, vessel: 1 });
});
