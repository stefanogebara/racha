'use strict';

/**
 * House service over the memory store — the full saldo-da-casa loop:
 * open → load (Pix) → webhook fallback credits → wallet → redeem on a check
 * → panel/reconcile see it. Clock injected → expiry is deterministic.
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createHouseService } = require('../_lib/house/house-service');
const { reduce } = require('../_lib/checks/check-state');
const { reconcileVenueHouse, reconcileVenue } = require('../_lib/checks/reconcile');

const SECRET = 'house-webhook-secret-0123456789';

function setup() {
  const store = createMemoryStore();
  const psp = new MockPsp({ webhookSecret: SECRET });
  let clockIso = '2026-07-19T12:00:00.000Z';
  const clock = {
    /** Que hora é agora — o painel agrupa por dia e precisa do mesmo relógio. */
    now: () => clockIso,
    set: (iso) => { clockIso = iso; },
    advanceDays: (d) => { clockIso = new Date(Date.parse(clockIso) + d * 86400000).toISOString(); },
  };
  const house = createHouseService({ store, psp, now: () => clockIso });
  const webhook = createWebhookHandler({
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    psp,
    fallback: (parsed) => house.confirmLoadFromWebhook(parsed),
  });
  return { store, psp, house, webhook, clock };
}

async function seedVenueWithHouse(store, house, over = {}) {
  const venue = store.seedVenue({ name: 'Bar Teste', servicoBp: 1000, pspRecipientId: 'rcpt_t' });
  await house.updateConfig(venue.id, { enabled: true, bonusBp: 1500, validityDays: 30, ...over });
  const table = store.seedTable(venue.id, 'Mesa 1');
  return { venue, table };
}

