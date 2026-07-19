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

  test('house accounts: open → load → confirm (idempotent) → redeem FIFO → refund → rotate → reconcile inputs', async () => {
    const { reconcileVenueHouse } = require('../_lib/checks/reconcile');
    const houseState = require('../_lib/house/account-state');

    const hv = await store.seedVenue({ name: 'CasaContrato', servicoBp: 1000, pspRecipientId: 'rcpt_house' });
    await store.setHouseConfig(hv.id, { enabled: true, bonusBp: 1500, validityDays: 30 });
    const hTable = await store.seedTable(hv.id, `Mesa ${crypto.randomInt(1000, 9999)}`);

    // venue-by-token carries the house config
    const hit = await store.getVenueByTableToken(hTable.qrToken);
    expect(hit.venue.houseEnabled).toBe(true);
    expect(hit.venue.houseBonusBp).toBe(1500);
    expect(await store.getVenueByTableToken('dead-' + crypto.randomUUID())).toBeNull();

    // open — duplicate phone rejected, token never a phone-derived value
    const phone = '119' + String(crypto.randomInt(10000000, 99999999));
    const acc = await store.createHouseAccount({ venueId: hv.id, phone, name: 'Contrato' });
    expect(acc.accountToken).toMatch(/^[0-9a-f]{32}$/);
    await expect(store.createHouseAccount({ venueId: hv.id, phone, name: 'Dup' }))
      .rejects.toThrow(/duplicate/);
    expect((await store.getHouseAccountByToken(acc.accountToken)).id).toBe(acc.id);
    expect(await store.getHouseAccountByToken('nope')).toBeNull();
    expect(await store.getHouseAccountById('not-a-uuid')).toBeNull();

    // two loads with different expiries → FIFO ordering is observable
    const t0 = '2026-07-19T12:00:00.000Z';
    await store.registerHouseLoad({ accountId: acc.id, txid: `hl1_${acc.id.slice(0, 8)}`, amountCents: 10000, bonusCents: 1000, validityDays: 60 });
    await store.registerHouseLoad({ accountId: acc.id, txid: `hl2_${acc.id.slice(0, 8)}`, amountCents: 5000, bonusCents: 800, validityDays: 30 });
    const c1 = await store.confirmHouseLoad({ txid: `hl1_${acc.id.slice(0, 8)}`, confirmedAt: t0 });
    expect(c1.duplicate).toBe(false);
    expect((await store.confirmHouseLoad({ txid: `hl1_${acc.id.slice(0, 8)}`, confirmedAt: t0 })).duplicate).toBe(true);
    await store.confirmHouseLoad({ txid: `hl2_${acc.id.slice(0, 8)}`, confirmedAt: t0 });

    const load = await store.findHouseLoadByTxid(`hl1_${acc.id.slice(0, 8)}`);
    expect(load.status).toBe('confirmado');
    expect(load.amountCents).toBe(10000);

    let state = houseState.reduce(await store.loadHouseEvents(acc.id));
    expect(state.principalCents).toBe(15000);
    expect(state.lots).toHaveLength(2);

    // redeem 1500 at t1: lot from hl2 (30d, expires sooner) drains FIRST
    const hCheck = await store.openCheck(hTable.qrToken, [{ id: 'a', name: 'A', priceCents: 9000 }]);
    const t1 = '2026-07-20T12:00:00.000Z';
    const red = await store.redeemHouse({
      accountId: acc.id, checkId: hCheck.id, txid: `hr1_${acc.id.slice(0, 8)}`, amountCents: 1500, nowIso: t1,
    });
    expect(red.bonusUsedCents).toBe(1500);
    expect(red.principalUsedCents).toBe(0);
    state = houseState.reduce(await store.loadHouseEvents(acc.id));
    const bySeq = new Map(state.lots.map((l) => [l.seq, l]));
    expect([...bySeq.values()].find((l) => l.grantedCents === 800).remainingCents).toBe(0);   // hl2 drained
    expect([...bySeq.values()].find((l) => l.grantedCents === 1000).remainingCents).toBe(300); // hl1 partially

    // insufficient → 409-shaped error, nothing changes
    await expect(store.redeemHouse({
      accountId: acc.id, checkId: hCheck.id, txid: `hr2_${acc.id.slice(0, 8)}`, amountCents: 99999, nowIso: t1,
    })).rejects.toMatchObject({ statusCode: 409 });

    // refund principal; over-refund rejected
    const ref = await store.refundHousePrincipal({ accountId: acc.id, amountCents: 5000, nowIso: t1 });
    expect(ref.principalCents).toBe(10000);
    await expect(store.refundHousePrincipal({ accountId: acc.id, amountCents: 999999, nowIso: t1 }))
      .rejects.toMatchObject({ statusCode: 409 });

    // rotate: old token dies
    const rot = await store.rotateHouseAccountToken(acc.id);
    expect(rot.accountToken).not.toBe(acc.accountToken);
    expect(await store.getHouseAccountByToken(acc.accountToken)).toBeNull();
    expect((await store.getHouseAccountByToken(rot.accountToken)).id).toBe(acc.id);

    // payments row for the redeem + house reconciliation is clean end to end
    await store.recordHousePaymentRow({
      checkId: hCheck.id, venueId: hv.id, txid: `hr1_${acc.id.slice(0, 8)}`, amountCents: 1500, confirmedAt: t1,
    });
    const recon = await reconcileVenueHouse(store, hv.id);
    expect(recon.ok).toBe(true);
    expect(recon.accountsChecked).toBeGreaterThanOrEqual(1);

    // listHouseAccounts masks nothing here (store returns raw; the SERVICE masks)
    const list = await store.listHouseAccounts(hv.id);
    expect(list.find((a) => a.id === acc.id).phone).toBe(phone);
  });

  test('house hardening: dup load txid, idempotent redeem, guarded check append + reversal, frozen accounts', async () => {
    const hv = await store.seedVenue({ name: 'CasaDura', servicoBp: 1000, pspRecipientId: 'rcpt_dura' });
    await store.setHouseConfig(hv.id, { enabled: true, bonusBp: 1000, validityDays: 30 });
    const hTable = await store.seedTable(hv.id, `Mesa ${crypto.randomInt(1000, 9999)}`);
    const phone = '118' + String(crypto.randomInt(10000000, 99999999));
    const acc = await store.createHouseAccount({ venueId: hv.id, phone, name: 'Dura' });
    const t0 = '2026-07-19T12:00:00.000Z';
    const uniq = acc.id.slice(0, 8);

    // duplicate load txid must fail loudly on BOTH stores (never overwrite money)
    await store.registerHouseLoad({ accountId: acc.id, txid: `dl_${uniq}`, amountCents: 10000, bonusCents: 0, validityDays: 30 });
    await expect(store.registerHouseLoad({ accountId: acc.id, txid: `dl_${uniq}`, amountCents: 99999, bonusCents: 0, validityDays: 30 }))
      .rejects.toThrow(/duplicate|unique/i);
    await store.confirmHouseLoad({ txid: `dl_${uniq}`, confirmedAt: t0 });

    const check = await store.openCheck(hTable.qrToken, [{ id: 'a', name: 'A', priceCents: 5000 }]);

    // idempotent redeem: same txid twice = one debit, prior breakdown returned
    const r1 = await store.redeemHouse({ accountId: acc.id, checkId: check.id, txid: `ir_${uniq}`, amountCents: 2000, nowIso: t0 });
    expect(r1.duplicate).toBe(false);
    const r2 = await store.redeemHouse({ accountId: acc.id, checkId: check.id, txid: `ir_${uniq}`, amountCents: 2000, nowIso: t0 });
    expect(r2.duplicate).toBe(true);
    expect(r2.principalUsedCents).toBe(2000);
    const houseState2 = require('../_lib/house/account-state');
    expect(houseState2.reduce(await store.loadHouseEvents(acc.id)).principalCents).toBe(8000);

    // guarded append: pays, dedups by txid, and REFUSES overpay
    const seq1 = await store.appendHousePaymentGuarded(check.id, `ir_${uniq}`, 2000);
    expect(await store.appendHousePaymentGuarded(check.id, `ir_${uniq}`, 2000)).toBe(seq1); // replay no-op
    await expect(store.appendHousePaymentGuarded(check.id, `over_${uniq}`, 3001))
      .rejects.toMatchObject({ statusCode: 409 }); // 2000 paid + 3001 > 5000
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(2000);

    // reversal restores the exact breakdown, idempotently
    await store.redeemHouse({ accountId: acc.id, checkId: check.id, txid: `rv_${uniq}`, amountCents: 1000, nowIso: t0 });
    expect((await store.reverseHouseRedeem({ accountId: acc.id, txid: `rv_${uniq}`, nowIso: t0 })).duplicate).toBe(false);
    expect((await store.reverseHouseRedeem({ accountId: acc.id, txid: `rv_${uniq}`, nowIso: t0 })).duplicate).toBe(true);
    expect(houseState2.reduce(await store.loadHouseEvents(acc.id)).principalCents).toBe(8000);

    // payments-row idempotency: a second write never clobbers the first
    await store.recordHousePaymentRow({ checkId: check.id, venueId: hv.id, txid: `ir_${uniq}`, amountCents: 2000, confirmedAt: t0 });
    await store.recordHousePaymentRow({ checkId: check.id, venueId: hv.id, txid: `ir_${uniq}`, amountCents: 9999, confirmedAt: t0 });
    expect((await store.getPayment(`ir_${uniq}`)).amountCents).toBe(2000);

    // frozen account: token dies, redeem refuses, admin lookups still resolve
    await store.setHouseAccountActive(acc.id, false);
    expect(await store.getHouseAccountByToken(acc.accountToken)).toBeNull();
    await expect(store.redeemHouse({ accountId: acc.id, checkId: check.id, txid: `fz_${uniq}`, amountCents: 100, nowIso: t0 }))
      .rejects.toThrow(/unknown house account|Conta não encontrada/);
    expect((await store.getHouseAccountById(acc.id)).active).toBe(false);
    await store.setHouseAccountActive(acc.id, true);
    expect((await store.getHouseAccountByToken(acc.accountToken)).id).toBe(acc.id);
  });

  test('open check stays reachable after 10+ closed checks on the same table (review finding)', async () => {
    const hv = await store.seedVenue({ name: 'MesaCheia', servicoBp: 1000, pspRecipientId: 'rcpt_cheia' });
    const t = await store.seedTable(hv.id, `Mesa ${crypto.randomInt(1000, 9999)}`);
    for (let i = 0; i < 11; i += 1) {
      const c = await store.openCheck(t.qrToken, [{ id: 'x', name: 'X', priceCents: 1000 }]);
      await store.appendEvent(c.id, 'CLOSED', {});
    }
    const open = await store.openCheck(t.qrToken, [{ id: 'y', name: 'Y', priceCents: 4200 }]);
    const view = await store.getCheckByQrToken(t.qrToken);
    expect(view).not.toBeNull();
    expect(view.check.id).toBe(open.id);
    expect(view.state.totalCents).toBe(4200);
  });
});
