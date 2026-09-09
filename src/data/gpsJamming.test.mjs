// src/data/gpsJamming.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GPS_JAM_DEFAULTS, navAccuracyVerdict, detectGpsJamZones, jamZoneSeverity, pointInJamZone,
} from './gpsJamming.js';

function fleet(cellLat, cellLon, specs) {
  // specs: array of nac_p values (or null for missing)
  return specs.map((nacp, i) => ({
    lat: cellLat + 0.1 + (i % 5) * 0.15,
    lon: cellLon + 0.1 + Math.floor(i / 5) * 0.15,
    ...(nacp == null ? {} : { nac_p: nacp }),
  }));
}

test('navAccuracyVerdict: 0 and missing are unknown, low positive is degraded', () => {
  assert.equal(navAccuracyVerdict({ nac_p: 10 }), 'nominal');
  assert.equal(navAccuracyVerdict({ nac_p: GPS_JAM_DEFAULTS.nacpDegradedMax }), 'degraded');
  assert.equal(navAccuracyVerdict({ nac_p: 0 }), 'unknown');
  assert.equal(navAccuracyVerdict({}), 'unknown');
  assert.equal(navAccuracyVerdict(null), 'unknown');
  assert.equal(navAccuracyVerdict({ nacP: 4 }), 'degraded'); // camelCase accepted
});

test('flags a jammed cell and leaves clean cells alone', () => {
  const jammed = fleet(35, 36, [1, 2, 3, 2, 1, 9, 10, 9]);       // 5/8 degraded
  const clean = fleet(40, -100, [9, 10, 9, 10, 9, 10, 8, 9]);     // 0/8
  const zones = detectGpsJamZones([...jammed, ...clean]);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].severity, 'warning');
  assert.equal(zones[0].known, 8);
  assert.equal(zones[0].degraded, 5);
  assert.ok(Math.abs(zones[0].ratio - 0.625) < 1e-9);
});

test('unknown-accuracy aircraft are excluded from the denominator', () => {
  // 3 degraded + 2 nominal + 20 unknown → ratio 3/5 = 0.6, known=5 (passes min).
  const records = [
    ...fleet(35, 36, [2, 2, 2, 9, 9]),
    ...fleet(35, 36, Array(20).fill(null)),
  ];
  const zones = detectGpsJamZones(records);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].known, 5);
  assert.equal(zones[0].total, 25);
  assert.equal(zones[0].ratio, 0.6);
  assert.equal(zones[0].severity, 'watch'); // degraded < 10, ratio < warning? 0.6≥0.4 but degraded<5
});

test('critical severity needs both high ratio and mass', () => {
  const records = fleet(35, 36, [...Array(12).fill(2), ...Array(3).fill(10)]);
  const zones = detectGpsJamZones(records);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].severity, 'critical'); // ratio 0.8, degraded 12
});

test('statistically thin cells never flag', () => {
  const zones = detectGpsJamZones(fleet(35, 36, [1, 1, 1])); // 3 aircraft < minAircraft
  assert.equal(zones.length, 0);
});

test('malformed records are ignored, empty input is empty output', () => {
  const zones = detectGpsJamZones([
    { lat: 'x', lon: 36, nac_p: 1 }, { lat: 35, nac_p: 1 }, null, undefined, {},
  ]);
  assert.equal(zones.length, 0);
  assert.equal(detectGpsJamZones([]).length, 0);
  assert.equal(detectGpsJamZones(null).length, 0);
});

test('pointInJamZone matches the zone cell and respects its grid size', () => {
  const [zone] = detectGpsJamZones(fleet(35, 36, [1, 2, 3, 2, 1, 9, 10, 9]));
  assert.ok(pointInJamZone(zone, 35.5, 36.5));
  assert.equal(pointInJamZone(zone, 36.5, 36.5), false);
  assert.equal(pointInJamZone(zone, Number.NaN, 36.5), false);
  assert.equal(pointInJamZone(null, 35.5, 36.5), false);
});

test('jamZoneSeverity ladder', () => {
  assert.equal(jamZoneSeverity(0.9, 20), 'critical');
  assert.equal(jamZoneSeverity(0.5, 6), 'warning');
  assert.equal(jamZoneSeverity(0.3, 3), 'watch');
  assert.equal(jamZoneSeverity(0.9, 2), 'watch'); // mass too low to trust the ratio
});
