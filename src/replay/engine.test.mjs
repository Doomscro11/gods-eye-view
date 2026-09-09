import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from '../ontology/store.js';
import { stateAt, createReplayCursor, detectAnomalies } from './engine.js';

function clockedStore() {
  let t = 0;
  return {
    store: createOntologyStore({ now: () => t }),
    set: (v) => { t = v; },
  };
}

test('stateAt folds upserts and removes up to the timestamp', () => {
  const { store, set } = clockedStore();
  set(1000);
  store.upsertObject('aircraft', { icao24: 'a1', lat: 10, lon: 10 });
  set(2000);
  store.upsertObject('aircraft', { icao24: 'a1', lat: 20, lon: 20 });
  set(3000);
  store.removeObject('aircraft:a1');

  const events = store.getEvents();
  assert.equal(stateAt(events, 500).size, 0);
  assert.equal(stateAt(events, 1500).get('aircraft:a1').lat, 10);
  assert.equal(stateAt(events, 2500).get('aircraft:a1').lat, 20);
  assert.equal(stateAt(events, 3500).size, 0); // removed
});

test('replay cursor seeks, bounds the timeline, and lists decision markers', () => {
  const { store, set } = clockedStore();
  set(1000);
  store.upsertObject('quake', { id: 'q1', lat: 1, lon: 1 });
  set(5000);
  store.recordEvent('scenario-applied', { name: 'rehearsal' });
  const cursor = createReplayCursor(store);
  assert.equal(cursor.seek(1000).length, 1);
  assert.deepEqual(cursor.timeline(), { start: 1000, end: 5000, events: 2 });
  assert.equal(cursor.markers().length, 1);
  assert.equal(cursor.markers()[0].name, 'rehearsal');
});

test('detectAnomalies finds dark gaps between reports', () => {
  const { store, set } = clockedStore();
  set(0);
  store.upsertObject('vessel', { mmsi: 'dark1', lat: 1, lon: 1 });
  set(2 * 60 * 60 * 1000); // two hours of silence
  store.upsertObject('vessel', { mmsi: 'dark1', lat: 1.1, lon: 1.1 });
  const anomalies = detectAnomalies(store.getEvents(), { gapMs: 30 * 60 * 1000 });
  const dark = anomalies.filter((a) => a.kind === 'dark-activity');
  assert.equal(dark.length, 1);
  assert.equal(dark[0].objectId, 'vessel:dark1');
  assert.equal(dark[0].evidence.gapMs, 2 * 60 * 60 * 1000);
});

test('detectAnomalies flags physically impossible movement', () => {
  const { store, set } = clockedStore();
  set(0);
  store.upsertObject('vessel', { mmsi: 'tele1', lat: 0, lon: 0 });
  set(60 * 1000); // one minute later…
  store.upsertObject('vessel', { mmsi: 'tele1', lat: 10, lon: 10 }); // …1500 km away
  const anomalies = detectAnomalies(store.getEvents());
  const teleport = anomalies.filter((a) => a.kind === 'teleport');
  assert.equal(teleport.length, 1);
  assert.ok(teleport[0].evidence.impliedSpeedKmh > 70); // vessels don't do 90,000 km/h
});

test('detectAnomalies flags churn from repeated remove cycles', () => {
  const { store, set } = clockedStore();
  for (let i = 0; i < 3; i += 1) {
    set(i * 1000);
    store.upsertObject('aircraft', { icao24: 'flap', lat: i, lon: i });
    store.removeObject('aircraft:flap');
  }
  const anomalies = detectAnomalies(store.getEvents(), { flapCount: 3 });
  assert.ok(anomalies.some((a) => a.kind === 'churn' && a.objectId === 'aircraft:flap'));
});

test('anomalies come back time-sorted', () => {
  const { store, set } = clockedStore();
  set(0);
  store.upsertObject('vessel', { mmsi: 'v', lat: 0, lon: 0 });
  set(10 * 60 * 1000);
  store.upsertObject('vessel', { mmsi: 'v', lat: 20, lon: 20 }); // teleport at t=10min
  set(10 * 60 * 1000 + 1);
  store.upsertObject('vessel', { mmsi: 'w', lat: 0, lon: 0 });
  set(3 * 60 * 60 * 1000);
  store.upsertObject('vessel', { mmsi: 'w', lat: 0.1, lon: 0 }); // dark gap later
  const anomalies = detectAnomalies(store.getEvents());
  const times = anomalies.map((a) => a.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});
