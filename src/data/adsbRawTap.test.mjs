// src/data/adsbRawTap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRawAdsb, ADSB_RAW_URL } from './adsbRawTap.js';

test('returns raw rows from a healthy endpoint', async () => {
  const ac = [{ hex: 'a', lat: 1, lon: 2, nac_p: 9 }];
  const fetchFn = async (url) => {
    assert.equal(url, ADSB_RAW_URL);
    return { ok: true, json: async () => ({ ac }) };
  };
  assert.deepEqual(await fetchRawAdsb(fetchFn), ac);
});

test('custom url is honored', async () => {
  const fetchFn = async (url) => ({ ok: true, json: async () => ({ ac: [{ url }] }) });
  const rows = await fetchRawAdsb(fetchFn, { url: '/api/adsblol/all' });
  assert.equal(rows[0].url, '/api/adsblol/all');
});

test('fail-soft: http error, malformed payload, and throw all yield []', async () => {
  assert.deepEqual(await fetchRawAdsb(async () => ({ ok: false })), []);
  assert.deepEqual(await fetchRawAdsb(async () => ({ ok: true, json: async () => ({}) })), []);
  assert.deepEqual(await fetchRawAdsb(async () => { throw new Error('offline'); }), []);
});
