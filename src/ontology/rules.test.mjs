import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from './store.js';
import {
  corridorBreachRule, darkActivityRule, proximityRule, evaluateRules,
} from './rules.js';

const RING = [[-100, 30], [-90, 30], [-90, 40], [-100, 40]];

test('corridor breach fires inside a radius corridor with actions attached', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.defineAction('track', { handler: () => ({ ok: true }) });
  store.upsertObject('installation', {
    id: 'strait', lat: 26, lon: 56, watch: { radiusKm: 200, severity: 'critical' },
  });
  store.upsertObject('vessel', { mmsi: 'tanker1', name: 'MV TEST', lat: 26.5, lon: 56.5 });
  store.upsertObject('vessel', { mmsi: 'far1', lat: 0, lon: 0 });

  const alerts = corridorBreachRule().evaluate(store);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].objectId, 'vessel:tanker1');
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(alerts[0].label, 'MV TEST');
  assert.ok(alerts[0].evidence.distanceKm < 200);
  // The closed loop: the alert carries invocable verbs, not just information.
  assert.deepEqual(alerts[0].actions, [{ action: 'track', objectId: 'vessel:tanker1' }]);
});

test('corridor breach fires inside a ring corridor', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('region', { id: 'zone', ring: RING, lat: 35, lon: -95 });
  store.upsertObject('aircraft', { icao24: 'in1', lat: 35, lon: -95 });
  store.upsertObject('aircraft', { icao24: 'out1', lat: 50, lon: -95 });
  const alerts = corridorBreachRule().evaluate(store);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].objectId, 'aircraft:in1');
  assert.equal(alerts[0].evidence.boundary, 'ring');
});

test('dark activity flags objects silent beyond the threshold', () => {
  let t = 0;
  const store = createOntologyStore({ now: () => t });
  store.upsertObject('vessel', { mmsi: 'dark1', lat: 1, lon: 1 });
  t = 60 * 60 * 1000; // one hour later, another object reports
  store.upsertObject('vessel', { mmsi: 'live1', lat: 2, lon: 2 });

  const alerts = darkActivityRule({ gapMs: 30 * 60 * 1000 }).evaluate(store);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].objectId, 'vessel:dark1');
  assert.equal(alerts[0].evidence.gapMs, 60 * 60 * 1000);
});

test('proximity rule reads derived relationships for movers only', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('installation', { id: 'base', lat: 35, lon: -95 });
  store.upsertObject('aircraft', { icao24: 'a1', lat: 35.5, lon: -95.5 });
  store.recomputeRelationships();
  const alerts = proximityRule().evaluate(store);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].objectId, 'aircraft:a1');
  assert.equal(alerts[0].evidence.relatedTo, 'installation:base');
});

test('evaluateRules sorts critical-first and is deterministic', () => {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('installation', {
    id: 'c1', lat: 26, lon: 56, watch: { radiusKm: 500, severity: 'critical' },
  });
  store.upsertObject('installation', { id: 'c2', lat: 35, lon: -95 });
  store.upsertObject('vessel', { mmsi: 'v1', lat: 26.5, lon: 56.5 });
  store.recomputeRelationships();
  const first = evaluateRules(store);
  const second = evaluateRules(store);
  assert.deepEqual(first.map((a) => a.id), second.map((a) => a.id));
  assert.equal(first[0].severity, 'critical');
});
