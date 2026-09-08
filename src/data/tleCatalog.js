// src/data/tleCatalog.js
/**
 * TLE catalog tap for the orbital COVERS deriver — fetches CelesTrak TLE
 * groups through the same origin proxy the satellite layer uses
 * (`/api/celestrak/{group}`), parses them, and builds satrecs with
 * satellite.js. Exists so the ontology's orbital edges don't depend on the
 * Cesium layer's internal catalog: derived feeds own their inputs.
 *
 * Default groups are the operationally interesting ones for ground coverage
 * (stations + bright visual birds); callers can widen the set. Results are
 * cached with a TTL — TLEs age in hours, not seconds, so the runtime
 * refreshes on a slow cadence.
 *
 * Fail-soft: a group that errors is skipped; the cache keeps its last good
 * entries. Pure fetch + parse + injectable transport/clock.
 *
 * @module data/tleCatalog
 */

import { twoline2satrec } from 'satellite.js';

/** Default CelesTrak groups mirrored from the satellite layer's catalog. */
export const TLE_DEFAULT_GROUPS = Object.freeze(['stations', 'visual']);

export const TLE_CACHE_TTL_MS = 6 * 3600_000; // TLEs age in hours

/** Parse TLE text into [{name, line1, line2}]. 3-line format only. */
export function parseTleText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trimEnd());
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const [a, b, c] = [lines[i], lines[i + 1], lines[i + 2]];
    if (b?.startsWith('1 ') && c?.startsWith('2 ')) {
      out.push({ name: a.replace(/^0 /, '').trim(), line1: b, line2: c });
      i += 2;
    }
  }
  return out;
}

/** NORAD catalog number from a TLE line 2 (cols 3–7), as a string. */
export function noradFromLine2(line2) {
  return String(line2 || '').substring(2, 7).trim();
}

/**
 * Create a cached satrec provider.
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchFn] Injectable transport.
 * @param {() => number} [opts.now] Clock.
 * @param {string[]} [opts.groups] CelesTrak group paths.
 * @param {(group: string) => string} [opts.urlFor] Endpoint builder.
 * @param {number} [opts.ttlMs] Cache TTL.
 */
export function createTleCatalog({
  fetchFn = globalThis.fetch,
  now = Date.now,
  groups = TLE_DEFAULT_GROUPS,
  urlFor = (group) => `/api/celestrak/${group}`,
  ttlMs = TLE_CACHE_TTL_MS,
} = {}) {
  /** @type {Map<string, {noradId: string, name: string, satrec: object, group: string}>} */
  let cache = new Map();
  let refreshedAt = 0;

  /** True when the cache is older than the TTL (or empty). */
  function isStale() {
    return now() - refreshedAt >= ttlMs;
  }

  /**
   * Refresh the cache from the proxy. Fail-soft per group; a total failure
   * leaves the previous cache intact. @returns {Promise<number>} entries held.
   */
  async function refresh({ force = false } = {}) {
    if (!force && !isStale()) return cache.size;
    const next = new Map();
    let anyOk = false;
    for (const group of groups) {
      try {
        const res = await fetchFn(urlFor(group));
        if (!res?.ok) continue;
        for (const tle of parseTleText(await res.text())) {
          const satrec = twoline2satrec(tle.line1, tle.line2);
          if (!satrec || satrec.error) continue;
          const noradId = noradFromLine2(tle.line2);
          if (!noradId) continue;
          next.set(noradId, { noradId, name: tle.name, satrec, group });
        }
        anyOk = true;
      } catch {
        // skip this group; others may still succeed
      }
    }
    if (anyOk) {
      cache = next;
      refreshedAt = now();
    }
    return cache.size;
  }

  /**
   * Current catalog entries for the COVERS deriver.
   * @returns {Array<{noradId: string, name: string, satrec: object, group: string}>}
   */
  function getSatrecs() {
    return [...cache.values()];
  }

  return { refresh, getSatrecs, isStale };
}
