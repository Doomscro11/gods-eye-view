// src/data/adsbRawTap.js
/**
 * Raw ADS-B tap — fetches the un-normalized adsb.lol rows (including
 * `nac_p`, which the display pipelines drop) for derived analytics like
 * GPS-interference detection.
 *
 * Why a separate tap: the big layer modules own their own fetch/reconcile
 * loops and stay untouched; derived feeds own their inputs. The endpoint is
 * the same origin proxy the military layer uses, so no new credentials and
 * no new upstream dependency — one extra lightweight poll per cadence.
 *
 * Fail-soft: any error returns [] and the caller just skips the cycle.
 * Pure fetch + injectable transport. @module data/adsbRawTap
 */

export const ADSB_RAW_URL = '/api/adsblol/mil';

/**
 * Fetch the current raw ADS-B rows.
 * @param {typeof fetch} [fetchFn] Injectable transport (tests never touch network).
 * @param {object} [opts]
 * @param {string} [opts.url] Endpoint returning an adsb.lol-shaped `{ac: [...]}` payload.
 * @returns {Promise<Array<object>>} Raw rows, or [] on any failure.
 */
export async function fetchRawAdsb(fetchFn = globalThis.fetch, { url = ADSB_RAW_URL } = {}) {
  try {
    const res = await fetchFn(url);
    if (!res?.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.ac) ? data.ac : [];
  } catch {
    return [];
  }
}
