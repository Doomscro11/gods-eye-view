/**
 * Scenario engine — staged what-if rehearsal against the ontology.
 *
 * Doctrine (Tier 2, Foundry Scenarios): edits are STAGED against a branch of
 * the ontology, never applied to live state; functions (here: alert rules)
 * recompute against the staged state; outcomes are compared across branches;
 * only then is a scenario applied or discarded. That makes simulation safe,
 * collaborative, and auditable — test the decision before committing it.
 *
 * Implementation: a branch is a full ontology store seeded from a snapshot of
 * live state. Rules are pure, so evaluating the same rule set on live and
 * branch stores yields a clean, deterministic delta.
 *
 * @module scenario/engine
 */

import { createOntologyStore } from '../ontology/store.js';
import { evaluateRules, defaultRules } from '../ontology/rules.js';

let scenarioSeq = 0;

export function createScenarioEngine(liveStore, { rulesFactory = defaultRules } = {}) {
  const branches = new Map();

  function beginScenario(name = 'scenario') {
    const id = `scenario:${++scenarioSeq}`;
    const branchStore = createOntologyStore({ now: () => liveStoreBranchClock(liveStore) });
    branchStore.restore(liveStore.snapshot());
    const branch = {
      id,
      name,
      store: branchStore,
      edits: [],
      createdRevision: liveStore.stateRevision(),
    };
    branches.set(id, branch);
    return { id, name, store: branchStore };
  }

  function stageEdit(branchId, edit) {
    const branch = branches.get(branchId);
    if (!branch) return { ok: false, error: `unknown scenario: ${branchId}` };
    switch (edit?.kind) {
      case 'upsert':
      case 'weather-cell':
      case 'corridor': {
        const type = edit.kind === 'upsert' ? edit.type
          : edit.kind === 'weather-cell' ? 'weather-cell'
          : (edit.record?.type === 'region' ? 'region' : 'installation');
        const object = branch.store.upsertObject(type, edit.record || {});
        if (!object) return { ok: false, error: 'edit has no usable identity' };
        branch.edits.push(edit);
        return { ok: true, objectId: object.id };
      }
      case 'remove': {
        const removed = branch.store.removeObject(edit.objectId, { reason: 'scenario' });
        if (!removed) return { ok: false, error: `unknown object: ${edit.objectId}` };
        branch.edits.push(edit);
        return { ok: true, objectId: edit.objectId };
      }
      default:
        return { ok: false, error: `unknown edit kind: ${edit?.kind}` };
    }
  }

  function compare(branchId, rules = rulesFactory()) {
    const branch = branches.get(branchId);
    if (!branch) return null;
    branch.store.recomputeRelationships();
    liveStore.recomputeRelationships();
    const liveAlerts = evaluateRules(liveStore, rules);
    const branchAlerts = evaluateRules(branch.store, rules);
    const liveIds = new Set(liveAlerts.map((a) => a.id));
    const branchIds = new Set(branchAlerts.map((a) => a.id));
    const liveObjects = new Map(liveStore.allObjects().map((o) => [o.id, o]));
    const objectDiffs = [];
    for (const o of branch.store.allObjects()) {
      const base = liveObjects.get(o.id);
      if (!base) objectDiffs.push({ objectId: o.id, change: 'added' });
      else if (base.lat !== o.lat || base.lon !== o.lon
               || stableStringify(base.attrs) !== stableStringify(o.attrs)) {
        objectDiffs.push({ objectId: o.id, change: 'modified' });
      }
    }
    for (const id of liveObjects.keys()) {
      if (!branch.store.getObject(id)) objectDiffs.push({ objectId: id, change: 'removed' });
    }
    return {
      addedAlerts: branchAlerts.filter((a) => !liveIds.has(a.id)),
      removedAlerts: liveAlerts.filter((a) => !branchIds.has(a.id)),
      objectDiffs,
      branchAlertCount: branchAlerts.length,
      liveAlertCount: liveAlerts.length,
    };
  }

  function apply(branchId, { force = false } = {}) {
    const branch = branches.get(branchId);
    if (!branch) return { ok: false, error: `unknown scenario: ${branchId}` };
    const staleBy = liveStore.stateRevision() - branch.createdRevision;
    if (staleBy > 0 && !force) {
      return {
        ok: false,
        error: `live picture is ${staleBy} state revision(s) newer than this scenario — review or force-apply`,
        stale: true,
        staleBy,
      };
    }
    liveStore.restore(branch.store.snapshot(), { markStateChange: true });
    if (staleBy > 0) {
      liveStore.recordEvent('scenario-force-applied', {
        scenarioId: branch.id, name: branch.name, staleBy,
      });
    }
    liveStore.recordEvent('scenario-applied', {
      scenarioId: branch.id, name: branch.name, edits: branch.edits.length,
    });
    branches.delete(branchId);
    return { ok: true, applied: branch.name, edits: branch.edits.length };
  }

  function discard(branchId) {
    return branches.delete(branchId);
  }

  return {
    beginScenario,
    stageEdit,
    compare,
    apply,
    discard,
    listScenarios: () => [...branches.values()].map((b) => ({
      id: b.id, name: b.name, edits: b.edits.length,
    })),
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function liveStoreBranchClock(liveStore) {
  const events = liveStore.getEvents();
  return events.length ? events[events.length - 1].t : Date.now();
}
