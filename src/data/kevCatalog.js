// src/data/kevCatalog.js
/**
 * CISA Known Exploited Vulnerabilities (KEV) — the canonical list of CVEs
 * under active exploitation in the wild. Public domain US government data,
 * keyless, CORS-enabled JSON.
 *
 * Non-spatial feed: KEV objects exist in the ontology for the brief and the
 * alert rail ("what just became actively exploited"), not for the globe.
 *
 * Pure normalize + injectable fetch. @module data/kevCatalog
 */

export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

/** Normalize the KEV JSON payload. Malformed entries are dropped. */
export function normalizeKev(payload, { nowMs = Date.now(), recentWindowMs = 7 * 24 * 3600_000 } = {}) {
  const vulns = Array.isArray(payload?.vulnerabilities) ? payload.vulnerabilities : [];
  const items = [];
  for (const v of vulns) {
    const cve = String(v?.cveID || '').trim();
    if (!cve) continue;
    const addedMs = Date.parse(v?.dateAdded || '');
    items.push({
      id: `kev:${cve}`,
      cve,
      vendor: String(v?.vendorProject || '').trim(),
      product: String(v?.product || '').trim(),
      name: String(v?.vulnerabilityName || '').trim(),
      dateAdded: v?.dateAdded || null,
      addedMs: Number.isFinite(addedMs) ? addedMs : null,
      dueDate: v?.dueDate || null,
      action: String(v?.requiredAction || '').trim(),
      recentlyAdded: Number.isFinite(addedMs) && (nowMs - addedMs) <= recentWindowMs,
    });
  }
  // Newest additions first — the rail and the brief read the head.
  items.sort((a, b) => (b.addedMs ?? 0) - (a.addedMs ?? 0));
  return {
    count: items.length,
    catalogVersion: payload?.catalogVersion || null,
    dateReleased: payload?.dateReleased || null,
    recentCount: items.filter((i) => i.recentlyAdded).length,
    items,
  };
}

/** Fetch + normalize. Returns null on any failure (feeds are best-effort). */
export async function fetchKevCatalog(fetchFn = fetch, options = {}) {
  try {
    const res = await fetchFn(KEV_URL);
    if (!res?.ok) return null;
    return normalizeKev(await res.json(), options);
  } catch {
    return null;
  }
}
