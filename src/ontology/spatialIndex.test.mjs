import test from 'node:test';
import assert from 'node:assert/strict';
import { spatialCandidatePairs } from './spatialIndex.js';

function hasPair(pairs, a, b) {
  return pairs.some(([i, j]) => i === a && j === b);
}

test('spatial index keeps nearby dateline-crossing points as candidates', () => {
  const objects = [
    { lat: 0, lon: 179.9 },
    { lat: 0, lon: -179.9 },
    { lat: 0, lon: 0 },
  ];
  const pairs = spatialCandidatePairs(objects, 50);
  assert.equal(hasPair(pairs, 0, 1), true);
  assert.equal(hasPair(pairs, 0, 2), false);
});

test('spatial index keeps nearby polar points as candidates', () => {
  const objects = [
    { lat: 89.8, lon: 0 },
    { lat: 89.8, lon: 120 },
    { lat: -20, lon: 120 },
  ];
  const pairs = spatialCandidatePairs(objects, 50);
  assert.equal(hasPair(pairs, 0, 1), true);
  assert.equal(hasPair(pairs, 0, 2), false);
});

test('spatial index prunes a globally sparse picture', () => {
  const objects = [];
  for (let lat = -80; lat <= 80; lat += 20) {
    for (let lon = -180; lon < 180; lon += 20) objects.push({ lat, lon });
  }
  const n = objects.length;
  const allPairs = n * (n - 1) / 2;
  const candidates = spatialCandidatePairs(objects, 250);
  assert.ok(candidates.length < allPairs / 10, `${candidates.length} should be far below ${allPairs}`);
});

test('invalid or non-positive radius yields no candidates', () => {
  assert.deepEqual(spatialCandidatePairs([{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }], 0), []);
  assert.deepEqual(spatialCandidatePairs([{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }], NaN), []);
});
