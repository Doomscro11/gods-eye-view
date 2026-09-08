// src/data/phase5Feeds.test.mjs
// One file covering the three small feed adapters + the STAC catalog: each is
// a pure normalize plus a fail-soft fetch, so the tests share a shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKev, fetchKevCatalog } from './kevCatalog.js';
import { normalizeEonet, fetchEonetEvents } from './eonetEvents.js';
import {
  normalizeKpIndex, normalizeScales, spaceWeatherSeverity, fetchSpaceWeather,
} from './spaceWeather.js';
import {
  buildStacQuery, normalizeStacItems, fetchSentinelAcquisitions,
} from './sentinelCatalog.js';

// ── KEV ──────────────────────────────────────────────────────────────────

const KEV_FIXTURE = {
  catalogVersion: '2026.01.15',
  dateReleased: '2026-01-15T00:00:00.000Z',
  vulnerabilities: [
    { cveID: 'CVE-2026-1111', vendorProject: 'Acme', product: 'RouterOS', vulnerabilityName: 'Acme RCE', dateAdded: '2026-01-14', dueDate: '2026-02-04', requiredAction: 'Patch now' },
    { cveID: 'CVE-2025-9999', vendorProject: 'Beta', product: 'VPN', vulnerabilityName: 'Beta Auth Bypass', dateAdded: '2025-06-01', dueDate: '2025-06-22', requiredAction: 'Patch' },
    { product: 'No CVE here' }, // dropped: no cveID
  ],
};

test('KEV normalize: newest first, recent flagged, malformed dropped', () => {
  const nowMs = Date.parse('2026-01-16T00:00:00Z');
  const out = normalizeKev(KEV_FIXTURE, { nowMs });
  assert.equal(out.count, 2);
  assert.equal(out.catalogVersion, '2026.01.15');
  assert.equal(out.items[0].cve, 'CVE-2026-1111');
  assert.equal(out.items[0].recentlyAdded, true);
  assert.equal(out.items[1].recentlyAdded, false);
  assert.equal(out.recentCount, 1);
  assert.equal(normalizeKev(null).count, 0);
  assert.equal(normalizeKev({}).count, 0);
});

test('KEV fetch: ok path normalizes, failure paths return null', async () => {
  const ok = await fetchKevCatalog(async () => ({ ok: true, json: async () => KEV_FIXTURE }));
  assert.equal(ok.count, 2);
  assert.equal(await fetchKevCatalog(async () => ({ ok: false })), null);
  assert.equal(await fetchKevCatalog(async () => { throw new Error('net'); }), null);
});

// ── EONET ────────────────────────────────────────────────────────────────

const EONET_FIXTURE = {
  events: [
    {
      id: 'EONET_1', title: 'Cyclone Demo', closed: null,
      categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
      sources: [{ id: 'NOAA', url: 'https://example.gov/x' }],
      geometry: [
        { date: '2026-01-10T00:00:00Z', type: 'Point', coordinates: [120.5, 15.2] },
        { date: '2026-01-12T00:00:00Z', type: 'Point', coordinates: [121.5, 16.2] },
      ],
    },
    { id: 'EONET_2', title: 'No geometry', categories: [], geometry: [] }, // dropped
  ],
};

test('EONET normalize: latest point wins, category carried, malformed dropped', () => {
  const out = normalizeEonet(EONET_FIXTURE);
  assert.equal(out.count, 1);
  const ev = out.items[0];
  assert.equal(ev.id, 'eonet:EONET_1');
  assert.equal(ev.lat, 16.2);
  assert.equal(ev.lon, 121.5);
  assert.equal(ev.category, 'Severe Storms');
  assert.equal(ev.lastUpdate, '2026-01-12T00:00:00Z');
  assert.equal(ev.sourceUrl, 'https://example.gov/x');
  assert.equal(normalizeEonet(null).count, 0);
});

test('EONET fetch is fail-soft', async () => {
  const ok = await fetchEonetEvents(async () => ({ ok: true, json: async () => EONET_FIXTURE }));
  assert.equal(ok.count, 1);
  assert.equal(await fetchEonetEvents(async () => ({ ok: false })), null);
});

// ── Space weather ────────────────────────────────────────────────────────

const KP_FIXTURE = [
  ['time_tag', 'Kp', 'a_running', 'station_count'],
  ['2026-01-15 00:00:00.000', 2.33, 5, 8],
  ['2026-01-15 03:00:00.000', 4.67, 22, 7],
];

