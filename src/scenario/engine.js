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

/**
 * @param {object} liveStore The operator's live ontology store.
 * @param {object} [options]
 * @param {() => object[]} [options.rulesFactory] Rule set for both worlds.
 */
export function createScenarioEngine(liveStore, { rulesFactory = defaultRules } = {}) {
  /** @type {Map<string, object>} scenarioId → branch record */
  const branches = new Map();

  /**
   * Open a what-if branch. The branch reads the same past (snapshot) and
   * writes only its own staged future.
   * @returns {object} Branch handle {id, name, store}.
   */
  function beginScenario(name = 'scenario') {
    const id = `scenario:${++scenarioSeq}`;
    const branchStore = createOntologyStore({ now: () => liveStoreBranchClock(liveStore) });
    branchStore.restore(liveStore.snapshot());
    const branch = { id, name, store: branchStore, edits: [], createdSeq: liveStore.lastEventSeq() };
    branches.set(id, branch);
    return { id, name, store: branchStore };
  }

  /**
   * Stage an edit on a branch. Edits:
   *  - {kind:'upsert', type, record}        — add/move/hypothesize an object
   *  - {kind:'remove', objectId}            — asset lost / feed dark
   *  - {kind:'weather-cell', record}        — weather front staged as an object
   *  - {kind:'corridor', record}            — watched corridor (region/installation)
   * Live state is untouched by construction.
   */
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

  /**
   * Recompute relationships + rules on the branch and diff against live.
   * @returns {object} comparison {addedAlerts, removedAlerts, objectDiffs}
   */
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

  /**
   * Commit the branch: live state becomes the branch state, and the event log
   * records that a scenario was applied (auditability — the doctrine's
   * counterweight section made non-optional).
   *
   * Staleness guard: if the live picture moved on while the branch was open
   * (feeds kept polling), a blind apply would silently discard those updates.
   * Refuse unless the caller passes {force: true}; the refusal reports how
   * many events the branch is behind so the surface can show the conflict.
   */
  function apply(branchId, { force = false } = {}) {
    const branch = branches.get(branchId);
    if (!branch) return { ok: false, error: `unknown scenario: ${branchId}` };
    const staleBy = liveStore.lastEventSeq() - branch.createdSeq;
    if (staleBy > 0 && !force) {
      return {
        ok: false,
        error: `live picture is ${staleBy} event(s) newer than this scenario — review or force-apply`,
        stale: true,
        staleBy,
      };
    }
    liveStore.restore(branch.store.snapshot());
    if (staleBy > 0) {
      liveStore.recordEvent('scenario-force-applied', {
        scenarioId: branch.id, name: branch.name, staleBy,
      });
    }
    // Record the commit in live history so replay shows the decision point.
    liveStore.recordEvent('scenario-applied', {
      scenarioId: branch.id, name: branch.name, edits: branch.edits.length,
    });
    branches.delete(branchId);
    return { ok: true, applied: branch.name, edits: branch.edits.length };
  }

  /** Discard the branch. Live state was never touched. */
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

/** Key-sorted stringify: identical attrs must not diff on key order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Branch clock: scenario edits timestamp against the live store's latest
 * event so a branch never appears to come from the future of the log.
 */
function liveStoreBranchClock(liveStore) {
  const events = liveStore.getEvents();
  return events.length ? events[events.length - 1].t : Date.now();
}
