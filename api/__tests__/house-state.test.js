'use strict';

const {
  reduce, applyEvent, validateEvent, availableCents, planRedeem,
  initialState, HouseEventValidationError,
} = require('../_lib/house/account-state');

const T0 = '2026-07-19T12:00:00.000Z';
const T1 = '2026-07-20T12:00:00.000Z';
const IN_30D = '2026-08-18T12:00:00.000Z';
const IN_60D = '2026-09-17T12:00:00.000Z';

const opened = { type: 'OPENED', payload: {} };
const load = (txid, principal, bonus, expiresAt, at = T0) => ({
  type: 'LOAD_CONFIRMED',
  payload: { txid, at, principalCents: principal, bonusCents: bonus, ...(bonus > 0 ? { bonusExpiresAt: expiresAt } : {}) },
});

describe('house account-state', () => {
  test('OPENED must be first; money events before OPENED are anomalies, not crashes', () => {
    const s = reduce([load('t1', 1000, 0)]);
    expect(s.anomalies).toHaveLength(1);
    expect(s.principalCents).toBe(0);

    expect(() => validateEvent(load('t1', 1000, 0), initialState()))
      .toThrow(HouseEventValidationError);
  });

  test('load credits principal and creates a bonus lot', () => {
    const s = reduce([opened, load('t1', 10000, 1500, IN_30D)]);
    expect(s.principalCents).toBe(10000);
    expect(s.lots).toEqual([{ seq: 2, grantedCents: 1500, remainingCents: 1500, expiresAt: IN_30D }]);
    expect(s.anomalies).toEqual([]);
  });

  test('load without at / with negative money fails strict validation', () => {
    const base = reduce([opened]);
    expect(() => validateEvent({ type: 'LOAD_CONFIRMED', payload: { txid: 'x', principalCents: 100, bonusCents: 0 } }, base))
      .toThrow(/at must be an ISO/);
    expect(() => validateEvent({ type: 'LOAD_CONFIRMED', payload: { txid: 'x', at: T0, principalCents: -5, bonusCents: 0 } }, base))
      .toThrow(/non-negative/);
    expect(() => validateEvent({ type: 'LOAD_CONFIRMED', payload: { txid: 'x', at: T0, principalCents: 100, bonusCents: 50 } }, base))
      .toThrow(/bonusExpiresAt/);
  });

  test('duplicate load txid: same money → no-op, different money → anomaly', () => {
    const events = [opened, load('t1', 5000, 500, IN_30D)];
    const clean = reduce([...events, load('t1', 5000, 500, IN_30D)]);
    expect(clean.principalCents).toBe(5000);
    expect(clean.lots).toHaveLength(1);
    expect(clean.anomalies).toEqual([]);

    const divergent = reduce([...events, load('t1', 9999, 500, IN_30D)]);
    expect(divergent.principalCents).toBe(5000); // not absorbed
    expect(divergent.anomalies[0].type).toBe('divergent_load_txid');
  });

  test('planRedeem spends bonus first, FIFO by earliest expiry, then principal', () => {
    const s = reduce([
      opened,
      load('t1', 10000, 1000, IN_60D, T0),      // lot seq 2, expires later
      load('t2', 5000, 800, IN_30D, T0),        // lot seq 3, expires SOONER → spent first
    ]);
    const plan = planRedeem(s, 2000, T1);
    expect(plan.bonusCents).toBe(1800);
    expect(plan.principalCents).toBe(200);
    expect(plan.lots).toEqual([
      { seq: 3, useCents: 800 },   // earliest expiry first
      { seq: 2, useCents: 1000 },
    ]);
  });

  test('expired lots stop counting — availability and planRedeem agree', () => {
    const s = reduce([opened, load('t1', 1000, 5000, IN_30D, T0)]);
    const before = availableCents(s, IN_30D.replace('12:00:00.000', '11:59:59.000'));
    expect(before.bonusCents).toBe(5000);
    // exactly at expiresAt → expired (strict >)
    const at = availableCents(s, IN_30D);
    expect(at.bonusCents).toBe(0);
    expect(at.totalCents).toBe(1000);
    expect(() => planRedeem(s, 1500, IN_30D)).toThrow(/insufficient/);
  });

  test('REDEEMED applies its breakdown; validation rejects overdraw, expired lots, bad sums', () => {
    const events = [opened, load('t1', 10000, 1000, IN_30D, T0)];
    const s = reduce(events);
    const plan = planRedeem(s, 1500, T1);
    const redeemed = {
      type: 'REDEEMED',
      payload: { txid: 'r1', checkId: 'c1', ...plan, principalCents: plan.principalCents, bonusCents: plan.bonusCents },
    };
    const after = reduce([...events, redeemed]);
    expect(after.principalCents).toBe(9500);
    expect(after.lots[0].remainingCents).toBe(0);
    expect(after.redeems.r1.checkId).toBe('c1');
    expect(after.anomalies).toEqual([]);

    // overdraw a lot
    expect(() => validateEvent({
      type: 'REDEEMED',
      payload: { txid: 'r2', checkId: 'c1', at: T1, principalCents: 0, bonusCents: 1200, lots: [{ seq: 2, useCents: 1200 }] },
    }, s)).toThrow(/overdraws/);
    // spend an expired lot
    expect(() => validateEvent({
      type: 'REDEEMED',
      payload: { txid: 'r3', checkId: 'c1', at: IN_60D, principalCents: 0, bonusCents: 100, lots: [{ seq: 2, useCents: 100 }] },
    }, s)).toThrow(/expired/);
    // lot sum ≠ bonusCents
    expect(() => validateEvent({
      type: 'REDEEMED',
      payload: { txid: 'r4', checkId: 'c1', at: T1, principalCents: 0, bonusCents: 500, lots: [{ seq: 2, useCents: 100 }] },
    }, s)).toThrow(/breakdown/);
    // principal beyond balance
    expect(() => validateEvent({
      type: 'REDEEMED',
      payload: { txid: 'r5', checkId: 'c1', at: T1, principalCents: 99999, bonusCents: 0, lots: [] },
    }, s)).toThrow(/exceeds balance/);
  });

  test('duplicate redeem txid: same money no-op; a stored overdraw becomes an anomaly (totality)', () => {
    const events = [opened, load('t1', 1000, 0, null, T0)];
    const r = { type: 'REDEEMED', payload: { txid: 'r1', checkId: 'c1', at: T1, principalCents: 600, bonusCents: 0, lots: [] } };
    const clean = reduce([...events, r, r]);
    expect(clean.principalCents).toBe(400);
    expect(clean.anomalies).toEqual([]);

    // two DIFFERENT redeems that together overdraw: second is skipped + flagged
    const r2 = { type: 'REDEEMED', payload: { txid: 'r2', checkId: 'c1', at: T1, principalCents: 600, bonusCents: 0, lots: [] } };
    const raced = reduce([...events, r, r2]);
    expect(raced.principalCents).toBe(400); // r2 skipped
    expect(raced.anomalies).toHaveLength(1);
  });

  test('refund shrinks principal, never bonus; over-refund rejected', () => {
    const events = [opened, load('t1', 1000, 500, IN_30D, T0)];
    const s = reduce([...events, { type: 'PRINCIPAL_REFUNDED', payload: { amountCents: 400, at: T1, settlement: 'manual' } }]);
    expect(s.principalCents).toBe(600);
    expect(s.refundedCents).toBe(400);
    expect(availableCents(s, T1).bonusCents).toBe(500);

    expect(() => validateEvent({ type: 'PRINCIPAL_REFUNDED', payload: { amountCents: 601, at: T1 } }, s))
      .toThrow(/exceeds principal/);
  });

  test('reduce is total: malformed stored garbage never throws', () => {
    const s = reduce([
      opened,
      { type: 'WAT', payload: {} },
      { type: 'REDEEMED', payload: { txid: 'r', checkId: 'c', at: T1, principalCents: 50, bonusCents: 0, lots: [] } }, // overdraw on empty
      { type: 'LOAD_CONFIRMED', payload: { txid: null } },
    ]);
    expect(s.principalCents).toBe(0);
    expect(s.anomalies.length).toBe(3);
  });

  test('totality vs poisoned lots payloads: {} / string lots and null rows become anomalies, never throws (review finding)', () => {
    const base = [opened, load('t1', 1000, 0, null, T0)];
    for (const lots of [{}, 'xx', 42]) {
      const s = reduce([...base, {
        type: 'REDEEMED',
        payload: { txid: 'r1', checkId: 'c1', at: T1, principalCents: 100, bonusCents: 0, lots },
      }]);
      expect(s.principalCents).toBe(1000); // event skipped, money readable
      expect(s.anomalies).toHaveLength(1);
    }
    const withNull = reduce([...base, null]);
    expect(withNull.principalCents).toBe(1000);
    expect(withNull.anomalies).toHaveLength(1);
  });

  test('duplicate lot seqs in one REDEEMED cannot overdraw a lot through the strict gate (review finding)', () => {
    const events = [opened, load('t1', 1000, 500, IN_30D, T0)];
    const s = reduce(events);
    expect(() => validateEvent({
      type: 'REDEEMED',
      payload: {
        txid: 'r1', checkId: 'c1', at: T1, principalCents: 0, bonusCents: 600,
        lots: [{ seq: 2, useCents: 300 }, { seq: 2, useCents: 300 }],
      },
    }, s)).toThrow(/overdraws/);
    // and a corrupt stored negative lot never eats principal (clamp)
    const poisoned = reduce([...events, {
      type: 'REDEEMED',
      payload: { txid: 'r1', checkId: 'c1', at: T1, principalCents: 0, bonusCents: 600, lots: [{ seq: 2, useCents: 300 }, { seq: 2, useCents: 300 }] },
    }]);
    const avail = availableCents(poisoned, T1);
    expect(avail.totalCents).toBeGreaterThanOrEqual(avail.principalCents);
  });

  test('REDEEM_REVERSED restores the exact breakdown, once, idempotently', () => {
    const events = [
      opened,
      load('t1', 10000, 1000, IN_30D, T0),
      { type: 'REDEEMED', payload: { txid: 'r1', checkId: 'c1', at: T1, principalCents: 500, bonusCents: 1000, lots: [{ seq: 2, useCents: 1000 }] } },
    ];
    const before = reduce(events);
    expect(before.principalCents).toBe(9500);
    expect(availableCents(before, T1).bonusCents).toBe(0);

    const reversal = { type: 'REDEEM_REVERSED', payload: { txid: 'r1', at: T1, reason: 'check_append_refused' } };
    const after = reduce([...events, reversal]);
    expect(after.principalCents).toBe(10000);
    expect(availableCents(after, T1).bonusCents).toBe(1000);
    expect(after.redeems.r1.reversed).toBe(true);
    expect(after.anomalies).toEqual([]);

    // at-least-once replay of the reversal is a clean no-op
    const replayed = reduce([...events, reversal, reversal]);
    expect(replayed.principalCents).toBe(10000);
    expect(replayed.anomalies).toEqual([]);

    // reversing an unknown txid fails strict validation
    expect(() => validateEvent({ type: 'REDEEM_REVERSED', payload: { txid: 'ghost', at: T1 } }, before))
      .toThrow(/unknown redeem/);
  });
});
