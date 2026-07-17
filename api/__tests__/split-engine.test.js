'use strict';

/**
 * Split engine — the sum invariant is the product. If any of these fail,
 * money is being created or destroyed and nothing else matters.
 */

const { splitEqual, validateCustomSplit, splitByItems, servicoCents } = require('../_lib/checks/split-engine');

describe('splitEqual — exact largest-remainder division', () => {
  test('divides evenly when possible', () => {
    expect(splitEqual(9000, 3)).toEqual([3000, 3000, 3000]);
  });

  test('distributes remainder centavos, parts differ by at most 1', () => {
    const parts = splitEqual(10000, 3); // R$100,00 / 3
    expect(parts.reduce((s, p) => s + p, 0)).toBe(10000);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    expect(parts).toEqual([3334, 3333, 3333]);
  });

  test('rotation moves who absorbs the extra centavo', () => {
    expect(splitEqual(100, 3, 0)).toEqual([34, 33, 33]);
    expect(splitEqual(100, 3, 1)).toEqual([33, 34, 33]);
    expect(splitEqual(100, 3, 2)).toEqual([33, 33, 34]);
    expect(splitEqual(100, 3, 3)).toEqual([34, 33, 33]); // wraps
  });

  test('property: sum invariant holds across a sweep of totals and party sizes', () => {
    for (let total = 0; total <= 1000; total += 7) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitEqual(total, n, total % n);
        expect(parts).toHaveLength(n);
        expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
        expect(parts.every((p) => p >= 0)).toBe(true);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });

  test('n=1 returns the whole total', () => {
    expect(splitEqual(12345, 1)).toEqual([12345]);
  });

  test('rejects floats, negatives, zero parties', () => {
    expect(() => splitEqual(100.5, 2)).toThrow(/centavos/);
    expect(() => splitEqual(-1, 2)).toThrow(/centavos/);
    expect(() => splitEqual(100, 0)).toThrow(/positive integer/);
    expect(() => splitEqual(100, 2, -1)).toThrow(/rotate/);
  });
});

describe('validateCustomSplit — diner-entered amounts must cover exactly', () => {
  test('exact cover passes', () => {
    expect(validateCustomSplit(10000, [7000, 3000])).toEqual({ ok: true });
  });

  test('short and over report the signed difference', () => {
    expect(validateCustomSplit(10000, [5000, 4000])).toEqual({ ok: false, diffCents: 1000 });
    expect(validateCustomSplit(10000, [8000, 4000])).toEqual({ ok: false, diffCents: -2000 });
  });

  test('rejects empty and non-integer amounts', () => {
    expect(() => validateCustomSplit(100, [])).toThrow(/non-empty/);
    expect(() => validateCustomSplit(100, [50.5, 49.5])).toThrow(/centavos/);
  });
});

describe('splitByItems — per-person exact allocation', () => {
  test('solo items go entirely to the claimant', () => {
    const { perPerson, totalCents } = splitByItems([
      { id: 'picanha', priceCents: 8990, claimedBy: ['ana'] },
      { id: 'suco', priceCents: 1200, claimedBy: ['bia'] },
    ]);
    expect(perPerson).toEqual({ ana: 8990, bia: 1200 });
    expect(totalCents).toBe(10190);
  });

  test('shared item splits exactly; rotation spreads centavos across items', () => {
    const { perPerson, totalCents } = splitByItems([
      { id: 'a', priceCents: 100, claimedBy: ['p1', 'p2', 'p3'] }, // idx 0 → p1 gets 34
      { id: 'b', priceCents: 100, claimedBy: ['p1', 'p2', 'p3'] }, // idx 1 → p2 gets 34
      { id: 'c', priceCents: 100, claimedBy: ['p1', 'p2', 'p3'] }, // idx 2 → p3 gets 34
    ]);
    expect(perPerson).toEqual({ p1: 100, p2: 100, p3: 100 });
    expect(totalCents).toBe(300);
  });

  test('property: per-person totals always sum to the check total', () => {
    const items = [
      { id: 'i1', priceCents: 4437, claimedBy: ['a', 'b'] },
      { id: 'i2', priceCents: 999, claimedBy: ['a', 'b', 'c'] },
      { id: 'i3', priceCents: 12301, claimedBy: ['c'] },
      { id: 'i4', priceCents: 1, claimedBy: ['a', 'b', 'c'] },
    ];
    const { perPerson, totalCents } = splitByItems(items);
    const sum = Object.values(perPerson).reduce((s, v) => s + v, 0);
    expect(sum).toBe(totalCents);
    expect(totalCents).toBe(4437 + 999 + 12301 + 1);
  });

  test('unclaimed item is an error — the UI resolves claims first', () => {
    expect(() => splitByItems([{ id: 'x', priceCents: 100, claimedBy: [] }])).toThrow(/no claimants/);
  });
});

describe('servicoCents — optional 10% math (basis points, half-up)', () => {
  test('10% of round numbers', () => {
    expect(servicoCents(10000)).toBe(1000);
  });

  test('half-up rounding at the centavo', () => {
    expect(servicoCents(5, 1000)).toBe(1);   // 0.5 → 1
    expect(servicoCents(4, 1000)).toBe(0);   // 0.4 → 0
    expect(servicoCents(12345, 1000)).toBe(1235); // 1234.5 → 1235
  });

  test('other percentages in basis points (12% = 1200)', () => {
    expect(servicoCents(10000, 1200)).toBe(1200);
    expect(servicoCents(10000, 0)).toBe(0);
  });

  test('rejects unit mistakes (10 for 10%) via the range guard upper bound is fine but 3001 is not', () => {
    expect(() => servicoCents(10000, 3001)).toThrow(/out of range/);
    expect(servicoCents(10000, 10)).toBe(10); // 10bp = 0.1% — legal, math is exact
  });
});