const SCALES_FIXTURE = {
  0: { DateStamp: '2026-01-15', TimeStamp: '04:05:00.000', R: { Scale: '1', Text: 'minor' }, S: { Scale: '0', Text: 'none' }, G: { Scale: '3', Text: 'strong' } },
};

test('Kp normalize takes the latest valid row', () => {
  const kp = normalizeKpIndex(KP_FIXTURE);
  assert.equal(kp.kp, 4.67);
  assert.equal(kp.stationCount, 7);
  assert.equal(normalizeKpIndex([]), null);
  assert.equal(normalizeKpIndex([['h']] ), null);
});

test('scales normalize reads day-0 R/S/G', () => {
  const s = normalizeScales(SCALES_FIXTURE);
  assert.deepEqual({ R: s.R, S: s.S, G: s.G }, { R: 1, S: 0, G: 3 });
  assert.equal(s.stamp, '2026-01-15 04:05:00.000');
  assert.deepEqual(normalizeScales({}), { R: 0, S: 0, G: 0, stamp: null });
});

test('severity ladder: G3 warns, G4+ is critical', () => {
  assert.equal(spaceWeatherSeverity(5), 'critical');
  assert.equal(spaceWeatherSeverity(3), 'warning');
  assert.equal(spaceWeatherSeverity(1), 'watch');
  assert.equal(spaceWeatherSeverity(0), 'info');
});

test('space weather fetch: combines both products, fail-soft on either', async () => {
  const fetchFn = async (url) => ({
    ok: true,
    json: async () => (url.includes('k-index') ? KP_FIXTURE : SCALES_FIXTURE),
  });
  const out = await fetchSpaceWeather(fetchFn);
  assert.equal(out.id, 'space-weather:current');
  assert.equal(out.kp, 4.67);
  assert.equal(out.G, 3);
  assert.equal(out.severity, 'warning');
  assert.equal(await fetchSpaceWeather(async () => ({ ok: false })), null);
});

// ── Sentinel STAC catalog ────────────────────────────────────────────────

test('buildStacQuery: bbox and datetime pass through, defaults to SAR', () => {
  const q = buildStacQuery({ bbox: [30, 40, 40, 50], datetime: '2026-01-01/2026-01-15' });
  assert.deepEqual(q.collections, ['SENTINEL-1']);
  assert.deepEqual(q.bbox, [30, 40, 40, 50]);
  assert.equal(q.datetime, '2026-01-01/2026-01-15');
  assert.equal(q.limit, 20);
  const bare = buildStacQuery({});
  assert.ok(!('bbox' in bare) && !('datetime' in bare));
});

const STAC_FIXTURE = {
  features: [
    {
      id: 'S1A_IW_GRDH_20260114', collection: 'SENTINEL-1', bbox: [34, 35, 36, 37],
      properties: { datetime: '2026-01-14T15:30:00Z', platform: 'sentinel-1a', 'sar:product_type': 'GRD' },
      assets: { thumbnail: { href: 'https://example/thumb.png' } },
    },
    {
      id: 'S1B_EW_GRDH_20260110', collection: 'SENTINEL-1', bbox: [30, 33, 32, 35],
      properties: { datetime: '2026-01-10T04:00:00Z', platform: 'sentinel-1b' },
    },
    { id: 'BROKEN' }, // dropped: no bbox
  ],
};

test('STAC normalize: centroid, newest first, thumbnail carried, malformed dropped', () => {
  const out = normalizeStacItems(STAC_FIXTURE);
  assert.equal(out.count, 2);
  const [first, second] = out.items;
  assert.equal(first.id, 'sentinel:S1A_IW_GRDH_20260114');
  assert.deepEqual({ lat: first.lat, lon: first.lon }, { lat: 36, lon: 35 });
  assert.equal(first.productType, 'GRD');
  assert.equal(first.thumbnail, 'https://example/thumb.png');
  assert.equal(second.datetime, '2026-01-10T04:00:00Z');
  assert.equal(second.thumbnail, null);
  assert.equal(normalizeStacItems(null).count, 0);
});

test('STAC fetch: POSTs the built query, fail-soft', async () => {
  let seenBody = null;
  const ok = await fetchSentinelAcquisitions({ bbox: [0, 0, 1, 1] }, async (url, init) => {
    seenBody = JSON.parse(init.body);
    return { ok: true, json: async () => STAC_FIXTURE };
  });
  assert.equal(ok.count, 2);
  assert.deepEqual(seenBody.bbox, [0, 0, 1, 1]);
  assert.equal(await fetchSentinelAcquisitions({}, async () => ({ ok: false })), null);
});
