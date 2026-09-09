// src/data/tleCatalog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTleCatalog, parseTleText, noradFromLine2, TLE_DEFAULT_GROUPS,
} from './tleCatalog.js';

const ISS = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26015.50000000  .00016717  00000-0  10270-3 0  9000',
  '2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.72147127400000',
].join('\n');
const CSS = [
  'CSS (TIANHE)',
  '1 48274U 21035A   26015.50000000  .00016717  00000-0  10270-3 0  9000',
  '2 48274  41.4700 208.9163 0006703  69.9862  25.2906 15.62147127400000',
].join('\n');

function fetchWith(groups) {
  return async (url) => {
    const group = url.split('/').pop();
    if (!(group in groups)) return { ok: false, text: async () => '' };
    return { ok: true, text: async () => groups[group] };
  };
}

test('parseTleText reads 3-line groups and skips junk', () => {
  const parsed = parseTleText(`garbage line\n${ISS}\ntrailing`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'ISS (ZARYA)');
  assert.ok(parsed[0].line1.startsWith('1 '));
});

test('noradFromLine2 extracts the catalog number', () => {
  assert.equal(noradFromLine2('2 25544  51.6400 208.9163 0006703'), '25544');
});

test('refresh builds satrecs across groups, deduped by NORAD id', async () => {
  const cat = createTleCatalog({ fetchFn: fetchWith({ stations: `${ISS}\n${CSS}`, visual: ISS }) });
  const n = await cat.refresh({ force: true });
  assert.equal(n, 2);
  const entries = cat.getSatrecs();
  assert.deepEqual(entries.map((e) => e.noradId).sort(), ['25544', '48274']);
  assert.ok(entries.every((e) => e.satrec && !e.satrec.error));
  assert.ok(cat.isStale() === false);
});

test('TTL gates refresh; force overrides', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const cat = createTleCatalog({
    fetchFn: async (url) => { calls += 1; return fetchWith({ stations: ISS })(url); },
    now: () => clock,
    groups: ['stations'],
    ttlMs: 1000,
  });
  await cat.refresh();
  await cat.refresh(); // within TTL — no fetch
  assert.equal(calls, 1);
  clock += 2000;
  await cat.refresh(); // stale — refetches
  assert.equal(calls, 2);
  await cat.refresh({ force: true });
  assert.equal(calls, 3);
});

test('fail-soft: total failure keeps the last good cache', async () => {
  let fail = false;
  const cat = createTleCatalog({
    fetchFn: async (url) => {
      if (fail) throw new Error('offline');
      return fetchWith({ stations: ISS })(url);
    },
    groups: ['stations'],
  });
  await cat.refresh({ force: true });
  assert.equal(cat.getSatrecs().length, 1);
  fail = true;
  await cat.refresh({ force: true }); // must not throw, must not clear
  assert.equal(cat.getSatrecs().length, 1);
});

test('default groups are the satellite layer pair', () => {
  assert.deepEqual([...TLE_DEFAULT_GROUPS], ['stations', 'visual']);
});
