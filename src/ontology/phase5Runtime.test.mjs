// src/ontology/phase5Runtime.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from './store.js';
import { createDerivedFeedsRuntime, PHASE5_CADENCE_MS } from './phase5Runtime.js';

const KEV = { vulnerabilities: [{ cveID: 'CVE-2026-1', vendorProject: 'A', product: 'B', vulnerabilityName: 'X', dateAdded: '2026-01-10' }] };
const EONET = { events: [{ id: 'E1', title: 'Storm', categories: [{ title: 'Severe Storms' }], geometry: [{ type: 'Point', coordinates: [10, 20], date: '2026-01-10T00:00:00Z' }] }] };
const KP = [['t', 'kp', 'a', 'n'], ['2026-01-15 00:00:00.000', 6, 30, 8]];
const SCALES = { 0: { DateStamp: '2026-01-15', TimeStamp: '00:05:00', R: { Scale: '0' }, S: { Scale: '0' }, G: { Scale: '2' } } };
const STAC = { features: [{ id: 'S1', collection: 'SENTINEL-1', bbox: [0, 0, 2, 2], properties: { datetime: '2026-01-14T00:00:00Z' } }] };
// ISS (ZARYA) — epoch 2026, fine for satrec construction (no propagation here).
const TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26015.50000000  .00016717  00000-0  10270-3 0  9000',
  '2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.72147127400000',
].join('\n');

function fakeFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url.includes('celestrak')) return { ok: true, text: async () => TLE };
    const json = url.includes('cisa.gov') ? KEV
      : url.includes('eonet') ? EONET
      : url.includes('k-index') ? KP
      : url.includes('scales') ? SCALES
      : STAC;
    return { ok: true, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

// 8 aircraft with known nac_p, 6 degraded, same cell → one zone.
const JAMMED_FLEET = Array.from({ length: 8 }, (_, i) => ({
  lat: 35.2 + (i % 4) * 0.1, lon: 36.2 + Math.floor(i / 4) * 0.1,
  nac_p: i < 6 ? 2 : 10,
}));

test('forced cycle syncs all feeds into the store', async () => {
  const store = createOntologyStore();
  const fetchFn = fakeFetch();
  const rt = createDerivedFeedsRuntime({
    store, fetchFn,
    getAdsbRecords: () => JAMMED_FLEET,
    getAoiBbox: () => [30, 30, 40, 40],
  });
  await rt.cycle({ force: true });
  assert.equal(store.objectsOfType('gps-jam-zone').length, 1);
  assert.equal(store.objectsOfType('natural-event').length, 1);
  assert.equal(store.objectsOfType('cyber-vuln').length, 1);
  assert.equal(store.objectsOfType('space-weather').length, 1);
  assert.equal(store.objectsOfType('imagery').length, 1);
  assert.equal(fetchFn.calls.length, 7); // kev, eonet, kp, scales, stac, 2 celestrak groups
  // The forced cycle also refreshed the TLE cache for the COVERS deriver.
  const satrecs = rt.getSatrecs();
  assert.equal(satrecs.length, 1); // same ISS in both groups → deduped by NORAD id
  assert.equal(satrecs[0].noradId, '25544');
  assert.ok(satrecs[0].satrec);
});

test('cadence gating: a second immediate cycle only recomputes nothing', async () => {
  const store = createOntologyStore();
  const fetchFn = fakeFetch();
  const rt = createDerivedFeedsRuntime({ store, fetchFn });
  await rt.cycle({ force: true });
  const callsAfterFirst = fetchFn.calls.length;
  const feeds = await rt.cycle(); // nothing due yet — jam is cadence-gated too
  assert.deepEqual(feeds, {});
  assert.equal(fetchFn.calls.length, callsAfterFirst);
});

test('failed fetches never throw and never evict', async () => {
  const store = createOntologyStore();
  const deadFetch = async () => { throw new Error('offline'); };
  const rt = createDerivedFeedsRuntime({ store, fetchFn: deadFetch });
  const feeds = await rt.cycle({ force: true }); // must not throw
  assert.equal(store.objectsOfType('cyber-vuln').length, 0);
  assert.deepEqual(Object.keys(feeds), ['jamZones']);
});

test('start/stop drive cycles on the fastest cadence with injected timers', async () => {
  const store = createOntologyStore();
  const fetchFn = fakeFetch();
  const timers = [];
  const rt = createDerivedFeedsRuntime({
    store, fetchFn,
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return 1; },
    clearIntervalFn: () => {},
  });
  rt.start();
  assert.ok(rt.running);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, Math.min(...Object.values(PHASE5_CADENCE_MS)));
  // Flush the immediate forced cycle, then tick the timer manually.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(store.allObjects().length > 0);
  rt.stop();
  assert.equal(rt.running, false);
  rt.stop(); // idempotent
});
