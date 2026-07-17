'use strict';

/**
 * Store contract — the SAME battery runs against every store implementation.
 * memory: always. supabase: only when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are present (CI/local with .env); each run seeds an isolated __contract__
 * venue and deletes it (cascade) afterwards.
 *
 * This is what makes "the memory store's interface is the contract" true
 * instead of aspirational.
 */

const crypto = require('crypto');
const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');
const { reduce, STATUS } = require('../_lib/checks/check-state');

const SECRET = 'contract-webhook-secret-0123456789';

const impls = [
  { name: 'memory', make: async () => ({ store: createMemoryStore(), cleanup: async () => {} }) },
];

const hasLive = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (hasLive) {
  const { createSupabaseStore } = require('../_lib/store/supabase');
  impls.push({
    name: 'supabase',
    make: async () => {
      const store = createSupabaseStore();
      const created = [];
      const origSeed = store.seedVenue.bind(store);
      store.seedVenue = async (args) => {
        const v = await origSeed({ ...args, name: `__contract__ ${args.name}` });
        created.push(v.id);
        return v;
      };
      return {
        store,
        cleanup: async () => {
          for (const id of created) {
            await store.client.from('venues').delete().eq('id', id);
          }
        },
      };
    },
  });
}

describe.each(impls)('store contract [$name]', ({ make }) => {
  let store, cleanup, psp, handler, charge, venue, table;

  beforeAll(async () => {
    ({ store, cleanup } = await make());
    psp = new MockPsp({ webhookSecret: SECRET });
    handler = createWebhookHandler({
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      psp,
    });
    charge = createChargeService({ store, psp });
    venue = await store.seedVenue({ name: 'Contrato', servicoBp: 1000, pspRecipientId: 'rcpt_contract' });
    table = await store.seedTable(venue.id, `Mesa ${crypto.randomInt(1000, 9999)}`);
  });

  afterAll(async () => { await cleanup(); });

  test('full money loop: open → view → charge → webhook → state → panel', async () => {
    const check = await store.openCheck(table.qrToken, [
      { id: 'a', name: 'Item A', priceCents: 7000 },
      { id: 'b', name: 'Item B', priceCents: 3000 },
    ]);

    // view by QR
    const view = await store.getCheckByQrToken(table.qrToken);
    expect(view.venue.servicoBp).toBe(1000);
    expect(view.state.status).toBe(STATUS.ABERTA);
    expect(view.state.totalCents).toBe(10000);
    expect(view.check.items).toHaveLength(2);

    // charge + confirm
    const c = await charge({ checkId: check.id, amountCents: 6000, tipCents: 600, payerLabel: 'Contrato' });
    const wh = psp.buildConfirmationWebhook({
      txid: c.txid, amountCents: 6000, tipCents: 600,
      payerName: 'Pessoa Contrato da Silva', payerCpf: '390.533.447-05',
    });
    const res = await handler(wh.rawBody, wh.signature);
    expect(res.status).toBe('appended');

    // derived state
    const state = reduce(await store.loadEvents(check.id));
    expect(state.status).toBe(STATUS.PARCIAL);
    expect(state.paidCents).toBe(6000);
    expect(state.tipCents).toBe(600);
    expect(state.anomalies).toEqual([]);

    // payment row: confirmed, masked, competência stamped
    const row = await store.getPayment(c.txid);
    expect(row.status).toBe('confirmado');
    expect(row.confirmedAt).toBeTruthy();
    expect(JSON.stringify(row.pspPayloadMasked)).not.toMatch(/Silva|390\.533/);

    // replay is a duplicate no-op
    expect((await handler(wh.rawBody, wh.signature)).status).toBe('duplicate');

    // panel aggregates
    const panel = await store.getPanelView(venue.id);
    expect(panel.venue.name).toContain('Contrato');
    const mine = panel.checks.find((r) => r.checkId === check.id);
    expect(mine.state.paidCents).toBe(6000);
    expect(panel.today.confirmedCents).toBeGreaterThanOrEqual(6000);
    expect(panel.today.tipsCents).toBeGreaterThanOrEqual(600);
    expect(panel.today.anomalies).toBe(0);
  });

  test('charge gates hold: no recipient / above remaining', async () => {
    const bare = await store.seedVenue({ name: 'SemRecipient', servicoBp: 1000, pspRecipientId: null });
    const bareTable = await store.seedTable(bare.id, `Mesa ${crypto.randomInt(1000, 9999)}`);
    const bareCheck = await store.openCheck(bareTable.qrToken, [{ id: 'x', name: 'X', priceCents: 500 }]);
    await expect(charge({ checkId: bareCheck.id, amountCents: 100 }))
      .rejects.toThrow(/settlement recipient/);

    const check2 = await store.openCheck(
      (await store.seedTable(venue.id, `Mesa ${crypto.randomInt(1000, 9999)}`)).qrToken,
      [{ id: 'y', name: 'Y', priceCents: 500 }],
    );
    await expect(charge({ checkId: check2.id, amountCents: 501 })).rejects.toThrow(/exceeds remaining/);
  });

  test('unknown QR token and unknown txid resolve to null (never throw)', async () => {
    expect(await store.getCheckByQrToken('nope-' + crypto.randomUUID())).toBeNull();
    expect(await store.findCheckByTxid('ghost-' + crypto.randomUUID())).toBeNull();
  });
});
