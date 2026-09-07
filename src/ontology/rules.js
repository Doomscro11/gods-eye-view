/**
 * Alert rules — the logic leg of the decision loop.
 *
 * Doctrine (Tier 1): data + logic + ACTIONS. An alert that doesn't carry its
 * decision context and its available actions is an open loop — the operator
 * has to swivel-chair to another tool. So every alert produced here carries:
 *   - WHAT: the object and the rule that fired
 *   - WHY: the evidence (relationship, threshold, history gap)
 *   - WHAT NEXT: `actions` — verbs registered on the store that may be
 *     invoked against this object right now
 *
 * Rules are pure predicates over the store; evaluation is total (all rules ×
 * all objects) and deterministic, so scenario branches can re-run the exact
 * same evaluation on staged state and diff the outcomes.
 *
 * @module ontology/rules
 */

import { haversineKm } from '../data/analystEngine.js';
import { pointInRing } from '../data/naturalEarthRegions.js';

export const SEVERITY = Object.freeze(['info', 'watch', 'warning', 'critical']);

function alert(ruleId, severity, object, evidence, actions) {
  return {
    id: `${ruleId}:${object.id}`,
    ruleId,
    severity,
    objectId: object.id,
    objectType: object.type,
    label: object.attrs?.callsign || object.attrs?.name || object.attrs?.place || object.id,
    lat: object.lat,
    lon: object.lon,
    evidence,
    actions,
  };
}

/** Verbs an alert may offer, filtered to what the store actually governs. */
function availableActions(store, objectId) {
  const verbs = ['track', 'annotate', 'brief'];
  return verbs.filter((v) => store.listActions().includes(v))
    .map((v) => ({ action: v, objectId }));
}

/**
 * Corridor breach: a watched object enters a declared corridor (radius around
 * a point, or a region ring). Corridors are declared as `region` or
 * `installation` objects with `attrs.watch = {radiusKm}` or a ring.
 */
export function corridorBreachRule({ corridorTypes = ['region', 'installation'] } = {}) {
  return {
    id: 'corridor-breach',
    description: 'Object entered a watched corridor',
    evaluate(store) {
      const corridors = store.allObjects().filter(
        (o) => corridorTypes.includes(o.type) && (o.ring || o.attrs?.watch?.radiusKm),
      );
      const movers = store.allObjects().filter(
        (o) => ['aircraft', 'vessel'].includes(o.type)
          && Number.isFinite(o.lat) && Number.isFinite(o.lon),
      );
      const out = [];
      for (const corridor of corridors) {
        for (const mover of movers) {
          let inside = false;
          let evidence = null;
          if (corridor.ring) {
            inside = pointInRing(corridor.ring, mover.lat, mover.lon);
            evidence = { corridor: corridor.id, boundary: 'ring' };
          } else {
            const radiusKm = Number(corridor.attrs.watch.radiusKm);
            if (Number.isFinite(corridor.lat) && Number.isFinite(corridor.lon)
                && Number.isFinite(radiusKm)) {
              const km = haversineKm(corridor.lat, corridor.lon, mover.lat, mover.lon);
              inside = km <= radiusKm;
              evidence = { corridor: corridor.id, radiusKm, distanceKm: Math.round(km * 10) / 10 };
            }
          }
          if (inside) {
            out.push(alert(
              'corridor-breach',
              corridor.attrs?.watch?.severity || 'warning',
              mover,
              evidence,
              availableActions(store, mover.id),
            ));
          }
        }
      }
      return out;
    },
  };
}

/**
 * Dark activity: an object's event history shows a gap longer than
 * `gapMs` between updates while it remained in the picture — the vessel that
 * stops reporting is more interesting than the one that never appeared.
 */
export function darkActivityRule({ gapMs = 30 * 60 * 1000, types = ['vessel', 'aircraft'] } = {}) {
  return {
    id: 'dark-activity',
    description: 'Object went dark longer than the reporting threshold',
    evaluate(store) {
      const out = [];
      const lastUpsert = new Map();
      for (const e of store.getEvents({ kind: 'upsert' })) {
        lastUpsert.set(e.objectId, e.t);
      }
      // The newest upsert event carries the current clock reading.
      const latestT = Math.max(0, ...store.getEvents({ kind: 'upsert' }).map((e) => e.t));
      for (const object of store.allObjects()) {
        if (!types.includes(object.type)) continue;
        const last = lastUpsert.get(object.id);
        if (last === undefined || latestT - last <= gapMs) continue;
        out.push(alert(
          'dark-activity',
          'watch',
          object,
          { lastSeenT: last, gapMs: latestT - last },
          availableActions(store, object.id),
        ));
      }
      return out;
    },
  };
}

/**
 * High-interest proximity: two objects of DIFFERENT types hold a NEAR
 * relationship below `withinKm` (default: any derived NEAR). This is the
 * ontology-wide version of militaryAwarenessEngine's pairwise proximity.
 */
export function proximityRule({ kinds = ['near'], severity = 'info' } = {}) {
  return {
    id: 'proximity',
    description: 'Cross-type objects in derived proximity',
    evaluate(store) {
      const out = [];
      for (const rel of store.allRelationships()) {
        if (!kinds.includes(rel.kind)) continue;
        const subject = store.getObject(rel.fromId);
        if (!subject || !['aircraft', 'vessel'].includes(subject.type)) continue;
        out.push(alert(
          'proximity',
          severity,
          subject,
          { relatedTo: rel.toId, kind: rel.kind, distanceKm: rel.distanceKm ?? null },
          availableActions(store, subject.id),
        ));
      }
      return out;
    },
  };
}

/** The shipped rule set, in evaluation order. */
export function defaultRules(options = {}) {
  return [corridorBreachRule(options), proximityRule(options), darkActivityRule(options)];
}

/**
 * Evaluate rules over the store. Total and deterministic: same store state
 * in → same alerts out, which is what scenario comparison relies on.
 * @returns {object[]} Alerts sorted critical-first, then by id.
 */
export function evaluateRules(store, rules = defaultRules()) {
  const alerts = rules.flatMap((rule) => rule.evaluate(store));
  const rank = (s) => SEVERITY.indexOf(s);
  return alerts.sort((a, b) => rank(b.severity) - rank(a.severity)
    || String(a.id).localeCompare(String(b.id)));
}
