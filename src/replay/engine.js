/**
 * Replay engine — the living twin's memory.
 *
 * Replay reconstructs state by folding retained events over the ontology
 * store's replay baseline. The baseline is advanced whenever the bounded
 * event buffer evicts an old event, so end-of-log replay remains equal to the
 * live ontology even after long runtimes.
 *
 * @module replay/engine
 */

import { haversineKm } from '../data/analystEngine.js';

/**
 * Reconstruct object state at time `t`.
 * @param {object[]} events Retained events from store.getEvents().
 * @param {number} t Timestamp (ms epoch).
 * @param {object|null} baseline Optional {seq,t,objects} folded from evicted events.
 * @returns {Map<string, object>} objectId → object as of t.
 */
export function stateAt(events, t, baseline = null) {
  const state = new Map();
  const baselineSeq = Number(baseline?.seq) || 0;
  if (baseline?.objects && (baseline.t === null || t >= baseline.t)) {
    for (const object of baseline.objects) state.set(object.id, structuredClone(object));
  }
  for (const e of events || []) {
    if (e.seq <= baselineSeq) continue;
    if (e.t > t) break;
    if (e.kind === 'upsert' && e.object) state.set(e.objectId, e.object);
    else if (e.kind === 'remove') state.delete(e.objectId);
  }
  return state;
}

export function createReplayCursor(store) {
  return {
    seek(t) {
      const baseline = store.replayBaseline?.() ?? null;
      if (baseline?.t !== null && baseline?.t !== undefined && t < baseline.t) {
        throw new RangeError(`replay history begins at ${baseline.t}; requested ${t}`);
      }
      return [...stateAt(store.getEvents(), t, baseline).values()];
    },
    timeline() {
      const events = store.getEvents();
      const baseline = store.replayBaseline?.() ?? null;
      const hasBaseline = baseline?.t !== null && baseline?.t !== undefined;
      if (!events.length && !hasBaseline) {
        return { start: null, end: null, events: 0, truncated: false };
      }
      const start = hasBaseline ? baseline.t : events[0]?.t ?? null;
      const end = events.length ? events[events.length - 1].t : baseline.t;
      return {
        start,
        end,
        events: events.length,
        truncated: Boolean(hasBaseline),
        baselineSeq: baseline?.seq ?? 0,
      };
    },
    markers() {
      return store.getEvents().filter((e) => e.kind === 'scenario-applied');
    },
  };
}

export const MAX_PLAUSIBLE_SPEED_KMH = Object.freeze({
  aircraft: 1200,
  vessel: 70,
  satellite: 28000,
  default: 2000,
});

export function detectAnomalies(events, {
  gapMs = 30 * 60 * 1000,
  flapCount = 3,
} = {}) {
  const anomalies = [];
  const history = new Map();
  const track = (id) => {
    if (!history.has(id)) history.set(id, { upserts: [], removes: 0, type: null });
    return history.get(id);
  };

  for (const e of events || []) {
    if (e.kind === 'upsert' && e.object) {
      const h = track(e.objectId);
      h.type = e.objectType || e.object.type || h.type;
      h.upserts.push({ t: e.t, lat: e.object.lat, lon: e.object.lon });
    } else if (e.kind === 'remove') {
      track(e.objectId).removes += 1;
    }
  }

  for (const [objectId, h] of history) {
    for (let i = 1; i < h.upserts.length; i += 1) {
      const gap = h.upserts[i].t - h.upserts[i - 1].t;
      if (gap > gapMs) {
        anomalies.push({
          kind: 'dark-activity',
          objectId,
          t: h.upserts[i].t,
          evidence: { gapMs: gap, from: h.upserts[i - 1].t, to: h.upserts[i].t },
        });
      }
      const a = h.upserts[i - 1];
      const b = h.upserts[i];
      if (Number.isFinite(a.lat) && Number.isFinite(a.lon)
          && Number.isFinite(b.lat) && Number.isFinite(b.lon) && b.t > a.t) {
        const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
        const hours = (b.t - a.t) / 3600000;
        const speed = km / hours;
        const max = MAX_PLAUSIBLE_SPEED_KMH[h.type] ?? MAX_PLAUSIBLE_SPEED_KMH.default;
        if (speed > max) {
          anomalies.push({
            kind: 'teleport',
            objectId,
            t: b.t,
            evidence: {
              distanceKm: Math.round(km),
              impliedSpeedKmh: Math.round(speed),
              maxPlausibleKmh: max,
            },
          });
        }
      }
    }
    if (h.removes >= flapCount) {
      anomalies.push({
        kind: 'churn',
        objectId,
        t: h.upserts.length ? h.upserts[h.upserts.length - 1].t : 0,
        evidence: { removes: h.removes, upserts: h.upserts.length },
      });
    }
  }
  return anomalies.sort((a, b) => a.t - b.t || a.objectId.localeCompare(b.objectId));
}
