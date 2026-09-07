import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from '../ontology/store.js';
import { createScenarioEngine } from './engine.js';
import { corridorBreachRule } from '../ontology/rules.js';

function livePicture() {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('installation', {
    id: 'strait', lat: 26, lon: 56, watch: { radiusKm: 200, severity: 'warning' },
  });
  store.upsertObject('vessel', { mmsi: 'tanker1', name: 'MV FAR', lat: 30, lon: 60 });
  store.recomputeRelationships();
  return store;
}

test('staging edits never mutates the live store', () => {
  const live = livePicture();
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('tanker enters strait');

  engine.stageEdit(branch.id, {
    kind: 'upsert', type: 'vessel',
    record: { mmsi: 'tanker1', name: 'MV FAR', lat: 26.5, lon: 56.5 },
  });

  // Live is untouched: the vessel is still far away, no breach alert live.
  assert.equal(live.getObject('vessel:tanker1').lat, 30);
  const comparison = engine.compare(branch.id, [corridorBreachRule()]);
  assert.equal(comparison.liveAlertCount, 0);
  assert.equal(comparison.addedAlerts.length, 1);
  assert.equal(comparison.addedAlerts[0].ruleId, 'corridor-breach');
  assert.ok(comparison.objectDiffs.some((d) => d.objectId === 'vessel:tanker1' && d.change === 'modified'));
});

test('removing an asset in a branch resolves live alerts in the delta', () => {
  const live = createOntologyStore({ now: () => 1000 });
  live.upsertObject('installation', {
    id: 'strait', lat: 26, lon: 56, watch: { radiusKm: 200 },
  });
  live.upsertObject('vessel', { mmsi: 'v1', lat: 26.5, lon: 56.5 });
  live.recomputeRelationships();
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('asset withdrawn');
  engine.stageEdit(branch.id, { kind: 'remove', objectId: 'vessel:v1' });
  const comparison = engine.compare(branch.id, [corridorBreachRule()]);
  assert.equal(comparison.liveAlertCount, 1);
  assert.equal(comparison.addedAlerts.length, 0);
  assert.equal(comparison.removedAlerts.length, 1);
  assert.ok(comparison.objectDiffs.some((d) => d.change === 'removed'));
  // And live still has the object.
  assert.ok(live.getObject('vessel:v1'));
});

test('staging a weather front creates cross-type relationships in the branch', () => {
  const live = livePicture();
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('storm cell');
  const staged = engine.stageEdit(branch.id, {
    kind: 'weather-cell',
    record: { id: 'storm-1', lat: 30.1, lon: 60.1, weatherCode: 95 },
  });
  assert.equal(staged.ok, true);
  branch.store.recomputeRelationships();
  const rels = branch.store.relationshipsFor('vessel:tanker1');
  assert.ok(rels.some((r) => r.toId === 'weather-cell:storm-1'));
});

test('apply commits branch state to live and records an audit marker', () => {
  const live = livePicture();
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('tanker enters strait');
  engine.stageEdit(branch.id, {
    kind: 'upsert', type: 'vessel',
    record: { mmsi: 'tanker1', lat: 26.5, lon: 56.5 },
  });
  const result = engine.apply(branch.id);
  assert.equal(result.ok, true);
  assert.equal(live.getObject('vessel:tanker1').lat, 26.5);
  const markers = live.getEvents({ kind: 'scenario-applied' });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].name, 'tanker enters strait');
  assert.equal(engine.listScenarios().length, 0); // branch consumed
});

test('discard leaves live untouched and forgets the branch', () => {
  const live = livePicture();
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('nothing happens');
  engine.stageEdit(branch.id, { kind: 'remove', objectId: 'vessel:tanker1' });
  assert.equal(engine.discard(branch.id), true);
  assert.ok(live.getObject('vessel:tanker1'));
  assert.equal(engine.compare(branch.id), null);
});

test('bad edits refuse without corrupting the branch', () => {
  const live = livePicture();
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('bad edits');
  assert.equal(engine.stageEdit(branch.id, { kind: 'wat' }).ok, false);
  assert.equal(engine.stageEdit(branch.id, { kind: 'remove', objectId: 'ghost' }).ok, false);
  assert.equal(engine.stageEdit('scenario:999', { kind: 'remove', objectId: 'x' }).ok, false);
});
