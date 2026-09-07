/**
 * Replay engine — the living twin's memory.
 *
 * Doctrine (Tier 1 + Machinery/process-mining analog): the ontology's event
 * log is the record of how entities moved through states over time. Replay
 * reconstructs the picture at any timestamp by folding upsert/remove events;
 * anomaly detection reads the same log for the patterns a live glance misses
 * — gaps (dark activity), teleports (impossible movement), and churn
 * (objects flapping in and out of the picture).
 *
 * Pure and deterministic: the log in, the same reconstruction out.
 *
 * @module replay/engine
 */

import { haversineKm } from '../data/analystEngine.js';

/**
 * Reconstruct object state at time `t` by folding the event log.
 * Events carry the full object on upsert, so the fold needs no store.
 * @param {object[]} events From store.getEvents().
 * @param {number} t Timestamp (ms epoch).
 * @returns {Map<string, object>} objectId → object as of t.
 */
export function stateAt(events, t) {
  const state = new Map();
  for (const e of events || []) {
    if (e.t > t) break; // log is time-ordered
    if (e.kind === 'upsert' && e.object) state.set(e.objectId, e.object);
    else if (e.kind === 'remove') state.delete(e.objectId);
  }
  return state;
}

/**
 * A replay cursor: seek(t) answers the picture at t; timeline() answers the
 * span the log actually covers so a surface can bound its slider.
 */
export function createReplayCursor(store) {
  return {
    seek(t) {
      return [...stateAt(store.getEvents(), t).values()];
    },
    timeline() {
      const events = store.getEvents();
      if (!events.length) return { start: null, end: null, events: 0 };
      return { start: events[0].t, end: events[events.length - 1].t, events: events.length };
    },
    /** Decision points: scenario commits and other audit markers. */
    markers() {
      return store.getEvents().filter((e) => e.kind === 'scenario-applied');
    },
  };
}

/** Maximum plausible speed (km/h) by object type, for teleport detection. */
export const MAX_PLAUSIBLE_SPEED_KMH = Object.freeze({
  aircraft: 1200,
  vessel: 70,
  satellite: 28000,
  default: 2000,
});

/**
 * Detect anomalies in the event log.
 * @param {object[]} events From store.getEvents().
 * @param {object} [options]
 * @param {number} [options.gapMs] Silence longer than this = dark activity.
 * @param {number} [options.flapCount] This many remove+re-add cycles = churn.
 * @returns {object[]} Anomalies {kind, objectId, evidence}, time-sorted.
 */
export function detectAnomalies(events, {
  gapMs = 30 * 60 * 1000,
  flapCount = 3,
} = {}) {
  const anomalies = [];
  /** objectId → {upserts:[{t,lat,lon,type}], removes:number} */
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
    // Dark activity: silent gaps BETWEEN reports (an object that never
    // reported isn't dark; an object that STOPPED is).
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
      // Teleport: implied speed between consecutive reports is implausible.
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
            evidence: { distanceKm: Math.round(km), impliedSpeedKmh: Math.round(speed), maxPlausibleKmh: max },
          });
        }
      }
    }
    // Churn: the object flapped out of the picture repeatedly.
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
