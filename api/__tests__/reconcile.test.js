'use strict';

/**
 * Reconciliation canary — cross-checks the two independent money ledgers
 * (event log vs payments table) and flags any drift ≥ 1 centavo.
 */

const { reconcileCheck, reconcileVenue } = require('../_lib/checks/reconcile');
const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a, tip = 0) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: tip, method: 'pix' } });
const refunded = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: a, tipCents: tip } });
const row = (txid, a, tip, status = 'confirmado') => ({ txid, amountCents: a, tipCents: tip, status });

describe('reconcileCheck — event log vs payments table', () => {
  test('clean match → ok, zero drift', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000, 600), paid('tx2', 4000, 0)],
      payments: [row('tx1', 6000, 600), row('tx2', 4000, 0)],
    });
    expect(r.ok).toBe(true);
    expect(r.driftCents).toBe(0);
    expect(r.findings).toEqual([]);
  });

  test('webhook appended to log but payments row missing → critical + drift', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000), paid('tx2', 4000)],
      payments: [row('tx1', 6000, 0)], // tx2 row never written
    });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.code === 'missing_payment_row' && f.txid === 'tx2')).toBe(true);
    expect(r.driftCents).toBe(-4000); // payments table short by 4000
  });

  test('confirmed payments row with no matching log event → critical (lost from state)', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000)],
      payments: [row('tx1', 6000, 0), row('ghost', 4000, 0)],
    });
    expect(r.findings.some((f) => f.code === 'missing_log_event' && f.txid === 'ghost')).toBe(true);
    expect(r.driftCents).toBe(4000);
  });

  test('amount mismatch on the same txid → critical', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000, 600)],
      payments: [row('tx1', 5000, 600)], // row says 5000, log says 6000
    });
    expect(r.findings.some((f) => f.code === 'amount_mismatch')).toBe(true);
  });

  test('refund reflected in log but row status still confirmado → status_lag', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000), refunded('tx1', 6000)],
      payments: [row('tx1', 6000, 0, 'confirmado')], // should be devolvido
    });
    expect(r.findings.some((f) => f.code === 'status_lag')).toBe(true);
    // Log net = 0; row confirmed counts 6000 → drift surfaces the divergence.
    expect(r.driftCents).toBe(6000);
  });

  test('event-log anomaly (divergent replay) surfaces as a finding', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000), paid('tx1', 9000)], // divergent replay
      payments: [row('tx1', 6000, 0)],
    });
    expect(r.findings.some((f) => f.code === 'log_anomaly')).toBe(true);
  });

  test('malformed input never throws', () => {
    expect(() => reconcileCheck({ checkId: 'c1', events: null, payments: null })).not.toThrow();
    const r = reconcileCheck({ checkId: 'c1', events: [], payments: [row('x', 100, 0)] });
    expect(r.findings.some((f) => f.code === 'missing_log_event')).toBe(true);
  });
});

describe('reconcileVenue — live money paths reconcile clean', () => {
  const SECRET = 'reconcile-secret-0123456789ab';

  async function world() {
    const store = createMemoryStore();
    const psp = new MockPsp({ webhookSecret: SECRET });
    const handler = createWebhookHandler({
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      psp,
    });
    const charge = createChargeService({ store, psp });
    const venue = store.seedVenue({ name: 'Recon', servicoBp: 1000, pspRecipientId: 'r' });
    const table = store.seedTable(venue.id, 'M1');
    return { store, psp, handler, charge, venue, table };
  }

  test('the normal flow leaves zero drift and no findings', async () => {
    const { store, psp, handler, charge, venue, table } = await world();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 10000 }]);
    const c = await charge({ checkId: check.id, amountCents: 10000, tipCents: 1000, payerLabel: 'Ana' });
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 10000, tipCents: 1000 });
    await handler(wh.rawBody, wh.signature);

    const report = await reconcileVenue(store, venue.id);
    expect(report.checksFailed).toBe(0);
    expect(report.totalDriftCents).toBe(0);
    expect(report.worstSeverity).toBe('ok');
  });

  test('a divergent webhook makes the venue report page (worstSeverity high)', async () => {
    const { store, psp, handler, charge, venue, table } = await world();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 10000 }]);
    const c = await charge({ checkId: check.id, amountCents: 6000 });
    await handler(...Object.values(psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 6000 })));
    // divergent replay: appends a log anomaly
    await handler(...Object.values(psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 9000 })));

    const report = await reconcileVenue(store, venue.id);
    expect(report.checksFailed).toBe(1);
    expect(['high', 'critical']).toContain(report.worstSeverity);
  });
});
