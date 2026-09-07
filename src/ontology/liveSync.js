/**
 * Live sync — feeds the ontology from the running app, and registers the
 * standard verbs that close the loop.
 *
 * Feed side: mirrors the SAME seam the analyst providers use
 * (`dataManager.layers.get(key).module.getAnalystRecords()`), so the ontology
 * sees exactly what the voice engine sees — one picture, two readers, never
 * two numbers.
 *
 * Verb side: the store is pure, so track/annotate/brief handlers are
 * INJECTED by the host surface (selection, annotations panel, brief
 * download). The store governs the path; the surface owns the effect.
 *
 * @module ontology/liveSync
 */

import { ONTOLOGY_BACKED_LAYERS } from './adapters.js';
import { evaluateRules, defaultRules } from './rules.js';
import { buildBrief } from '../brief/product.js';

/** Layers synced by default — every layer the analyst engine understands. */
export const DEFAULT_SYNC_LAYERS = ONTOLOGY_BACKED_LAYERS;

/**
 * Pull one sync cycle: read each enabled layer's analyst records and upsert
 * them into the store, then recompute relationships. Pure enough to drive
 * with a fake dataManager in tests.
 * @returns {object} {synced: {layerKey: count}, objects: total}
 */
export function syncOnce(store, dataManager, { layerKeys = DEFAULT_SYNC_LAYERS } = {}) {
  const synced = {};
  for (const layerKey of layerKeys) {
    const layer = dataManager?.layers?.get?.(layerKey);
    if (!layer || !dataManager.isEnabled(layerKey)) continue;
    const mod = layer.module;
    if (typeof mod?.getAnalystRecords !== 'function') continue;
    const records = mod.getAnalystRecords() || [];
    synced[layerKey] = store.upsertFromLayer(layerKey, records).length;
  }
  store.recomputeRelationships();
  return { synced, objects: store.allObjects().length };
}

/**
 * Create a polling sync. `start()` returns immediately; `stop()` is
 * idempotent. Timer handles stay injected-friendly (`setInterval`/`clearInterval`
 * overridable) so tests never wait on wall clock.
 */
export function createLiveSync(store, dataManager, {
  layerKeys = DEFAULT_SYNC_LAYERS,
  intervalMs = 5000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onAlerts = null,
  rules = defaultRules(),
} = {}) {
  let timer = null;
  let lastAlertIds = new Set();

  function cycle() {
    const result = syncOnce(store, dataManager, { layerKeys });
    if (onAlerts) {
      const alerts = evaluateRules(store, rules);
      const ids = new Set(alerts.map((a) => a.id));
      const fresh = alerts.filter((a) => !lastAlertIds.has(a.id));
      if (fresh.length) onAlerts(fresh, alerts);
      lastAlertIds = ids;
    }
    return result;
  }

  return {
    syncOnce: cycle,
    start() {
      if (timer !== null) return false;
      timer = setIntervalFn(cycle, intervalMs);
      return true;
    },
    stop() {
      if (timer === null) return false;
      clearIntervalFn(timer);
      timer = null;
      return true;
    },
    isRunning: () => timer !== null,
  };
}

/**
 * Register the standard verbs on the store. Every handler is host-injected:
 *  - track(objectId)     → onTrack(object)      (selection/camera surface)
 *  - annotate(objectId)  → onAnnotate(object)   (annotations surface)
 *  - brief()             → onBrief({brief, markdown}) — default renders
 *    Markdown so a host can offer copy/download with zero extra wiring.
 */
export function registerStandardVerbs(store, {
  onTrack = null,
  onAnnotate = null,
  onBrief = null,
  rules = defaultRules(),
} = {}) {
  store.defineAction('track', {
    guard: (object) => (object ? true : 'track needs an object'),
    handler: (object) => {
      onTrack?.(object);
      return { ok: true, objectId: object.id };
    },
  });
  store.defineAction('annotate', {
    guard: (object) => (object ? true : 'annotate needs an object'),
    handler: (object) => {
      onAnnotate?.(object);
      return { ok: true, objectId: object.id };
    },
  });
  store.defineAction('brief', {
    handler: (_object, _params, s) => {
      const artifact = buildBrief({ store: s, evaluate: evaluateRules, rules });
      onBrief?.(artifact);
      return { ok: true, ...artifact };
    },
  });
  return store;
}
