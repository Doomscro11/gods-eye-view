import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from './store.js';

const BOX = [[-100, 30], [-90, 30], [-90, 40], [-100, 40]];

test('indexed relationship recompute preserves NEAR across the dateline', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('installation', { id: 'east', lat: 0, lon: 179.9 });
  store.upsertObject('aircraft', { icao24: 'west', lat: 0, lon: -179.9 });
  store.recomputeRelationships();

  const near = store.relationshipsFor('aircraft:west', { kind: 'near' });
  assert.ok(near.some((relationship) => relationship.toId === 'installation:east'));
});

test('polygon INSIDE semantics remain exact and suppress duplicate NEAR edge', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('region', { id: 'box', ring: BOX, lat: 35, lon: -95 });
  store.upsertObject('aircraft', { icao24: 'inside', lat: 35.1, lon: -95.1 });
  store.recomputeRelationships();

  const relationships = store.relationshipsFor('aircraft:inside');
  assert.ok(relationships.some((relationship) => relationship.kind === 'inside' && relationship.toId === 'region:box'));
  assert.equal(relationships.some((relationship) => relationship.kind === 'near' && relationship.toId === 'region:box'), false);
});

test('relationship audit event reports a strongly pruned sparse candidate set', () => {
  const store = createOntologyStore({ now: () => 1000 });
  let id = 0;
  for (let lat = -80; lat <= 80; lat += 20) {
    for (let lon = -180; lon < 180; lon += 20) {
      const type = id % 2 === 0 ? 'aircraft' : 'vessel';
      const record = type === 'aircraft'
        ? { icao24: `a${id}`, lat, lon }
        : { mmsi: `v${id}`, lat, lon };
      store.upsertObject(type, record);
      id += 1;
    }
  }

  store.recomputeRelationships();
  const event = store.getEvents({ kind: 'relationships' }).at(-1);
  const totalPairs = event.pointObjects * (event.pointObjects - 1) / 2;
  assert.ok(event.candidatePairs < totalPairs / 10, `${event.candidatePairs} should be far below ${totalPairs}`);
});
