// src/ontology/phase5Runtime.js
/**
 * Phase 5 runtime — the polling loop that turns the derived-feed modules
 * into a living picture. Each feed has its own cadence; every cycle ends in
 * syncDerivedFeeds so the ontology, the rules, and the alert rail see it.
 *
 * Fail-soft by design: a feed that errors or 500s is skipped this cycle and
 * tried again next cadence — a dead government endpoint must never take the
 * globe down with it.
 *
 * Fully injectable (fetch, records source, timers, clock) so tests never
 * touch the network or the wall clock.
 *
 * @module ontology/phase5Runtime
 */

import { detectGpsJamZones } from '../data/gpsJamming.js';
import { fetchKevCatalog } from '../data/kevCatalog.js';
import { fetchEonetEvents } from '../data/eonetEvents.js';
import { fetchSpaceWeather } from '../data/spaceWeather.js';
import { fetchSentinelAcquisitions } from '../data/sentinelCatalog.js';
import { fetchRawAdsb } from '../data/adsbRawTap.js';
import { createTleCatalog } from '../data/tleCatalog.js';
import { syncDerivedFeeds } from './derivedFeeds.js';

export const PHASE5_CADENCE_MS = Object.freeze({
  jam: 60_000,           // recompute over the current fleet every minute
  spaceWeather: 5 * 60_000,
  eonet: 15 * 60_000,
  kev: 6 * 3600_000,
  sentinel: 30 * 60_000, // only when an area of interest is configured
  tle: 6 * 3600_000,     // TLEs age in hours, not seconds
});

export function createDerivedFeedsRuntime({
  store,
  fetchFn = globalThis.fetch,
  getAdsbRecords = null, // async or sync; defaults to the raw ADS-B tap
  getAoiBbox = () => null, // [w, s, e, n] or null when no AOI is set
  tleCatalog = null,     // injectable; defaults to the CelesTrak proxy tap
  now = Date.now,
  cadence = PHASE5_CADENCE_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const lastRun = { jam: 0, spaceWeather: 0, eonet: 0, kev: 0, sentinel: 0, tle: 0 };
  const tle = tleCatalog || createTleCatalog({ fetchFn, now });
  let timer = null;

  /** One pass over due feeds. Exported-shape: returns what it synced. */
  async function cycle({ force = false } = {}) {
    const t = now();
    const due = (key) => force || t - lastRun[key] >= cadence[key];
    const feeds = {};

    if (due('tle')) {
      lastRun.tle = t;
      // Cache refresh for the COVERS deriver — fail-soft, keeps last good.
      await tle.refresh({ force });
    }
    if (due('jam')) {
      lastRun.jam = t;
      // Raw rows come from the derived feed's OWN tap by default — the big
      // display layers stay untouched. An injected source (tests, a future
      // shared cache) wins when provided.
      const records = getAdsbRecords ? await getAdsbRecords() : await fetchRawAdsb(fetchFn);
      feeds.jamZones = detectGpsJamZones(records || []);
    }
    if (due('spaceWeather')) {
      lastRun.spaceWeather = t;
      const sw = await fetchSpaceWeather(fetchFn);
      if (sw) feeds.spaceWeather = sw;
    }
    if (due('eonet')) {
      lastRun.eonet = t;
      const ev = await fetchEonetEvents(fetchFn);
      if (ev) feeds.eonet = ev;
    }
    if (due('kev')) {
      lastRun.kev = t;
      const kev = await fetchKevCatalog(fetchFn);
      if (kev) feeds.kev = kev;
    }
    const bbox = getAoiBbox();
    if (bbox && due('sentinel')) {
      lastRun.sentinel = t;
      const from = new Date(t - 7 * 24 * 3600_000).toISOString();
      const to = new Date(t).toISOString();
      const acq = await fetchSentinelAcquisitions({ bbox, datetime: `${from}/${to}` }, fetchFn);
      if (acq) feeds.sentinel = acq;
    }

    if (Object.keys(feeds).length) syncDerivedFeeds(store, feeds);
    return feeds;
  }

  return {
    cycle,
    /** Run one immediate cycle, then poll at the fastest cadence. */
    start({ immediate = true } = {}) {
      if (timer) return;
      if (immediate) cycle({ force: true });
      const tick = Math.min(...Object.values(cadence));
      timer = setIntervalFn(() => { cycle(); }, tick);
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
    get running() { return timer != null; },
    /** Satrec snapshot for the store's COVERS deriver (cached, fail-soft). */
    getSatrecs: () => tle.getSatrecs(),
  };
}
