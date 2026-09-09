#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const licenseText = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const dataSourcesText = fs.readFileSync(path.join(root, 'DATA_SOURCES.md'), 'utf8');

const entries = [
  {
    id: 'telegeography-submarine-cables',
    kind: 'bundled-data',
    path: 'src/data/local_data/telegeography_submarine_cables',
    license: 'CC-BY-NC-SA-3.0',
    commercial: false,
    remediation: 'Remove from commercial distributions or obtain a commercial licence from TeleGeography.',
  },
  {
    id: 'public-models',
    kind: 'bundled-assets',
    path: 'public/models',
    license: 'per-asset; see public/models/README.md',
    commercial: 'review-required',
  },
  {
    id: 'opensky',
    kind: 'runtime-provider',
    license: 'provider terms / non-commercial default access',
    commercial: 'permission-required',
  },
  {
    id: 'google-news-rss',
    kind: 'runtime-provider',
    license: 'Google News terms; personal/non-commercial use',
    commercial: false,
    remediation: 'Disable or replace for commercial deployments, or obtain permission.',
  },
  {
    id: 'google-maps-platform',
    kind: 'runtime-provider',
    license: 'Google Maps Platform terms',
    commercial: 'byok-terms',
  },
  {
    id: 'osm-derived-data',
    kind: 'bundled/runtime-data',
    license: 'ODbL-1.0 where applicable',
    commercial: true,
    conditions: ['attribution', 'database share-alike where applicable'],
  },
];

const requiredNotices = [
  ['LICENSE', licenseText, 'TeleGeography'],
  ['LICENSE', licenseText, 'NOT for commercial use'],
  ['DATA_SOURCES.md', dataSourcesText, 'OpenSky Network'],
  ['DATA_SOURCES.md', dataSourcesText, 'Google News RSS'],
  ['DATA_SOURCES.md', dataSourcesText, 'TeleGeography'],
];

let failed = false;
for (const [file, text, needle] of requiredNotices) {
  if (!text.includes(needle)) {
    console.error(`[license-guard] ${file} is missing required notice: ${needle}`);
    failed = true;
  }
}

const blockers = entries
  .filter((entry) => entry.commercial === false && entry.path)
  .filter((entry) => fs.existsSync(path.join(root, entry.path)))
  .map((entry) => entry.id);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  codeLicense: 'MIT',
  commercialDistributionReady: blockers.length === 0,
  commercialBlockersPresent: blockers,
  entries,
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} else {
  console.log(`[license-guard] tracking ${entries.length} third-party material/provider classes`);
  console.log(`[license-guard] commercial blockers currently bundled: ${blockers.length ? blockers.join(', ') : 'none'}`);
  console.log('[license-guard] required licence notices are present');
}

if (process.argv.includes('--require-commercial-ready') && blockers.length) {
  console.error(`[license-guard] commercial distribution blocked by: ${blockers.join(', ')}`);
  failed = true;
}

if (failed) process.exitCode = 1;
