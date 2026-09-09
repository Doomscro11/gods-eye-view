import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyStore } from '../ontology/store.js';
import { evaluateRules, defaultRules } from '../ontology/rules.js';
import { composeBrief, renderBriefMarkdown, buildBrief } from './product.js';

function pictureWithBreach() {
  const store = createOntologyStore({ now: () => 1000 });
  store.upsertObject('installation', {
    id: 'strait', lat: 26, lon: 56, watch: { radiusKm: 200, severity: 'critical' },
  });
  store.upsertObject('vessel', { mmsi: 't1', name: 'MV BREACH', lat: 26.5, lon: 56.5 });
  store.upsertObject('aircraft', { icao24: 'a1', callsign: 'CAP01', lat: 40, lon: -100 });
  store.recomputeRelationships();
  return store;
}

test('composeBrief summarizes picture and alerts', () => {
  const store = pictureWithBreach();
  const alerts = evaluateRules(store, defaultRules());
  const brief = composeBrief({ store, alerts, now: () => 0 });
  assert.equal(brief.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(brief.totals, { objects: 3, alerts: alerts.length });
  assert.ok(brief.picture.some((p) => p.type === 'vessel' && p.count === 1));
  assert.equal(composeBrief({}), null);
});

test('renderBriefMarkdown names severity, object, evidence, and position', () => {
  const store = pictureWithBreach();
  const { markdown, alerts } = buildBrief({
    store, evaluate: evaluateRules, rules: defaultRules(), now: () => 0,
  });
  assert.ok(alerts.length >= 1);
  assert.match(markdown, /# Operational Brief/);
  assert.match(markdown, /vessel: 1/);
  assert.match(markdown, /\[CRITICAL\]\*\* MV BREACH \(vessel\) — corridor-breach/);
  assert.match(markdown, /26\.50°N, 56\.50°E/);
  assert.match(markdown, /client-side data only/);
});

test('brief renders the what-if delta when a scenario comparison is attached', () => {
  const store = pictureWithBreach();
  const scenario = {
    name: 'second tanker enters',
    comparison: {
      addedAlerts: [{ severity: 'warning', label: 'MV SECOND', ruleId: 'corridor-breach' }],
      removedAlerts: [],
      objectDiffs: [{ objectId: 'vessel:t2', change: 'added' }],
    },
  };
  const brief = composeBrief({
    store, alerts: evaluateRules(store, defaultRules()), scenario, now: () => 0,
  });
  const markdown = renderBriefMarkdown(brief);
  assert.match(markdown, /## What-if: second tanker enters/);
  assert.match(markdown, /New alerts under scenario: 1/);
  assert.match(markdown, /\[WARNING\] MV SECOND/);
  assert.match(markdown, /Objects changed: 1/);
});

test('empty picture renders honestly', () => {
  const store = createOntologyStore({ now: () => 1000 });
  const brief = composeBrief({ store, alerts: [], now: () => 0 });
  const markdown = renderBriefMarkdown(brief);
  assert.match(markdown, /No objects in the picture/);
  assert.match(markdown, /## Alerts \(0\)/);
});
