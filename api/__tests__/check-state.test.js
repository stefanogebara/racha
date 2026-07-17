'use strict';

/**
 * Check state machine — replayability, webhook idempotency, and the
 * never-lose-money rules (overpay flagged, late payments recorded).
 */

const { STATUS, reduce, remainingCents } = require('../_lib/checks/check-state');

const opened = (totalCents) => ({ type: 'OPENED', payload: { totalCents } });
const adjusted = (totalCents) => ({ type: 'ADJUSTED', payload: { totalCents } });
const paid = (txid, amountCents, tipCents = 0, method = 'pix') => ({
  type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents, tipCents, method },
});
const closed = () => ({ type: 'CLOSED', payload: {} });

describe('lifecycle: aberta → parcial → paga → fechada', () => {
  test('full happy path with a 3-way split', () => {
    const events = [
      opened(30000),
      paid('tx1', 10000, 1000),
      paid('tx2', 10000, 1000),
      paid('tx3', 10000, 0),
      closed(),
    ];
    const s = reduce(events);
    expect(s.status).toBe(STATUS.FECHADA);
    expect(s.paidCents).toBe(30000);
    expect(s.tipCents).toBe(2000); // tips tracked separately (payroll report)
    expect(s.overpaidCents).toBe(0);
    expect(remainingCents(s)).toBe(0);
  });

  test('partial payment leaves parcial with exact remaining', () => {
    const s = reduce([opened(30000), paid('tx1', 12000)]);
    expect(s.status).toBe(STATUS.PARCIAL);
    expect(remainingCents(s)).toBe(18000);
  });

  test('zero payments keeps aberta', () => {
    const s = reduce([opened(5000)]);
    expect(s.status).toBe(STATUS.ABERTA);
    expect(remainingCents(s)).toBe(5000);
  });
});

describe('webhook idempotency (at-least-once delivery)', () => {
  test('duplicate txid is a strict no-op', () => {
    const base = [opened(10000), paid('tx1', 6000, 500)];
    const once = reduce(base);
    const twice = reduce([...base, paid('tx1', 6000, 500)]);
    expect(twice).toEqual(once);
  });

  test('replaying the whole log yields identical state (replayability)', () => {
    const log = [opened(10000), paid('a', 4000), adjusted(12000), paid('b', 8000), closed()];
    expect(reduce(log)).toEqual(reduce(log));
  });
});

describe('never lose money silently', () => {
  test('overpayment is flagged, not absorbed', () => {
    const s = reduce([opened(10000), paid('tx1', 10000), adjusted(8000)]);
    expect(s.overpaidCents).toBe(2000);
    expect(s.status).toBe(STATUS.PAGA);
  });

  test('payment after CLOSED lands in lateTxids and keeps the money counted', () => {
    const s = reduce([opened(10000), paid('tx1', 10000), closed(), paid('tx2', 500, 100)]);
    expect(s.status).toBe(STATUS.FECHADA);
    expect(s.lateTxids).toEqual(['tx2']);
    expect(s.paidCents).toBe(10500);
    expect(s.tipCents).toBe(100);
  });

  test('late payment is also idempotent', () => {
    const s = reduce([opened(1000), closed(), paid('late1', 500), paid('late1', 500)]);
    expect(s.lateTxids).toEqual(['late1']);
    expect(s.paidCents).toBe(500);
  });
});

describe('adjustments (waiter adds items mid-flight)', () => {
  test('adjust up reopens the gap after full payment', () => {
    const s = reduce([opened(10000), paid('tx1', 10000), adjusted(15000)]);
    expect(s.status).toBe(STATUS.PARCIAL);
    expect(remainingCents(s)).toBe(5000);
  });

  test('cannot adjust a closed check', () => {
    expect(() => reduce([opened(1000), closed(), adjusted(2000)])).toThrow(/closed/);
  });
});

describe('event validation (garbage never enters the log)', () => {
  test('OPENED must be first and only first', () => {
    expect(() => reduce([paid('t', 100)])).toThrow(/before OPENED/);
    expect(() => reduce([opened(100), opened(200)])).toThrow(/first event/);
  });

  test('rejects float totals and negative amounts', () => {
    expect(() => reduce([opened(100.5)])).toThrow(/integer/);
    expect(() => reduce([opened(100), paid('t', -5)])).toThrow(/integer/);
  });

  test('rejects zero-value payments and missing txid', () => {
    expect(() => reduce([opened(100), paid('t', 0, 0)])).toThrow(/zero-value/);
    expect(() => reduce([opened(100), { type: 'PAYMENT_CONFIRMED', payload: { amountCents: 100 } }])).toThrow(/txid/);
  });

  test('double close throws', () => {
    expect(() => reduce([opened(100), closed(), closed()])).toThrow(/already closed/);
  });

  test('unknown event type throws', () => {
    expect(() => reduce([{ type: 'HACK', payload: {} }])).toThrow(/unknown event type/);
  });
});
