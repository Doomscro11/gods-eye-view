import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from '../ontology/store.js';
import { createScenarioEngine } from './engine.js';
import { corridorBreachRule } from '../ontology/rules.js';

function livePicture() {
  let t = 1000;
  const store = createOntologyStore({ now: () => t });
  store.upsertObject('installation', {
    id: 'strait', lat: 26, lon: 56, watch: { radiusKm: 200, severity: 'warning' },
  });
  store.upsertObject('vessel', { mmsi: 'tanker1', lat: 30, lon: 60 });
  store.recomputeRelationships();
  return { store, tick: () => { t += 1000; } };
}

test('begin → stage → compare → apply does not stale itself', () => {
  const { store } = livePicture();
  const engine = createScenarioEngine(store);
  const branch = engine.beginScenario('tanker enters strait');
  engine.stageEdit(branch.id, {
    kind: 'upsert',
    type: 'vessel',
    record: { mmsi: 'tanker1', lat: 26.5, lon: 56.5 },
  });

  const revisionBeforeCompare = store.stateRevision();
  const comparison = engine.compare(branch.id, [corridorBreachRule()]);
  assert.equal(comparison.addedAlerts.length, 1);
  assert.equal(store.stateRevision(), revisionBeforeCompare,
    'relationship recomputation must not advance scenario conflict revision');

  const result = engine.apply(branch.id);
  assert.equal(result.ok, true);
  assert.equal(result.stale, undefined);
  assert.equal(store.getObject('vessel:tanker1').lat, 26.5);
});

test('a real live-state mutation makes an open scenario stale', () => {
  const { store, tick } = livePicture();
  const engine = createScenarioEngine(store);
  const branch = engine.beginScenario('candidate branch');
  engine.stageEdit(branch.id, {
    kind: 'upsert', type: 'vessel',
    record: { mmsi: 'tanker1', lat: 26.5, lon: 56.5 },
  });

  tick();
  store.upsertObject('aircraft', { icao24: 'new-live-contact', lat: 25, lon: 55 });
  const result = engine.apply(branch.id);
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.staleBy, 1);
});

test('audit-only events do not make an open scenario stale', () => {
  const { store } = livePicture();
  const engine = createScenarioEngine(store);
  const branch = engine.beginScenario('audit-safe branch');
  engine.stageEdit(branch.id, {
    kind: 'upsert', type: 'vessel',
    record: { mmsi: 'tanker1', lat: 26.5, lon: 56.5 },
  });

  store.recordEvent('operator-note', { text: 'analyst note' });
  store.recomputeRelationships();
  const result = engine.apply(branch.id);
  assert.equal(result.ok, true);
});
