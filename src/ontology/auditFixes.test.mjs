import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from './store.js';
import { syncOnce } from './liveSync.js';
import { darkActivityRule } from './rules.js';
import { createScenarioEngine } from '../scenario/engine.js';

test('fix 1: sync evicts objects whose records left the feed', () => {
  const store = createOntologyStore({ now: () => 1000 });
  const flights = [{ icao24: 'a1', lat: 30, lon: -97 }, { icao24: 'a2', lat: 31, lon: -97 }];
  const dm = {
    layers: new Map([['flights', { module: { getAnalystRecords: () => flights } }]]),
    isEnabled: () => true,
  };
  syncOnce(store, dm, { layerKeys: ['flights'] });
  assert.equal(store.objectsOfType('aircraft').length, 2);

  flights.pop(); // a2 left the viewport-scoped feed
  const result = syncOnce(store, dm, { layerKeys: ['flights'] });
  assert.equal(store.objectsOfType('aircraft').length, 1);
  assert.equal(store.getObject('aircraft:a2'), null);
  assert.equal(result.synced['flights:evicted'], 1);
  // Eviction is logged distinctly from scenario edits.
  assert.ok(store.getEvents({ kind: 'remove' }).some((e) => e.reason === 'feed-evicted'));
});

test('fix 1: eviction is per-layer — other layers untouched', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertFromLayer('flights', [{ icao24: 'a1', lat: 1, lon: 1 }]);
  store.upsertFromLayer('earthquakes', [{ id: 'q1', lat: 2, lon: 2 }]);
  const dm = {
    layers: new Map([['flights', { module: { getAnalystRecords: () => [] } }]]),
    isEnabled: () => true,
  };
  syncOnce(store, dm, { layerKeys: ['flights'] });
  assert.equal(store.getObject('aircraft:a1'), null);
  assert.ok(store.getObject('quake:q1')); // different layer survives
});

test('fix 2: scenario apply refuses when the live picture moved on', () => {
  let t = 1000;
  const live = createOntologyStore({ now: () => t });
  live.upsertObject('vessel', { mmsi: 'v1', lat: 30, lon: 60 });
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('stale rehearsal');

  t = 2000;
  live.upsertObject('vessel', { mmsi: 'v1', lat: 35, lon: 65 }); // feed moved on

  engine.stageEdit(branch.id, { kind: 'remove', objectId: 'vessel:v1' });
  const refused = engine.apply(branch.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.stale, true);
  assert.ok(refused.staleBy > 0);
  assert.ok(live.getObject('vessel:v1')); // live state NOT clobbered

  const forced = engine.apply(branch.id, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(live.getObject('vessel:v1'), null);
  assert.ok(live.getEvents({ kind: 'scenario-force-applied' }).length === 1);
});

test('fix 3: throwing handlers return failure and hit the audit log', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('aircraft', { icao24: 'a1', lat: 1, lon: 1 });
  store.defineAction('explode', {
    handler: () => { throw new Error('surface exploded'); },
  });
  const result = store.applyAction('explode', { objectId: 'aircraft:a1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /surface exploded/);
  const logged = store.getEvents({ kind: 'action' });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].ok, false);
});

test('fix 4: scenario diff ignores attr key order', () => {
  const live = createOntologyStore({ now: () => 1000 });
  live.upsertObject('installation', { id: 'b', lat: 35, lon: -95, watch: { radiusKm: 100 } });
  const engine = createScenarioEngine(live);
  const branch = engine.beginScenario('same attrs, new key order');
  // Re-upsert identical data with keys in a different order.
  branch.store.upsertObject('installation', {
    watch: { radiusKm: 100 }, lon: -95, lat: 35, id: 'b',
  });
  const comparison = engine.compare(branch.id);
  assert.equal(comparison.objectDiffs.length, 0); // no phantom "modified"
});

test('fix 5: dark activity falls back to updatedAt past the ring buffer', () => {
  let t = 0;
  const store = createOntologyStore({ now: () => t, eventCapacity: 4 });
  store.upsertObject('vessel', { mmsi: 'steady', lat: 1, lon: 1 });
  // Overflow the log with OTHER objects so steady's upsert event is dropped…
  for (let i = 0; i < 6; i += 1) {
    t = i + 1;
    store.upsertObject('quake', { id: `q${i}`, lat: i, lon: i });
  }
  // …but steady keeps refreshing via a layer re-sync (updatedAt advances).
  t = 10;
  store.upsertObject('vessel', { mmsi: 'steady', lat: 1, lon: 1 });
  const alerts = darkActivityRule({ gapMs: 5 }).evaluate(store);
  assert.equal(alerts.filter((a) => a.objectId === 'vessel:steady').length, 0);
});
