// src/ontology/jamZoneOverlay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JAM_ZONE_COLORS,
  zoneBounds,
  zoneLabel,
  planZoneSync,
  createJamZoneOverlay,
} from './jamZoneOverlay.js';

const ZONE = {
  id: 'gps-jam:24:45',
  cellKey: '24:45',
  latDeg: 24.5,
  lonDeg: 45.5,
  gridSizeDeg: 1,
  total: 11,
  known: 11,
  degraded: 8,
  ratio: 8 / 11,
  severity: 'critical',
};

test('zoneBounds centers the cell on latDeg/lonDeg', () => {
  assert.deepEqual(zoneBounds(ZONE), { west: 45, south: 24, east: 46, north: 25 });
});

test('zoneBounds rejects zones without a finite center', () => {
  assert.equal(zoneBounds({ ...ZONE, latDeg: NaN }), null);
  assert.equal(zoneBounds(null), null);
});

test('zoneBounds honors a non-default grid size', () => {
  const bounds = zoneBounds({ ...ZONE, gridSizeDeg: 2, latDeg: 25, lonDeg: 46 });
  assert.deepEqual(bounds, { west: 45, south: 24, east: 47, north: 26 });
});

test('zoneLabel carries indication semantics, severity, ratio, and counts', () => {
  assert.equal(zoneLabel(ZONE), 'GNSS INTERFERENCE INDICATION · critical · 73% degraded (8/11)');
  assert.equal(zoneLabel({ id: 'x' }), 'GNSS INTERFERENCE INDICATION · watch');
  assert.equal(zoneLabel(null), 'GNSS INTERFERENCE INDICATION');
});

test('severity spec covers the three levels', () => {
  assert.deepEqual(Object.keys(JAM_ZONE_COLORS).sort(), ['critical', 'warning', 'watch']);
});

test('planZoneSync adds new, removes evicted, keeps stable zones', () => {
  const NEW_ZONE = { ...ZONE, id: 'gps-jam:30:50' };
  const plan = planZoneSync(['gps-jam:24:45', 'gps-jam:9:9'], [ZONE, NEW_ZONE]);
  assert.deepEqual(plan.add, [NEW_ZONE]);
  assert.deepEqual(plan.remove, ['gps-jam:9:9']);
  assert.deepEqual(plan.keep, ['gps-jam:24:45']);
});

test('planZoneSync skips zones without bounds', () => {
  const plan = planZoneSync([], [{ id: 'bad', latDeg: NaN, lonDeg: 1 }]);
  assert.deepEqual(plan, { add: [], remove: [], keep: [] });
});

test('overlay syncs entities from the store and sweeps evictions', () => {
  const entities = [];
  const viewer = {
    entities: {
      add: (def) => { entities.push(def); return def; },
      remove: (entity) => { entities.splice(entities.indexOf(entity), 1); },
    },
    scene: { requestRender: () => {} },
  };
  let zones = [ZONE];
  const store = {
    objectsOfType: (type) => (type === 'gps-jam-zone'
      ? zones.map((z) => ({ id: z.id, attrs: z })) : []),
  };
  const timers = [];
  const overlay = createJamZoneOverlay({
    viewer,
    store,
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return 1; },
    clearIntervalFn: () => {},
  });
  assert.equal(overlay.entityCount(), 1);
  assert.equal(entities.length, 1);
  assert.match(entities[0].name, /^GNSS INTERFERENCE INDICATION/);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15000);

  zones = [];
  overlay.sync();
  assert.equal(overlay.entityCount(), 0);
  assert.equal(entities.length, 0);
  overlay.destroy();
});

test('overlay is fail-soft when the store throws', () => {
  const viewer = {
    entities: { add: () => ({}), remove: () => {} },
    scene: { requestRender: () => {} },
  };
  const store = { objectsOfType: () => { throw new Error('boom'); } };
  const overlay = createJamZoneOverlay({ viewer, store, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  assert.equal(overlay.entityCount(), 0);
  overlay.destroy();
});
