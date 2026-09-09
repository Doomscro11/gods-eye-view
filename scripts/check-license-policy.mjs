import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const policyPath = path.join(ROOT, 'config', 'data-license-policy.json');
const profile = String(process.env.GEV_BUILD_PROFILE || 'community').trim().toLowerCase();
const reviewed = new Set(
  String(process.env.GEV_COMMERCIAL_REVIEWED_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function fail(message) {
  console.error(`[license-policy] ERROR: ${message}`);
  process.exitCode = 1;
}

let policy;
try {
  policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
} catch (error) {
  console.error(`[license-policy] ERROR: could not read ${policyPath}: ${error.message}`);
  process.exit(1);
}

if (policy?.schemaVersion !== 1 || !Array.isArray(policy?.sources)) {
  console.error('[license-policy] ERROR: invalid policy schema');
  process.exit(1);
}

for (const source of policy.sources) {
  if (!source?.id || !source?.path || !source?.license) {
    fail(`policy entry is missing id/path/license: ${JSON.stringify(source)}`);
    continue;
  }
  const absolute = path.join(ROOT, source.path);
  if (!fs.existsSync(absolute)) {
    fail(`${source.id}: declared path does not exist: ${source.path}`);
    continue;
  }

  if (profile !== 'commercial') continue;
  if (reviewed.has(source.id)) continue;

  if (source.commercialAllowed === false) {
    fail(`${source.id}: ${source.license} is not cleared for commercial use; ${source.commercialAction || 'remove or separately license it'}`);
  } else if (source.reviewRequired || source.commercialAllowed === null) {
    fail(`${source.id}: commercial license review is required before release`);
  }
}

if (!process.exitCode) {
  const restricted = policy.sources.filter((source) => source.commercialAllowed === false).length;
  const reviewRequired = policy.sources.filter((source) => source.reviewRequired || source.commercialAllowed === null).length;
  console.log(`[license-policy] profile=${profile} sources=${policy.sources.length} restricted=${restricted} reviewRequired=${reviewRequired}`);
  if (profile === 'commercial' && reviewed.size) {
    console.log(`[license-policy] explicit reviewed/licensed overrides: ${[...reviewed].sort().join(', ')}`);
  }
}
