'use strict';

/**
 * Active charge reconciliation — the safety net for a missed/rejected webhook.
 * The core scenario: the bank confirmed the Pix but the webhook never arrived
 * (the Beira Mar incident). The reconciler must re-ask the PSP and confirm the
 * payment through the SAME idempotent path the webhook uses.
 */

const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler, applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createChargeReconciler } = require('../_lib/checks/reconcile-charges');
const { createChargeService } = require('../_lib/pay/create-charge');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce, STATUS } = require('../_lib/checks/check-state');

const SECRET = 'test-webhook-secret-0123456789';

function freshWorld() {
  const store = createMemoryStore();
  const psp = new MockPsp({ webhookSecret: SECRET });
  const venue = store.seedVenue({ name: 'Boteco Teste', servicoBp: 1000 });
  const table = store.seedTable(venue.id, 'Mesa 4');
  const confirmDeps = {
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
  };
  const handler = createWebhookHandler({ ...confirmDeps, psp });
  const reconciler = createChargeReconciler({
    store, psp,
    confirm: (parsed) => applyConfirmedPayment(parsed, confirmDeps),
  });
  const charge = createChargeService({ store, psp });
  return { store, psp, venue, table, handler, reconciler, charge };
}

async function openDemoCheck(store, table, priceCents = 12000) {
  return store.openCheck(table.qrToken, [
    { id: 'i1', name: 'Picanha', priceCents: priceCents - 2000 },
    { id: 'i2', name: 'Chopp', priceCents: 2000 },
  ]);
}

describe('reconcile-charges — heal a missed webhook', () => {
  test('bank confirmed the Pix but the webhook never arrived → reconcile confirms it', async () => {
    const { store, psp, table, reconciler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 8000, tipCents: 800 });

    // The gateway shows PAID, but no webhook was ever delivered.
    psp.settleCharge(c.txid);
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0); // still stuck

    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.confirmed).toBe(1);

    const state = reduce(await store.loadEvents(check.id));
    expect(state.paidCents).toBe(8000);
    expect(state.tipCents).toBe(800);
    expect((await store.getPayment(c.txid)).status).toBe('confirmado');
  });

  test('full payment via reconcile drives the check to PAGA', async () => {
    const { store, psp, table, reconciler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 10000 });
    psp.settleCharge(c.txid);
    await reconciler.reconcile({ graceMs: 0 });
    expect(reduce(await store.loadEvents(check.id)).status).toBe(STATUS.PAGA);
  });

  test('gateway still pending → reconcile is a no-op, money untouched', async () => {
    const { store, table, reconciler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    await charge({ checkId: check.id, amountCents: 5000 }); // never settled
    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.confirmed).toBe(0);
    expect(r.stillPending).toBe(1);
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0);
  });

  test('idempotent: once the webhook confirmed, reconcile does not double-count', async () => {
    const { store, psp, table, handler, reconciler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 10000 });
    psp.settleCharge(c.txid);
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 10000 });
    await handler(wh.rawBody, wh.signature); // webhook wins the race

    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.confirmed).toBe(0);
    expect(await store.loadEvents(check.id)).toHaveLength(2); // OPENED + 1 payment, no dup
  });

  test('grace window: a freshly created charge is not polled (webhook gets first crack)', async () => {
    const { store, psp, table, reconciler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 5000 });
    psp.settleCharge(c.txid);
    const r = await reconciler.reconcile({ graceMs: 60_000 }); // age ~0 < 60s
    expect(r.checked).toBe(0);
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0);
  });

  test('scopes to a single check when checkId is given', async () => {
    const { store, psp, venue, table, reconciler, charge } = freshWorld();
    const tableB = store.seedTable(venue.id, 'Mesa 9');
    const checkA = await openDemoCheck(store, table, 10000);
    const checkB = await store.openCheck(tableB.qrToken, [{ id: 'x', name: 'Item', priceCents: 5000 }]);
    const a = await charge({ checkId: checkA.id, amountCents: 4000 });
    const b = await charge({ checkId: checkB.id, amountCents: 3000 });
    psp.settleCharge(a.txid);
    psp.settleCharge(b.txid);

    const r = await reconciler.reconcile({ checkId: checkA.id, graceMs: 0 });
    expect(r.confirmed).toBe(1);
    expect(reduce(await store.loadEvents(checkA.id)).paidCents).toBe(4000);
    expect(reduce(await store.loadEvents(checkB.id)).paidCents).toBe(0); // untouched
  });

  test('a charge the PSP does not recognize is skipped, never confirmed', async () => {
    const { store, table, reconciler } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    // A payments row whose txid the gateway has never heard of (ghost/partial).
    await store.registerCharge({
      checkId: check.id, txid: 'ch_ghost_unknown', amountCents: 5000, tipCents: 0,
      payerLabel: null, method: 'pix',
    });
    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.unknown).toBe(1);
    expect(r.confirmed).toBe(0);
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0);
  });

  test('house_account rows are never reconciled against the gateway', async () => {
    const { store, table, reconciler } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    // Simulate a stray pending house row (method excluded by listPendingCharges).
    await store.registerCharge({
      checkId: check.id, txid: 'ha_should_be_ignored', amountCents: 3000, tipCents: 0,
      payerLabel: null, method: 'house_account',
    });
    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.checked).toBe(0);
  });

  test('a canceled/failed charge is bucketed as terminal, not endlessly pending', async () => {
    const { store, table, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 5000 });
    const stubPsp = {
      async getCharge() {
        return { txid: c.txid, status: 'canceled', paid: false, kind: 'payment_confirmed', amountCents: 5000, tipCents: 0, method: 'pix', raw: {} };
      },
    };
    const reconciler = createChargeReconciler({ store, psp: stubPsp, confirm: async () => ({ status: 'appended' }) });
    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.terminal).toBe(1);
    expect(r.stillPending).toBe(0);
    expect(r.confirmed).toBe(0);
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0);
  });

  test('a transient PSP error is counted, not swallowed, and never confirms', async () => {
    const { store, table, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    await charge({ checkId: check.id, amountCents: 5000 });
    const stubPsp = { async getCharge() { throw new Error('pagarme timeout 4000ms'); } };
    const reconciler = createChargeReconciler({ store, psp: stubPsp, confirm: async () => ({ status: 'appended' }) });
    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.errors).toBe(1);
    expect(r.confirmed).toBe(0);
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0);
  });

  test('a PSP without getCharge is a safe no-op — never throws on the read path', async () => {
    const { store } = freshWorld();
    const reconciler = createChargeReconciler({
      store, psp: {}, confirm: async () => ({ status: 'appended' }),
    });
    const r = await reconciler.reconcile({ graceMs: 0 });
    expect(r.note).toMatch(/getCharge/);
    expect(r.confirmed).toBe(0);
  });
});
