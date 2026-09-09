#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const entries = [
  {
    id: 'telegeography-submarine-cables',
    kind: 'bundled-data',
    path: 'src/data/local_data/telegeography_submarine_cables',
    license: 'CC-BY-NC-SA-3.0',
    commercial: false,
    action: 'Remove from commercial distributions or obtain a commercial licence from TeleGeography.',
  },
  {
    id: 'openstreetmap-derived-bundled-data',
    kind: 'bundled-data',
    path: 'src/data/local_data',
    license: 'ODbL-1.0 (selected datasets)',
    commercial: true,
    conditions: ['attribution', 'database share-alike where applicable'],
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
    action: 'Disable/replace for commercial deployments or obtain permission.',
  },
  {
    id: 'google-maps-platform',
    kind: 'runtime-provider',
    license: 'Google Maps Platform terms',
    commercial: 'byok-terms',
  },
];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function fail(message) {
  console.error(`[license-guard] ${message}`);
  process.exitCode = 1;
}

const licenseText = read('LICENSE');
const dataSourcesText = read('DATA_SOURCES.md');

const requiredNotices = [
  ['LICENSE', licenseText, 'TeleGeography'],
  ['LICENSE', licenseText, 'NOT for commercial use'],
  ['DATA_SOURCES.md', dataSourcesText, 'OpenSky Network'],
  ['DATA_SOURCES.md', dataSourcesText, 'Google News RSS'],
  ['DATA_SOURCES.md', dataSourcesText, 'TeleGeography'],
];

for (const [file, text, needle] of requiredNotices) {
  if (!text.includes(needle)) fail(`${file} no longer contains required third-party notice: ${needle}`);
}

const commercialForbiddenPresent = entries
  .filter((entry) => entry.commercial === false && entry.path)
  .filter((entry) => fs.existsSync(path.join(root, entry.path)))
  .map((entry) => entry.id);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  codeLicense: 'MIT',
  commercialDistributionReady: commercialForbiddenPresent.length === 0,
  commercialBlockersPresent: commercialForbiddenPresent,
  entries,
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} else {
  console.log(`[license-guard] ${entries.length} material/provider classes tracked.`);
  if (commercialForbiddenPresent.length) {
    console.log(`[license-guard] Commercial build blockers currently bundled: ${commercialForbiddenPresent.join(', ')}`);
  }
  console.log('[license-guard] Required licence notices are present.');
}

if (process.argv.includes('--require-commercial-ready') && commercialForbiddenPresent.length) {
  fail(`commercial distribution is blocked by: ${commercialForbiddenPresent.join(', ')}`);
}
