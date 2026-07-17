'use strict';

/**
 * Check state machine — replayability, webhook idempotency, TOTALITY (a
 * stored log must always reduce — anomalies, never throws), refunds, and the
 * never-lose-money rules.
 */

const {
  STATUS, reduce, validateEvent, remainingCents, lateTxids,
} = require('../_lib/checks/check-state');

const opened = (totalCents) => ({ type: 'OPENED', payload: { totalCents } });
const adjusted = (totalCents) => ({ type: 'ADJUSTED', payload: { totalCents } });
const paid = (txid, amountCents, tipCents = 0, method = 'pix') => ({
  type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents, tipCents, method },
});
const refunded = (txid, amountCents, tipCents = 0) => ({
  type: 'PAYMENT_REFUNDED', payload: { txid, amountCents, tipCents },
});
const closed = () => ({ type: 'CLOSED', payload: {} });

describe('lifecycle: aberta → parcial → paga → fechada', () => {
  test('full happy path with a 3-way split', () => {
    const s = reduce([
      opened(30000),
      paid('tx1', 10000, 1000),
      paid('tx2', 10000, 1000),
      paid('tx3', 10000, 0),
      closed(),
    ]);
    expect(s.status).toBe(STATUS.FECHADA);
    expect(s.paidCents).toBe(30000);
    expect(s.tipCents).toBe(2000); // tips tracked separately (payroll report)
    expect(s.overpaidCents).toBe(0);
    expect(s.anomalies).toEqual([]);
    expect(remainingCents(s)).toBe(0);
  });

  test('partial payment leaves parcial with exact remaining', () => {
    const s = reduce([opened(30000), paid('tx1', 12000)]);
    expect(s.status).toBe(STATUS.PARCIAL);
    expect(remainingCents(s)).toBe(18000);
  });

  test('tip-only payment counts and moves nothing on consumption', () => {
    const s = reduce([opened(10000), paid('tx1', 0, 500)]);
    expect(s.status).toBe(STATUS.ABERTA); // no consumption paid
    expect(s.tipCents).toBe(500);
    expect(remainingCents(s)).toBe(10000);
  });
});

describe('webhook idempotency (at-least-once delivery)', () => {
  test('duplicate txid with identical amounts is a strict no-op', () => {
    const base = [opened(10000), paid('tx1', 6000, 500)];
    expect(reduce([...base, paid('tx1', 6000, 500)])).toEqual(reduce(base));
  });

  test('duplicate txid with DIFFERENT amounts is flagged, never absorbed', () => {
    const s = reduce([opened(10000), paid('tx1', 6000, 500), paid('tx1', 9000, 0)]);
    expect(s.paidCents).toBe(6000); // original stands
    expect(s.anomalies).toHaveLength(1);
    expect(s.anomalies[0].reason).toMatch(/different amounts/);
  });

  test('replaying the whole log yields identical state (replayability)', () => {
    const log = [opened(10000), paid('a', 4000), adjusted(12000), paid('b', 8000), closed()];
    expect(reduce(log)).toEqual(reduce(log));
  });
});

