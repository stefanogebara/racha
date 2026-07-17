'use strict';

/**
 * Split engine — pure, exact, integer-centavo money math.
 *
 * INVARIANT (the one that matters): every split of T centavos returns parts
 * that sum to EXACTLY T. No floats anywhere; callers that hold reais convert
 * at the boundary. Largest-remainder allocation; centavo leftovers are
 * distributed deterministically, rotated so repeated splits don't always tax
 * the same person.
 *
 * Serviço (the 10%) is computed here but is ALWAYS optional upstream
 * (CDC — the UI must allow removal; this module just does the math).
 */

/** Throws unless v is a safe non-negative integer (centavos). */
function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer (centavos), got: ${v}`);
  }
}

/**
 * Divide `totalCents` into `n` parts, each differing by at most 1 centavo,
 * summing exactly to totalCents. `rotate` shifts which positions absorb the
 * extra centavos (pass e.g. an item index so leftovers spread across people).
 *
 * @param {number} totalCents
 * @param {number} n - number of parts (>= 1)
 * @param {number} [rotate=0]
 * @returns {number[]} n parts, sum === totalCents
 */
function splitEqual(totalCents, n, rotate = 0) {
  assertCents(totalCents, 'totalCents');
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new TypeError(`n must be a positive integer, got: ${n}`);
  }
  if (!Number.isSafeInteger(rotate) || rotate < 0) {
    throw new TypeError(`rotate must be a non-negative integer, got: ${rotate}`);
  }
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  const parts = new Array(n).fill(base);
  for (let i = 0; i < remainder; i++) {
    parts[(i + rotate) % n] += 1;
  }
  return parts;
}

/**
 * Validate a custom split: the diner-entered amounts must cover the total
 * exactly. Returns { ok:true } or { ok:false, diffCents } (positive = short).
 *
 * @param {number} totalCents
 * @param {number[]} amounts
 */
function validateCustomSplit(totalCents, amounts) {
  assertCents(totalCents, 'totalCents');
  if (!Array.isArray(amounts) || amounts.length === 0) {
    throw new TypeError('amounts must be a non-empty array');
  }
  amounts.forEach((a, i) => assertCents(a, `amounts[${i}]`));
  const sum = amounts.reduce((s, a) => s + a, 0);
  return sum === totalCents ? { ok: true } : { ok: false, diffCents: totalCents - sum };
}

/**
 * Split by items: each item is claimed by one or more people; each person's
 * share is the exact sum of their item allocations. Item prices shared by k
 * people use largest-remainder with rotation by item position, so the extra
 * centavo doesn't always land on the same claimant.
 *
 * @param {Array<{id:string, priceCents:number, claimedBy:string[]}>} items
 *   claimedBy: personIds; must be non-empty per item (unclaimed → error, the
 *   UI resolves claims before computing).
 * @returns {{ perPerson: Record<string, number>, totalCents: number }}
 */
function splitByItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError('items must be a non-empty array');
  }
  const perPerson = {};
  let totalCents = 0;
  items.forEach((item, idx) => {
    assertCents(item.priceCents, `items[${idx}].priceCents`);
    if (!Array.isArray(item.claimedBy) || item.claimedBy.length === 0) {
      throw new Error(`item ${item.id ?? idx} has no claimants`);
    }
    totalCents += item.priceCents;
    const shares = splitEqual(item.priceCents, item.claimedBy.length, idx);
    item.claimedBy.forEach((personId, j) => {
      perPerson[personId] = (perPerson[personId] || 0) + shares[j];
    });
  });
  return { perPerson, totalCents };
}

/**
 * Serviço (tip) on a base amount. Half-up rounding to the centavo.
 * pctBasisPoints: 1000 = 10%. Kept in basis points to stay integer-only.
 */
function servicoCents(baseCents, pctBasisPoints = 1000) {
  assertCents(baseCents, 'baseCents');
  if (!Number.isSafeInteger(pctBasisPoints) || pctBasisPoints < 0 || pctBasisPoints > 3000) {
    // >30% serviço is not a thing; catches unit mistakes (e.g. passing 10 for 10%... 10bp=0.1%).
    throw new TypeError(`pctBasisPoints out of range [0,3000]: ${pctBasisPoints}`);
  }
  return Math.floor((baseCents * pctBasisPoints + 5000) / 10000);
}

module.exports = { splitEqual, validateCustomSplit, splitByItems, servicoCents, assertCents };
