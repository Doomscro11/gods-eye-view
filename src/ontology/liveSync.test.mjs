import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from './store.js';
import { createLiveSync, registerStandardVerbs, syncOnce } from './liveSync.js';
import { corridorBreachRule } from './rules.js';

function fakeDataManager(recordsByLayer, enabled = {}) {
  return {
    layers: new Map(Object.entries(recordsByLayer).map(([key, records]) => [
      key, { module: { getAnalystRecords: () => records } },
    ])),
    isEnabled: (key) => enabled[key] !== false,
  };
}

test('syncOnce reads the analyst seam and builds the picture', () => {
  const store = createOntologyStore({ now: () => 1000 });
  const dm = fakeDataManager({
    flights: [{ icao24: 'a1', lat: 30, lon: -97, altitudeM: 9000 }],
    'ais-live-vessels': [{ mmsi: 'v1', lat: 26, lon: 56 }],
  }, { 'ais-live-vessels': false });
  const result = syncOnce(store, dm);
  assert.deepEqual(result.synced, { flights: 1, 'flights:evicted': 0 }); // disabled layer skipped
  assert.equal(result.objects, 1);
  assert.equal(store.getObject('aircraft:a1').attrs.altitudeM, 9000);
});

test('live sync surfaces only fresh alerts to the host', () => {
  let t = 1000;
  const store = createOntologyStore({ now: () => t });
  store.upsertObject('installation', {
    id: 'strait', lat: 26, lon: 56, watch: { radiusKm: 300 },
  });
  const vessel = { mmsi: 'v1', lat: 26.5, lon: 56.5 };
  const dm = fakeDataManager({ 'ais-live-vessels': [vessel] });
  const deliveries = [];
  const sync = createLiveSync(store, dm, {
    onAlerts: (fresh, all) => deliveries.push({ fresh: fresh.length, all: all.length }),
    rules: [corridorBreachRule()],
  });
  sync.syncOnce();
  assert.deepEqual(deliveries[0], { fresh: 1, all: 1 });
  sync.syncOnce(); // same state → nothing fresh, no delivery
  assert.equal(deliveries.length, 1);
  t = 2000;
  vessel.lat = 40; vessel.lon = 70; // breach ends, then…
  sync.syncOnce();
  vessel.lat = 26.5; vessel.lon = 56.5; // …breach returns = fresh again
  sync.syncOnce();
  assert.equal(deliveries.length, 2);
});

test('start/stop drive the injected timer', () => {
  const store = createOntologyStore({ now: () => 1000 });
  const dm = fakeDataManager({});
  let ticks = 0;
  let handle = 0;
  const sync = createLiveSync(store, dm, {
    setIntervalFn: (fn) => { ticks += 1; fn(); return (handle += 1); },
    clearIntervalFn: () => {},
  });
  assert.equal(sync.start(), true);
  assert.equal(sync.isRunning(), true);
  assert.equal(ticks, 1);
  assert.equal(sync.start(), false); // no double-start
  assert.equal(sync.stop(), true);
  assert.equal(sync.isRunning(), false);
  assert.equal(sync.stop(), false); // idempotent
});

test('standard verbs close the loop from alert to brief artifact', () => {
  const store = createOntologyStore({ now: () => 1000 });
  const tracked = [];
  const briefs = [];
  registerStandardVerbs(store, {
    onTrack: (object) => tracked.push(object.id),
    onBrief: (artifact) => briefs.push(artifact),
  });
  store.upsertObject('installation', {
    id: 'strait', lat: 26, lon: 56, watch: { radiusKm: 200, severity: 'critical' },
  });
  store.upsertObject('vessel', { mmsi: 'v1', name: 'MV LOOP', lat: 26.5, lon: 56.5 });

  // Alert carries the governed verbs…
  const alerts = corridorBreachRule().evaluate(store);
  const verbNames = alerts[0].actions.map((a) => a.action);
  assert.deepEqual(verbNames, ['track', 'annotate', 'brief']);

  // …and invoking one travels the store's governed path to the surface.
  const result = store.applyAction('track', { objectId: alerts[0].objectId });
  assert.equal(result.ok, true);
  assert.deepEqual(tracked, ['vessel:v1']);

  const briefResult = store.applyAction('brief');
  assert.equal(briefResult.ok, true);
  assert.match(briefResult.markdown, /MV LOOP/);
  assert.equal(briefs.length, 1);
});

test('verb guards refuse malformed invocations', () => {
  const store = createOntologyStore({ now: () => 1000 });
  registerStandardVerbs(store, {});
  assert.equal(store.applyAction('track', {}).ok, false);
  assert.equal(store.applyAction('track', { objectId: 'ghost' }).ok, false);
});
