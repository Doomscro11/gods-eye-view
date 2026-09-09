import test from 'node:test';
import assert from 'node:assert/strict';
import { alertSummaryLine, briefFilename } from './alertsPanel.js';

test('alertSummaryLine renders label, rule, and corridor evidence', () => {
  const line = alertSummaryLine({
    label: 'MV TEST', ruleId: 'corridor-breach',
    evidence: { corridor: 'installation:strait', distanceKm: 74.7 },
  });
  assert.equal(line, 'MV TEST · corridor-breach · corridor installation:strait');
});

test('alertSummaryLine renders dark-activity evidence in minutes', () => {
  const line = alertSummaryLine({
    label: 'V', ruleId: 'dark-activity', evidence: { gapMs: 90 * 60 * 1000 },
  });
  assert.equal(line, 'V · dark-activity · dark 90m');
});

test('alertSummaryLine degrades gracefully', () => {
  assert.equal(alertSummaryLine(null), '');
  assert.equal(alertSummaryLine({ label: 'X', ruleId: 'proximity' }), 'X · proximity');
});

test('briefFilename is filesystem-safe and sortable', () => {
  assert.equal(briefFilename('2026-09-07T08:30:00.000Z'), 'gev-brief-2026-09-07T08-30-00.md');
});