describe('TOTALITY — a poisoned log still reduces, money stays readable', () => {
  test('raced double CLOSE: anomaly recorded, later payment still counted', () => {
    // The exact scenario from the review: [OPENED, PAY 6000, CLOSED, CLOSED,
    // PAY 4000+400] used to throw forever, hiding R$44,00 of real money.
    const s = reduce([
      opened(10000), paid('tx1', 6000), closed(), closed(), paid('tx2', 4000, 400),
    ]);
    expect(s.status).toBe(STATUS.FECHADA);
    expect(s.paidCents).toBe(10000);
    expect(s.tipCents).toBe(400);
    expect(s.anomalies).toHaveLength(1);
    expect(s.anomalies[0].reason).toMatch(/already closed/);
    expect(lateTxids(s)).toEqual(['tx2']);
  });

  test('ADJUSTED racing CLOSED: anomaly, state intact', () => {
    const s = reduce([opened(10000), paid('t', 10000), closed(), adjusted(15000)]);
    expect(s.status).toBe(STATUS.FECHADA);
    expect(s.totalCents).toBe(10000); // adjust ignored
    expect(s.anomalies).toHaveLength(1);
  });

  test('duplicate OPENED: anomaly, original total preserved', () => {
    const s = reduce([opened(10000), opened(99999), paid('t', 10000)]);
    expect(s.totalCents).toBe(10000);
    expect(s.status).toBe(STATUS.PAGA);
    expect(s.anomalies).toHaveLength(1);
  });

  test('malformed payload mid-log: anomaly, fold continues', () => {
    const s = reduce([opened(1000), { type: 'PAYMENT_CONFIRMED', payload: { amountCents: 100 } }, paid('ok', 1000)]);
    expect(s.status).toBe(STATUS.PAGA);
    expect(s.anomalies).toHaveLength(1);
    expect(s.anomalies[0].reason).toMatch(/txid/);
  });

  test('garbage before OPENED: bootstrap state carries the anomaly', () => {
    const s = reduce([paid('t', 100), opened(5000)]);
    // OPENED after garbage: second event opens cleanly? No — bootstrap absorbed
    // it; OPENED then hits "must be first" and is anomalied. Money readable.
    expect(s.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(() => remainingCents(s)).not.toThrow();
  });
});

describe('refunds (Pix devolução / MED)', () => {
  test('partial refund reduces paid and tips; status recomputes', () => {
    const s = reduce([opened(10000), paid('tx1', 10000, 1000), refunded('tx1', 4000, 500)]);
    expect(s.status).toBe(STATUS.PARCIAL);
    expect(s.paidCents).toBe(6000);
    expect(s.tipCents).toBe(500);
    expect(remainingCents(s)).toBe(4000);
  });

  test('refund exceeding the payment is rejected at append AND anomalied in fold', () => {
    const pre = reduce([opened(10000), paid('tx1', 5000)]);
    expect(() => validateEvent(refunded('tx1', 6000), pre)).toThrow(/exceeds/);
    const s = reduce([opened(10000), paid('tx1', 5000), refunded('tx1', 6000)]);
    expect(s.paidCents).toBe(5000); // untouched
    expect(s.anomalies).toHaveLength(1);
  });

  test('refund for unknown txid → anomaly', () => {
    const s = reduce([opened(10000), refunded('ghost', 100)]);
    expect(s.anomalies).toHaveLength(1);
    expect(s.anomalies[0].reason).toMatch(/unknown txid/);
  });

  test('cumulative refunds are capped at the original payment', () => {
    const s = reduce([
      opened(10000), paid('tx1', 5000), refunded('tx1', 3000), refunded('tx1', 3000),
    ]);
    expect(s.paidCents).toBe(2000); // only the first refund applied
    expect(s.anomalies).toHaveLength(1);
  });
});

describe('never lose money silently', () => {
  test('overpayment is flagged, not absorbed', () => {
    const s = reduce([opened(10000), paid('tx1', 10000), adjusted(8000)]);
    expect(s.overpaidCents).toBe(2000);
    expect(s.status).toBe(STATUS.PAGA);
  });

  test('overpaid recomputes on post-close payments (was stale — review finding)', () => {
    const s = reduce([opened(10000), paid('tx1', 10000), closed(), paid('tx2', 500)]);
    expect(s.paidCents).toBe(10500);
    expect(s.overpaidCents).toBe(500);
    expect(lateTxids(s)).toEqual(['tx2']);
  });

  test('late payment is idempotent too', () => {
    const s = reduce([opened(1000), paid('a', 1000), closed(), paid('late1', 500), paid('late1', 500)]);
    expect(s.paidCents).toBe(1500);
    expect(lateTxids(s)).toEqual(['late1']);
  });
});

describe('adjustments (waiter adds items mid-flight)', () => {
  test('adjust up reopens the gap after full payment, paid totals preserved', () => {
    const s = reduce([opened(10000), paid('tx1', 10000), adjusted(15000)]);
    expect(s.status).toBe(STATUS.PARCIAL);
    expect(s.paidCents).toBe(10000);
    expect(remainingCents(s)).toBe(5000);
  });
});

describe('validateEvent — the strict APPEND gate still throws', () => {
  test('rejects everything the reducer would anomaly', () => {
    const open = reduce([opened(100)]);
    expect(() => validateEvent(opened(200), open)).toThrow(/first event/);
    expect(() => validateEvent(paid('t', -5), open)).toThrow(/integer/);
    expect(() => validateEvent(paid('t', 0, 0), open)).toThrow(/zero-value/);
    expect(() => validateEvent({ type: 'HACK', payload: {} }, open)).toThrow(/unknown event type/);
    const done = reduce([opened(100), paid('t', 100), closed()]);
    expect(() => validateEvent(closed(), done)).toThrow(/already closed/);
    expect(() => validateEvent(adjusted(500), done)).toThrow(/closed/);
  });
});
