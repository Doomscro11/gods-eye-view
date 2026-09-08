// src/data/satPasses.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import {
  subpointAt, footprintRadiusDeg, centralAngleDeg, footprintAt, coversAt,
  listPasses, groundTrack, EARTH_RADIUS_KM,
} from './satPasses.js';

// Canonical archived ISS TLE (epoch 2008-09-20 ~12:25 UTC) — same fixture as
// issPass.test.mjs so both modules agree on the same sky.
const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const FROM_MS = Date.UTC(2008, 8, 20, 12, 30, 0);
const AUSTIN = { latDeg: 30.2672, lonDeg: -97.7431 };

test('subpoint stays within the orbital inclination band', () => {
  const satrec = twoline2satrec(L1, L2);
  const sub = subpointAt(satrec, FROM_MS);
  assert.ok(sub);
  assert.ok(Math.abs(sub.latDeg) <= 51.65, `lat ${sub.latDeg} exceeds inclination`);
  assert.ok(sub.lonDeg >= -180 && sub.lonDeg <= 180);
  assert.ok(sub.altKm > 300 && sub.altKm < 450, `unexpected ISS altitude ${sub.altKm}`);
});

test('footprint radius matches horizon geometry for LEO altitude', () => {
  const satrec = twoline2satrec(L1, L2);
  const fp = footprintAt(satrec, FROM_MS);
  assert.ok(fp);
  // At ~350-420 km the zero-elevation footprint spans ~19-22 degrees.
  assert.ok(fp.radiusDeg > 15 && fp.radiusDeg < 25, `radiusDeg ${fp.radiusDeg}`);
  assert.ok(Math.abs(fp.radiusKm - fp.radiusDeg * (Math.PI / 180) * EARTH_RADIUS_KM) < 1);
  assert.equal(footprintRadiusDeg(0), 0);
  assert.equal(footprintRadiusDeg(Number.NaN), 0);
});

test('coversAt: subpoint yes, antipode no', () => {
  const satrec = twoline2satrec(L1, L2);
  const fp = footprintAt(satrec, FROM_MS);
  assert.ok(coversAt(satrec, FROM_MS, fp.latDeg, fp.lonDeg));
  const antipodeLat = -fp.latDeg;
  const antipodeLon = fp.lonDeg > 0 ? fp.lonDeg - 180 : fp.lonDeg + 180;
  assert.equal(coversAt(satrec, FROM_MS, antipodeLat, antipodeLon), false);
  // Just inside the limb counts; far outside does not.
  assert.ok(coversAt(satrec, FROM_MS, fp.latDeg + fp.radiusDeg * 0.9, fp.lonDeg));
  assert.equal(coversAt(satrec, FROM_MS, fp.latDeg + fp.radiusDeg * 2, fp.lonDeg), false);
});

test('centralAngleDeg: zero for identical points, ~90 for quarter meridian', () => {
  assert.equal(centralAngleDeg(10, 20, 10, 20), 0);
  const quarter = centralAngleDeg(0, 0, 90, 0);
  assert.ok(Math.abs(quarter - 90) < 1e-9);
});

test('listPasses returns ordered, non-overlapping passes', () => {
  const satrec = twoline2satrec(L1, L2);
  const passes = listPasses({ satrec, ...AUSTIN, fromMs: FROM_MS, count: 3, minElevDeg: 10, horizonHours: 24 });
  assert.ok(passes.length >= 2, `expected ≥2 ISS passes in 72h of scanning, got ${passes.length}`);
  for (let i = 1; i < passes.length; i += 1) {
    assert.ok(passes[i].riseMs >= passes[i - 1].setMs, 'passes must not overlap');
  }
  for (const p of passes) {
    assert.ok(p.maxElevDeg >= 10);
    assert.ok(p.riseMs < p.maxElevMs && p.maxElevMs < p.setMs);
  }
});

test('groundTrack yields antimeridian-safe segments', () => {
  const satrec = twoline2satrec(L1, L2);
  const segments = groundTrack({
    satrec, fromMs: FROM_MS, durationSec: 3 * 92 * 60, stepSec: 60,
  });
  assert.ok(segments.length >= 1);
  let total = 0;
  for (const seg of segments) {
    assert.ok(seg.length > 1);
    for (let i = 1; i < seg.length; i += 1) {
      assert.ok(Math.abs(seg[i].lonDeg - seg[i - 1].lonDeg) <= 180,
        'segment must never jump the antimeridian');
      assert.ok(seg[i].t > seg[i - 1].t);
    }
    // Geodetic latitude of the subpoint slightly exceeds the 51.64°
    // inclination (geocentric vs geodetic), so allow a small margin.
    for (const p of seg) assert.ok(Math.abs(p.latDeg) <= 52.0, `lat ${p.latDeg}`);
    total += seg.length;
  }
  assert.ok(total > 200, `3 orbits at 60s steps should give ~276 samples, got ${total}`);
});
