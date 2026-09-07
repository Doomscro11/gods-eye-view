import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from './store.js';
import { ontologyBackedProviders, nearestObjects, publishContextSelection } from './adapters.js';
import { createAnalystEngine } from '../data/analystEngine.js';

test('ontology-backed getRecords serves lossless records to the analyst engine', async () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertFromLayer('flights', [
    { icao24: 'a1', callsign: 'HIGH1', lat: 30, lon: -97, altitudeM: 12000 },
    { icao24: 'a2', callsign: 'LOW1', lat: 30.1, lon: -97.1, altitudeM: 3000 },
  ]);
  const providers = ontologyBackedProviders(store, {
    getRecords: () => [],
    getViewContext: () => ({ lat: 30, lon: -97, viewRadiusKm: 100 }),
    resolveRegionRing: async () => null,
  });
  const engine = createAnalystEngine(providers);
  const result = await engine.query({
    layers: ['flights'],
    scope: { kind: 'view' },
    filters: [{ field: 'altitudeM', op: 'gt', value: 10000 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].callsign, 'HIGH1');
  assert.equal(result.items[0].__ontologyId, 'aircraft:a1');
});

test('non-backed layers fall through to the base provider', () => {
  const store = createOntologyStore({ now: () => 1000 });
  const providers = ontologyBackedProviders(store, {
    getRecords: (key) => (key === 'cctv' ? [{ id: 'cam1' }] : []),
  });
  assert.deepEqual(providers.getRecords('cctv'), [{ id: 'cam1' }]);
});

test('nearestObjects answers cross-type proximity from the ontology', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('installation', { id: 'b', lat: 35, lon: -95 });
  store.upsertFromLayer('flights', [{ icao24: 'a', lat: 35.1, lon: -95.1 }]);
  store.upsertFromLayer('ais-live-vessels', [{ mmsi: 'v', lat: 40, lon: -90 }]);
  const nearest = nearestObjects(store, { lat: 35, lon: -95, limit: 2 });
  assert.equal(nearest.length, 2);
  assert.equal(nearest[0].id, 'installation:b');
  assert.equal(nearest[1].type, 'aircraft');
  const aircraftOnly = nearestObjects(store, { lat: 35, lon: -95, types: ['aircraft'] });
  assert.equal(aircraftOnly.length, 1);
});

test('publishContextSelection mirrors operator attention into the log', () => {
  const store = createOntologyStore({ now: () => 1000 });
  const object = publishContextSelection(store, {
    id: 'abc123', layerId: 'flights', lat: 30, lon: -97, callsign: 'SEL1',
  });
  assert.equal(object.id, 'aircraft:abc123');
  assert.equal(store.getObject('aircraft:abc123').attrs.callsign, 'SEL1');
  assert.equal(publishContextSelection(store, null), null);
});