describe('house service', () => {
  test('open account: gates, duplicate phone never leaks the token', async () => {
    const { store, house } = setup();
    const { table } = await seedVenueWithHouse(store, house);

    await expect(house.openAccount({ tableQrToken: 'nope', phone: '11987654321', name: 'Ana' }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(house.openAccount({ tableQrToken: table.qrToken, phone: '123', name: 'Ana' }))
      .rejects.toThrow(/Telefone/);

    const a = await house.openAccount({ tableQrToken: table.qrToken, phone: '(11) 98765-4321', name: 'Ana' });
    expect(a.accountToken).toMatch(/^[0-9a-f]{32}$/);

    const dup = house.openAccount({ tableQrToken: table.qrToken, phone: '11987654321', name: 'Outra' });
    await expect(dup).rejects.toMatchObject({ statusCode: 409 });
    await expect(dup).rejects.toThrow(/balcão/);
  });

  test('disabled venue: no open, no load', async () => {
    const { store, house } = setup();
    const venue = store.seedVenue({ name: 'Fechado', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    const table = store.seedTable(venue.id, 'Mesa 1');
    // Pelo CÓDIGO, não pela frase: a frase é interna e o cliente traduz o
    // código. Amarrar o teste ao português é o que fazia a mudança certa
    // (`house_off` + centavos crus) parecer uma regressão.
    await expect(house.openAccount({ tableQrToken: table.qrToken, phone: '11987654321', name: 'A' }))
      .rejects.toMatchObject({ code: 'house_off', statusCode: 400 });
    const cfg = await house.publicConfig(table.qrToken);
    expect(cfg.enabled).toBe(false);
  });

  test('full loop: load → webhook credits principal+bonus → wallet → redeem bonus-first → check paid → reconcile clean', async () => {
    const { store, psp, house, webhook, clock } = setup();
    const { venue, table } = await seedVenueWithHouse(store, house); // 15% bonus
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11987654321', name: 'Ana' });

    // Load R$100 → bonus quoted R$15
    const loadQ = await house.createLoad({ accountToken, amountCents: 10000 });
    expect(loadQ.bonusCents).toBe(1500);
    expect(loadQ.copiaECola).toContain('br.gov.bcb.pix');

    // Wallet before confirmation: zeros
    let w = await house.wallet(accountToken);
    expect(w.account.totalCents).toBe(0);

    // Bank confirms via the SHARED webhook (fallback path)
    const wh = psp.buildConfirmationWebhook({ txid: loadQ.txid, amountCents: 10000, tipCents: 0 });
    const r1 = await webhook(wh.rawBody, wh.signature);
    expect(r1.status).toBe('load_applied');
    // at-least-once replay is a clean duplicate
    expect((await webhook(wh.rawBody, wh.signature)).status).toBe('duplicate');

    w = await house.wallet(accountToken);
    expect(w.account.principalCents).toBe(10000);
    expect(w.account.bonusCents).toBe(1500);
    expect(w.account.lots).toHaveLength(1);
    // Pelo TIPO — o servidor não manda frase; a tela traduz (PR #31, M-3).
    expect(w.account.ledger[0].type).toBe('load');
    expect(w.account.ledger[0]).not.toHaveProperty('label');
    expect(w.account.phoneMasked).toBe('•••• 4321');

    // Open a check R$80 and pay R$20 from balance → bonus first
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'Petiscos', priceCents: 8000 }]);
    const red = await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 2000 });
    expect(red.bonusUsedCents).toBe(1500);
    expect(red.principalUsedCents).toBe(500);
    expect(red.check.state.paidCents).toBe(2000);

    const st = reduce(await store.loadEvents(check.id));
    expect(st.payments[red.txid].amountCents).toBe(2000);
    expect(st.payments[red.txid].tipCents).toBe(0);

    // Panel counts the redemption like any confirmed payment
    const panel = await store.getPanelView(venue.id, clock.now());
    expect(panel.today.confirmedCents).toBe(2000);
    expect(panel.today.anomalies).toBe(0);

    // Both reconciliation layers are clean
    expect((await reconcileVenue(store, venue.id)).checksFailed).toBe(0);
    const hr = await reconcileVenueHouse(store, venue.id);
    expect(hr.ok).toBe(true);

    // Wallet after: bonus gone, principal 9500
    w = await house.wallet(accountToken);
    expect(w.account.bonusCents).toBe(0);
    expect(w.account.principalCents).toBe(9500);
  });

  test('redeem guards: cross-venue 409, over-remaining 400, insufficient 409, closed table 404', async () => {
    const { store, house } = setup();
    const { table } = await seedVenueWithHouse(store, house);
    const other = await seedVenueWithHouse(store, house, {});
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11911112222', name: 'B' });
    await house.createLoad({ accountToken, amountCents: 10000 })
      .then((l) => store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' }));

    await store.openCheck(other.table.qrToken, [{ id: 'x', name: 'X', priceCents: 5000 }]);
    await expect(house.redeem({ accountToken, tableQrToken: other.table.qrToken, amountCents: 1000 }))
      .rejects.toMatchObject({ statusCode: 409 }); // single-venue rule

    await store.openCheck(table.qrToken, [{ id: 'y', name: 'Y', priceCents: 3000 }]);
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 3001 }))
      .rejects.toThrow(/excede o que falta/);
    await expect(house.redeem({ accountToken, tableQrToken: 'dead', amountCents: 100 }))
      .rejects.toMatchObject({ statusCode: 404 });

    // spend 3000 of the 10000+bonus balance, then ask for more than remains
    await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 3000 });
    const venueId = (await store.getHouseAccountByToken(accountToken)).venueId;
    const bigTable = store.seedTable(venueId, 'Mesa 9');
    await store.openCheck(bigTable.qrToken, [{ id: 'z', name: 'Z', priceCents: 99999 }]);
    await expect(house.redeem({ accountToken, tableQrToken: bigTable.qrToken, amountCents: 9000 }))
      // Pelo CÓDIGO (0040), não pela frase — é o que a tela traduz.
      .rejects.toMatchObject({ statusCode: 409, code: 'house_insufficient_balance' }); // 8500 left (bonus 1500 spent first, then 1500 of principal)
  });

  test('bonus expires: unusable after validity, principal survives', async () => {
    const { store, house, clock } = setup();
    const { table } = await seedVenueWithHouse(store, house); // validity 30d
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11933334444', name: 'C' });
    const l = await house.createLoad({ accountToken, amountCents: 10000 });
    await store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' });

    clock.advanceDays(31);
    const w = await house.wallet(accountToken);
    expect(w.account.bonusCents).toBe(0);      // expired
    expect(w.account.principalCents).toBe(10000); // NEVER expires
    expect(w.account.lots).toHaveLength(0);

    await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 12000 }]);
    const red = await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 10000 });
    expect(red.bonusUsedCents).toBe(0);
    expect(red.principalUsedCents).toBe(10000);
  });

  test('load gates: min, max, quote snapshot survives config change', async () => {
    const { store, house, psp, webhook } = setup();
    const { table } = await seedVenueWithHouse(store, house); // 15%
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11955556666', name: 'D' });

    // O limite viaja em CENTAVOS nos `vars` — quem escreve "R$ 20,00" é o
    // cliente, que sabe a moeda e o idioma. O servidor formatava com
    // `toFixed(2)`, sem moeda, em português, pra qualquer leitor.
    await expect(house.createLoad({ accountToken, amountCents: 1999 }))
      .rejects.toMatchObject({ code: 'load_below_min', vars: { minCents: 2000 } });
    await expect(house.createLoad({ accountToken, amountCents: 50001 }))
      .rejects.toMatchObject({ code: 'load_above_max', vars: { maxCents: 50000 } });

    const l = await house.createLoad({ accountToken, amountCents: 10000 }); // quoted at 15%
    const venueId = (await store.getHouseAccountByToken(accountToken)).venueId;
    await house.updateConfig(venueId, { bonusBp: 0 }); // owner cuts bonus BEFORE bank confirms

    const wh = psp.buildConfirmationWebhook({ txid: l.txid, amountCents: 10000, tipCents: 0 });
    await webhook(wh.rawBody, wh.signature);
    const w = await house.wallet(accountToken);
    expect(w.account.bonusCents).toBe(1500); // the promise at charge time wins
  });

  test('webhook fallback rejects divergent amounts and load refunds', async () => {
    const { store, house, psp, webhook } = setup();
    const { table } = await seedVenueWithHouse(store, house);
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11977778888', name: 'E' });
    const l = await house.createLoad({ accountToken, amountCents: 10000 });

    const bad = psp.buildConfirmationWebhook({ txid: l.txid, amountCents: 9999, tipCents: 0 });
    expect((await webhook(bad.rawBody, bad.signature)).status).toBe('rejected');

    const refund = psp.buildRefundWebhook({ txid: l.txid, amountCents: 10000 });
    expect((await webhook(refund.rawBody, refund.signature)).status).toBe('rejected');

    expect((await house.wallet(accountToken)).account.totalCents).toBe(0);
  });

  test('admin: liability roll-up, refund principal, rotate token kills the old link', async () => {
    const { store, house } = setup();
    const { venue, table } = await seedVenueWithHouse(store, house);
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11999990000', name: 'F' });
    const l = await house.createLoad({ accountToken, amountCents: 20000 }); // +3000 bonus
    await store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' });

    let admin = await house.adminView(venue.id);
    expect(admin.liability).toEqual({ principalCents: 20000, bonusCents: 3000, accountCount: 1 });
    expect(admin.accounts[0].phoneMasked).toBe('•••• 0000');
    expect(JSON.stringify(admin)).not.toContain('11999990000'); // full phone never leaves

    const accountId = admin.accounts[0].id;
    const ref = await house.refundPrincipal({ accountId, amountCents: 5000 });
    expect(ref.principalCents).toBe(15000);
    await expect(house.refundPrincipal({ accountId, amountCents: 999999 }))
      .rejects.toMatchObject({ statusCode: 409 });

    const rot = await house.rotateToken(accountId);
    expect(await store.getHouseAccountByToken(accountToken)).toBeNull();
    expect((await house.wallet(rot.accountToken)).account.principalCents).toBe(15000);
  });

  test('raced second redeem that would overpay the check is refused AND compensated (review finding)', async () => {
    const { store, house } = setup();
    const { venue, table } = await seedVenueWithHouse(store, house);
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11912121212', name: 'R' });
    const l = await house.createLoad({ accountToken, amountCents: 30000 });
    await store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' });

    await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 10000 }]);
    // First redeem pays the check in full…
    await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 10000 });
    // …simulate the raced second request that already passed the app-side
    // remaining check: drive the store steps directly (the service guard
    // would catch it now, but the guarded append is the layer under test).
    const account = await store.getHouseAccountByToken(accountToken);
    const view0 = await store.listChecksForReconcile(account.venueId);
    const checkId = view0[0].checkId;
    const debit = await store.redeemHouse({
      accountId: account.id, checkId, txid: 'ha_raced_tx', amountCents: 5000, nowIso: '2026-07-19T12:05:00.000Z',
    });
    expect(debit.duplicate).toBe(false);
    await expect(store.appendHousePaymentGuarded(checkId, 'ha_raced_tx', 5000))
      .rejects.toMatchObject({ statusCode: 409 }); // check refuses the overpay
    const rev = await store.reverseHouseRedeem({ accountId: account.id, txid: 'ha_raced_tx', nowIso: '2026-07-19T12:05:01.000Z' });
    expect(rev.duplicate).toBe(false);

    // Balance fully restored; check not overpaid; reconciliation is CLEAN
    // (a reversed redeem must not demand a payments row).
    const w = await house.wallet(accountToken);
    expect(w.account.totalCents).toBe(30000 + 4500 - 10000);
    const hr = await reconcileVenueHouse(store, venue.id);
    expect(hr.ok).toBe(true);
  });

  test('idempotencyKey: a retried redeem debits once and returns the same txid (review finding)', async () => {
    const { store, house } = setup();
    const { table } = await seedVenueWithHouse(store, house);
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11913131313', name: 'I' });
    const l = await house.createLoad({ accountToken, amountCents: 10000 });
    await store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' });
    await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 20000 }]);

    const key = 'attempt-0001-abcdef';
    const r1 = await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 3000, idempotencyKey: key });
    const r2 = await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 3000, idempotencyKey: key });
    expect(r2.txid).toBe(r1.txid);
    expect(r2.principalUsedCents).toBe(r1.principalUsedCents);

    const w = await house.wallet(accountToken);
    expect(w.account.totalCents).toBe(11500 - 3000); // debited ONCE
    expect(r2.check.state.paidCents).toBe(3000);     // check paid ONCE
  });

  test('mid-redeem crash permutations get distinct reconciliation prescriptions (review finding)', async () => {
    const { store, house } = setup();
    const { venue, table } = await seedVenueWithHouse(store, house);
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11914141414', name: 'P' });
    const l = await house.createLoad({ accountToken, amountCents: 20000 });
    await store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' });
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 15000 }]);
    const account = await store.getHouseAccountByToken(accountToken);

    // permutation A: crash after debit only → re-credit prescription
    await store.redeemHouse({ accountId: account.id, checkId: check.id, txid: 'ha_crash_a', amountCents: 1000, nowIso: '2026-07-19T12:01:00.000Z' });
    // permutation B: crash after debit + check append → BACKFILL prescription
    await store.redeemHouse({ accountId: account.id, checkId: check.id, txid: 'ha_crash_b', amountCents: 2000, nowIso: '2026-07-19T12:02:00.000Z' });
    await store.appendHousePaymentGuarded(check.id, 'ha_crash_b', 2000);

    const hr = await reconcileVenueHouse(store, venue.id);
    expect(hr.ok).toBe(false);
    const a = hr.findings.find((f) => f.txid === 'ha_crash_a');
    const b = hr.findings.find((f) => f.txid === 'ha_crash_b');
    expect(a.code).toBe('house_redeem_missing_payment_row');
    // QUANTO e DE QUEM, pro dono agir (compliance, PR #42, M-2).
    expect(a.amountCents).toBe(1000);
    expect(a.accountId).toBe(account.id);
    expect(b.amountCents).toBe(2000);
    // A projeção (a que a página da carteira e o painel recebem) leva valor e
    // carteira, e NÃO leva a frase montada no servidor.
    const { projetarAchados } = require('../_app/router');
    const p = projetarAchados(hr.findings).find((f) => f.txid === 'ha_crash_a');
    expect(p).toMatchObject({ code: 'house_redeem_missing_payment_row', amountCents: 1000, accountId: account.id });
    expect(p.message).toBeUndefined();
    // E a ROTA da página da carteira leva também os achados POR CARTEIRA (os
    // que moram em `failed`) — sem eles, carteira divergente chegava com a
    // lista vazia e a página ficava verde (as duas revisões do PR #43).
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '_app', 'router.js'), 'utf8');
    expect(src).toMatch(/\.\.\.houseRecon\.findings,\s*\.\.\.houseRecon\.failed\.flatMap\(\(f\) => \(f\.findings \|\| \[\]\)\.map\(\(x\) => \(\{ \.\.\.x, accountId: f\.accountId \}\)\)\),/);
    expect(a.message).toMatch(/re-credit/);
    expect(b.code).toBe('house_redeem_missing_payment_row_paid');
    expect(b.message).toMatch(/BACKFILL|do NOT re-credit/);
  });

  describe('o dono devolve ao saldo o débito que não chegou à conta (0044)', () => {
    async function travado() {
      const ctx = setup();
      const { store, house, clock } = ctx;
      const { venue, table } = await seedVenueWithHouse(store, house);
      const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11915151515', name: 'Q' });
      const l = await house.createLoad({ accountToken, amountCents: 20000 });
      await store.confirmHouseLoad({ txid: l.txid, confirmedAt: clock.now() });
      const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 15000 }]);
      const account = await store.getHouseAccountByToken(accountToken);
      // O débito que "caiu" antes do lançamento: é o achado.
      await store.redeemHouse({ accountId: account.id, checkId: check.id, txid: 'ha_travado', amountCents: 1000, nowIso: clock.now() });
      const saldo = async () => (await house.wallet(accountToken)).account.totalCents;
      return { ...ctx, venue, table, check, account, accountToken, saldo };
    }
    const depois = (clock, min) => clock.set(new Date(Date.parse(clock.now()) + min * 60000).toISOString());

    test('devolve, grava o motivo e o AUTOR, e a conciliação fica limpa', async () => {
      const { store, house, clock, venue, account, saldo } = await travado();
      const antes = await saldo();
      depois(clock, 6);
      const r = await house.recreditStuckDebit({ venueId: venue.id, accountId: account.id, txid: 'ha_travado', actorUserId: 'user-dono-1' });
      expect(r).toEqual({ duplicate: false, amountCents: 1000 });
      expect(await saldo()).toBe(antes + 1000);
      const ev = (await store.loadHouseEvents(account.id)).find((e) => e.type === 'REDEEM_REVERSED');
      expect(ev.payload).toMatchObject({ txid: 'ha_travado', reason: 'owner_recredit', by: 'user-dono-1' });
      expect((await reconcileVenueHouse(store, venue.id)).ok).toBe(true);
      // Repetir não devolve de novo: o achado sumiu, então recusa.
      await expect(house.recreditStuckDebit({ venueId: venue.id, accountId: account.id, txid: 'ha_travado', actorUserId: 'user-dono-1' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'house_recredit_not_flagged' });
      expect(await saldo()).toBe(antes + 1000);
    });

    test('bônus que VENCEU entre o débito e a devolução volta como lote NOVO, válido — o saldo usável sobe o valor inteiro (compliance, PR #44, H-1)', async () => {
      const { store, house, clock, venue, check, account, accountToken } = await travado();
      const conta = async () => (await house.wallet(accountToken)).account;
      // Um débito que usa BÔNUS (gasto primeiro): 15% de 20000 = 3000 de bônus, validade 30 dias.
      const d = await store.redeemHouse({ accountId: account.id, checkId: check.id, txid: 'ha_bonus', amountCents: 2500, nowIso: clock.now() });
      expect(d.bonusUsedCents).toBeGreaterThan(0);
      // 40 dias depois o lote original venceu; o dono devolve.
      clock.advanceDays(40);
      const antes = await conta();
      const r = await house.recreditStuckDebit({ venueId: venue.id, accountId: account.id, txid: 'ha_bonus', actorUserId: 'dono' });
      expect(r.amountCents).toBe(2500);
      const depois = await conta();
      expect(depois.totalCents).toBe(antes.totalCents + 2500);                        // o valor INTEIRO é usável
      expect(depois.principalCents).toBe(antes.principalCents + d.principalUsedCents); // principal só a parte principal
      expect(depois.bonusCents).toBe(antes.bonusCents + d.bonusUsedCents);             // bônus volta como BÔNUS
      const ev = (await store.loadHouseEvents(account.id)).find((e) => e.type === 'REDEEM_REVERSED' && e.payload.txid === 'ha_bonus');
      expect(ev.payload).toMatchObject({ reason: 'owner_recredit', by: 'dono' });
      expect(ev.payload.reissue.bonusCents).toBe(d.bonusUsedCents);
      expect(Date.parse(ev.payload.reissue.expiresAt)).toBeGreaterThan(Date.parse(clock.now()));
    });

    test('antes de 5 minutos: recusa (pagamento pode estar em voo), sem mexer no saldo', async () => {
      const { house, clock, venue, account, saldo } = await travado();
      const antes = await saldo();
      depois(clock, 4);
      await expect(house.recreditStuckDebit({ venueId: venue.id, accountId: account.id, txid: 'ha_travado', actorUserId: 'u' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'house_recredit_too_soon' });
      expect(await saldo()).toBe(antes);
    });

    test('só o txid que a conciliação aponta: um pagamento que ENTROU não se devolve', async () => {
      const { store, house, clock, venue, check, account, saldo } = await travado();
      await store.redeemHouse({ accountId: account.id, checkId: check.id, txid: 'ha_pago', amountCents: 2000, nowIso: clock.now() });
      await store.appendHousePaymentGuarded(check.id, 'ha_pago', 2000);
      await store.recordHousePaymentRow({ checkId: check.id, venueId: venue.id, txid: 'ha_pago', amountCents: 2000, confirmedAt: clock.now() });
      depois(clock, 10);
      const antes = await saldo();
      for (const txid of ['ha_pago', 'ha_inventado']) {
        await expect(house.recreditStuckDebit({ venueId: venue.id, accountId: account.id, txid, actorUserId: 'u' }))
          .rejects.toMatchObject({ statusCode: 409, code: 'house_recredit_not_flagged' });
      }
      expect(await saldo()).toBe(antes);
    });

    test('carteira de OUTRA casa: 404; sem autor: 400 — e nada muda', async () => {
      const { store, house, clock, account, saldo } = await travado();
      const outra = store.seedVenue({ name: 'Outra', servicoBp: 1000, pspRecipientId: 'rcpt_o' });
      depois(clock, 10);
      const antes = await saldo();
      await expect(house.recreditStuckDebit({ venueId: outra.id, accountId: account.id, txid: 'ha_travado', actorUserId: 'u' }))
        .rejects.toMatchObject({ statusCode: 404, code: 'house_recredit_not_flagged' });
      await expect(house.recreditStuckDebit({ venueId: account.venueId, accountId: account.id, txid: 'ha_travado', actorUserId: '' }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(await saldo()).toBe(antes);
    });
  });

  test('bonus expiry is end-of-day São Paulo on the displayed date (review finding)', async () => {
    const { store, house, clock } = setup();
    const { table } = await seedVenueWithHouse(store, house); // validity 30d
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11915151515', name: 'E' });
    const l = await house.createLoad({ accountToken, amountCents: 10000 });
    await store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' }); // SP date 19/07

    const w = await house.wallet(accountToken);
    // last valid day = 18/08 SP → instant 2026-08-19T02:59:59.999Z
    expect(w.account.lots[0].expiresAt).toBe('2026-08-19T02:59:59.999Z');

    // still spendable at 20:00 SP ON the displayed final day (the old
    // instant-based expiry died at 12:00)…
    clock.set('2026-08-18T23:00:00.000Z'); // 20:00 SP on 18/08
    expect((await house.wallet(accountToken)).account.bonusCents).toBe(1500);
    // …and gone the SP-morning after
    clock.set('2026-08-19T03:00:00.000Z');
    expect((await house.wallet(accountToken)).account.bonusCents).toBe(0);
  });

  test('wallet response discloses config; refund surfaces still-active bonus (review findings)', async () => {
    const { store, house } = setup();
    const { venue, table } = await seedVenueWithHouse(store, house);
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11916161616', name: 'C' });
    const l = await house.createLoad({ accountToken, amountCents: 10000 });
    await store.confirmHouseLoad({ txid: l.txid, confirmedAt: '2026-07-19T12:00:00.000Z' });

    const w = await house.wallet(accountToken);
    expect(w.config).toEqual({ bonusBp: 1500, validityDays: 30 });

    const admin = await house.adminView(venue.id);
    const ref = await house.refundPrincipal({ accountId: admin.accounts[0].id, amountCents: 10000 });
    expect(ref.principalCents).toBe(0);
    expect(ref.bonusCents).toBe(1500); // the owner SEES the surviving bonus
  });

  test('config validation: legal floor on validity, min>max rejected', async () => {
    const { store, house } = setup();
    const venue = store.seedVenue({ name: 'Cfg', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    await expect(house.updateConfig(venue.id, { validityDays: 29 })).rejects.toThrow(/mínimo legal/);
    await expect(house.updateConfig(venue.id, { bonusBp: 5001 })).rejects.toThrow(/intervalo/);
    await expect(house.updateConfig(venue.id, { minLoadCents: 9000, maxLoadCents: 5000 }))
      .rejects.toThrow(/maior que a máxima/);
    const ok = await house.updateConfig(venue.id, { enabled: true, bonusBp: 0 });
    expect(ok.config.enabled).toBe(true);
  });
});
