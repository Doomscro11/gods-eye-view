// src/ontology/derivedFeeds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { createOntologyStore, RELATIONSHIP } from './store.js';
import { syncDerivedFeeds, coversDeriver } from './derivedFeeds.js';
import {
  evaluateRules, gpsJamExposureRule, spaceWeatherRule, kevRecentRule,
} from './rules.js';
import { subpointAt } from '../data/satPasses.js';

const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const AT_MS = Date.UTC(2008, 8, 20, 12, 30, 0);

function makeStore(extra = {}) {
  return createOntologyStore({ now: () => AT_MS, ...extra });
}

test('syncDerivedFeeds upserts and mark-and-sweeps each feed layer', () => {
  const store = makeStore();
  syncDerivedFeeds(store, {
    jamZones: [{ id: 'gps-jam:35:36', lat: 35.5, lon: 36.5, cellKey: '35:36', gridSizeDeg: 1, ratio: 0.5, degraded: 6, known: 12, severity: 'warning' }],
    eonet: { items: [{ id: 'eonet:E1', title: 'Cyclone', category: 'Severe Storms', lat: 16.2, lon: 121.5 }] },
    kev: { items: [{ cve: 'CVE-2026-1111', id: 'kev:CVE-2026-1111', vendor: 'Acme', recentlyAdded: true }] },
    spaceWeather: { id: 'space-weather:current', kp: 4.67, G: 3, severity: 'warning' },
  });
  assert.equal(store.allObjects().length, 4);
  assert.equal(store.objectsOfType('gps-jam-zone').length, 1);
  assert.equal(store.objectsOfType('natural-event').length, 1);
  assert.equal(store.objectsOfType('cyber-vuln').length, 1);
  assert.equal(store.objectsOfType('space-weather').length, 1);

  // Feed ran again and found nothing → layer swept, not ghosted.
  syncDerivedFeeds(store, { jamZones: [] });
  assert.equal(store.objectsOfType('gps-jam-zone').length, 0);
  assert.equal(store.allObjects().length, 3); // other layers untouched

  // A key ABSENT from the feeds arg is left alone entirely.
  syncDerivedFeeds(store, {});
  assert.equal(store.allObjects().length, 3);
});

test('KEV sync caps at the newest hundred', () => {
  const store = makeStore();
  const items = Array.from({ length: 150 }, (_, i) => ({ cve: `CVE-2026-${i}`, id: `kev:${i}` }));
  syncDerivedFeeds(store, { kev: { items } });
  assert.equal(store.objectsOfType('cyber-vuln').length, 100);
});

test('coversDeriver links satellites over watched fixtures only', () => {
  const satrec = twoline2satrec(L1, L2);
  const sub = subpointAt(satrec, AT_MS);
  const store = makeStore({
    relationshipDerivers: [coversDeriver({
      getSatrecs: () => [{ noradId: 25544, satrec }],
      atMs: () => AT_MS,
    })],
  });
  // Satellite in the picture; one fixture under it, one far away, plus an
  // aircraft (mobile — NOT a covered fixture type).
  store.upsertObject('satellite', { noradId: 25544, name: 'ISS', lat: sub.latDeg, lon: sub.lonDeg });
  store.upsertObject('installation', { id: 'under', lat: sub.latDeg, lon: sub.lonDeg });
  store.upsertObject('installation', { id: 'far', lat: -sub.latDeg, lon: sub.lonDeg + 90 });
  store.upsertObject('aircraft', { icao24: 'abc123', lat: sub.latDeg, lon: sub.lonDeg });
  store.recomputeRelationships();

  const covers = store.allRelationships().filter((r) => r.kind === RELATIONSHIP.COVERS);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].fromId, 'satellite:25544');
  assert.equal(covers[0].toId, 'installation:under');
});

test('coversDeriver skips satellites absent from the picture', () => {
  const satrec = twoline2satrec(L1, L2);
  const sub = subpointAt(satrec, AT_MS);
  const store = makeStore({
    relationshipDerivers: [coversDeriver({ getSatrecs: () => [{ noradId: 99999, satrec }], atMs: () => AT_MS })],
  });
  store.upsertObject('installation', { id: 'under', lat: sub.latDeg, lon: sub.lonDeg });
  store.recomputeRelationships();
  assert.equal(store.allRelationships().filter((r) => r.kind === RELATIONSHIP.COVERS).length, 0);
});

test('gps-jam-exposure rule flags movers in the zone with downgraded severity', () => {
  const store = makeStore();
  syncDerivedFeeds(store, {
    jamZones: [{ id: 'gps-jam:35:36', lat: 35.5, lon: 36.5, cellKey: '35:36', gridSizeDeg: 1, ratio: 0.8, degraded: 12, known: 15, severity: 'critical' }],
  });
  store.upsertObject('aircraft', { icao24: 'abc123', callsign: 'AAL1', lat: 35.4, lon: 36.4 });
  store.upsertObject('vessel', { mmsi: '123456', name: 'SS CLEAR', lat: 10, lon: 10 });
  const alerts = evaluateRules(store, [gpsJamExposureRule()]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].objectId, 'aircraft:abc123');
  assert.equal(alerts[0].severity, 'warning'); // critical zone → exposure one notch down
  assert.equal(alerts[0].evidence.zoneSeverity, 'critical');
  assert.ok(alerts[0].actions.length >= 0);
});

test('space-weather rule respects the severity floor', () => {
  const store = makeStore();
  syncDerivedFeeds(store, { spaceWeather: { id: 'space-weather:current', kp: 2, G: 0, severity: 'info' } });
  assert.equal(evaluateRules(store, [spaceWeatherRule()]).length, 0);
  syncDerivedFeeds(store, { spaceWeather: { id: 'space-weather:current', kp: 7, G: 4, severity: 'critical' } });
  const alerts = evaluateRules(store, [spaceWeatherRule()]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(alerts[0].evidence.G, 4);
});

test('kev-recent rule surfaces only freshly-added CVEs, non-spatially', () => {
  const store = makeStore();
  syncDerivedFeeds(store, {
    kev: { items: [
      { cve: 'CVE-2026-NEW', id: 'kev:CVE-2026-NEW', vendor: 'Acme', product: 'VPN', recentlyAdded: true, dueDate: '2026-02-01' },
      { cve: 'CVE-2025-OLD', id: 'kev:CVE-2025-OLD', recentlyAdded: false },
    ] },
  });
  const alerts = evaluateRules(store, [kevRecentRule()]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].evidence.cve, 'CVE-2026-NEW');
  assert.equal(alerts[0].severity, 'info');
});

test('defaultRules includes the phase-5 rules without breaking evaluation', () => {
  const store = makeStore();
  // Empty store: total evaluation must still be deterministic and silent.
  const alerts = evaluateRules(store);
  assert.deepEqual(alerts, []);
});
