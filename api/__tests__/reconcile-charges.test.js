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

describe('recusa do pagador: `requires_payment_method` é ambíguo', () => {
  const { createChargeReconciler } = require('../_lib/checks/reconcile-charges');

  /**
   * O caso concreto, e é o trilho PRINCIPAL da Espanha: a pessoa recebe o
   * pedido no app do banco e recusa. Nada nos avisa — o adaptador nem
   * interpreta `payment_intent.payment_failed`. A conciliação ativa é o único
   * lugar que descobre, e ela só descobre se souber separar "ninguém tentou
   * ainda" de "tentou e não deu".
   *
   * Medido contra a API (2026-09-08): um intent recém-criado está em
   * `requires_payment_method` sem `last_payment_error` e sem cobrança. Uma
   * recusa de verdade não é reproduzível no modo de teste (o Bizum autoriza
   * sozinho em segundos), então o dublê abaixo reproduz a FORMA da resposta.
   */
  async function world(charge) {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Bar Pepe', servicoBp: 0, pspRecipientId: 'acct_v' });
    const table = await store.seedTable(venue.id, 'Mesa 4');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 3390 }]);
    await store.registerCharge({
      checkId: check.id, txid: 'pi_x', amountCents: 3390, tipCents: 0,
      payerLabel: null, method: 'bizum',
    });
    const reconciler = createChargeReconciler({
      store,
      psp: { async getCharge() { return charge; } },
      confirm: async () => { throw new Error('não deve confirmar o que não foi pago'); },
    });
    return reconciler.reconcile({ graceMs: -1 });
  }

  test('cobrança recém-criada continua PENDENTE, não terminal', async () => {
    // Se `requires_payment_method` entrasse na lista de terminais, toda
    // cobrança recém-criada viraria um achado — ruído que esconde o sinal.
    const r = await world({
      txid: 'pi_x', status: 'requires_payment_method', paid: false,
      attempted: false, amountCents: 3390, tipCents: 0, method: 'bizum',
    });
    expect(r.stillPending).toBe(1);
    expect(r.terminal).toBe(0);
  });

  test('recusa do pagador é TERMINAL e visível, não silêncio até a janela fechar', async () => {
    // `attempted` é o que separa os dois: houve erro de pagamento ou cobrança.
    const r = await world({
      txid: 'pi_x', status: 'requires_payment_method', paid: false,
      attempted: true, amountCents: 3390, tipCents: 0, method: 'bizum',
    });
    expect(r.terminal).toBe(1);
    expect(r.stillPending).toBe(0);
    expect(r.details.some((d) => d.txid === 'pi_x' && /requires_payment_method/.test(d.status))).toBe(true);
  });

  test('cancelado continua terminal mesmo sem `attempted`', async () => {
    // `canceled` nunca foi ambíguo, e a mudança não pode ter trocado uma
    // deteção que já funcionava por uma que depende de um campo novo.
    const r = await world({
      txid: 'pi_x', status: 'canceled', paid: false,
      amountCents: 3390, tipCents: 0, method: 'bizum',
    });
    expect(r.terminal).toBe(1);
  });
});

describe('Bizum ABANDONADO: quem abriu o app do banco e não voltou', () => {
  const { createChargeReconciler, ABANDONED_AFTER_MS } = require('../_lib/checks/reconcile-charges');

  /**
   * O caso, e ele é comum: a pessoa confirma, o app do banco abre, ela é
   * chamada pra mesa, fecha o telefone. O intent fica em `requires_action`
   * pra sempre.
   *
   * Sem julgamento de idade, a cobrança ficava `stillPending` até sair da
   * janela de 24h e DESAPARECER sem registro: ninguém nunca soube que aquela
   * mesa tentou pagar e não conseguiu. Achado da revisão de compliance (M4).
   *
   * E `requires_action` não pode ser terminal por si — é o estado normal de
   * quem está autorizando neste segundo. Só a IDADE separa os dois.
   */
  async function world(idadeMs) {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Bar Pepe', servicoBp: 0, pspRecipientId: 'acct_v' });
    const table = await store.seedTable(venue.id, 'Mesa 4');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 3390 }]);
    await store.registerCharge({
      checkId: check.id, txid: 'pi_ab', amountCents: 3390, tipCents: 0, payerLabel: null, method: 'bizum',
    });
    // Envelhece a cobrança na mão: o store guarda `createdAt` na criação.
    const pend = await store.listPendingCharges({ checkId: check.id, graceMs: -1 });
    expect(pend[0].createdAt).toBeTruthy();
    const antigo = new Date(Date.now() - idadeMs).toISOString();
    const original = store.listPendingCharges.bind(store);
    store.listPendingCharges = async (o) => (await original(o)).map((r) => ({ ...r, createdAt: antigo }));

    const reconciler = createChargeReconciler({
      store,
      psp: {
        async getCharge() {
          return {
            txid: 'pi_ab', status: 'requires_action', paid: false, attempted: true,
            amountCents: 3390, tipCents: 0, method: 'bizum',
          };
        },
      },
      confirm: async () => { throw new Error('não deve confirmar o que não foi pago'); },
    });
    return reconciler.reconcile({ graceMs: -1 });
  }

  test('autorização RECENTE segue pendente — a pessoa pode estar aprovando agora', async () => {
    const r = await world(60 * 1000);
    expect(r.stillPending).toBe(1);
    expect(r.terminal).toBe(0);
  });

  test('autorização VELHA é abandono: terminal e visível, não silêncio', async () => {
    const r = await world(ABANDONED_AFTER_MS + 60 * 1000);
    expect(r.terminal).toBe(1);
    expect(r.stillPending).toBe(0);
    expect(r.details.some((d) => d.txid === 'pi_ab' && /requires_action/.test(d.status))).toBe(true);
  });

  test('sem `createdAt` a cobrança NÃO é declarada abandonada', async () => {
    // Um store antigo, ou uma projeção que esqueceu o campo, não pode fazer o
    // conciliador inventar abandono — na falta do dado, o lado seguro é
    // "ainda esperando".
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Bar Pepe', servicoBp: 0, pspRecipientId: 'acct_v' });
    const table = await store.seedTable(venue.id, 'Mesa 4');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 3390 }]);
    await store.registerCharge({
      checkId: check.id, txid: 'pi_ab', amountCents: 3390, tipCents: 0, payerLabel: null, method: 'bizum',
    });
    const original = store.listPendingCharges.bind(store);
    store.listPendingCharges = async (o) => (await original(o)).map(({ createdAt, ...r }) => r);
    const reconciler = createChargeReconciler({
      store,
      psp: { async getCharge() { return { txid: 'pi_ab', status: 'requires_action', paid: false, amountCents: 3390, tipCents: 0 }; } },
      confirm: async () => ({ status: 'appended' }),
    });
    const r = await reconciler.reconcile({ graceMs: -1 });
    expect(r.stillPending).toBe(1);
    expect(r.terminal).toBe(0);
  });
});

describe('dinheiro que CHEGOU com valor diferente do pedido', () => {
  /**
   * `overpaid` estava em TERMINAL_UNPAID — a lista que este arquivo documenta
   * como "cobranças que nunca vão ser pagas" — e `underpaid` não estava em
   * lista nenhuma. Nos dois status a conta da casa foi creditada: o pagador
   * digitou outro número no app do banco. A rede de segurança olhava pro
   * dinheiro na conta e o contava como abandono, a conta seguia aberta, e a
   * mesa era cobrada de novo. Achado pela revisão de compliance de 2026-09-08.
   */
  const cobrancaComStatus = (status, pagoCents) => ({
    async getCharge(txid) {
      return {
        txid, status, paid: true, kind: 'payment_confirmed',
        amountCents: pagoCents - Math.round(pagoCents / 11), tipCents: Math.round(pagoCents / 11),
        method: 'pix', raw: { status },
      };
    },
  });

  for (const [status, pago] of [['underpaid', 5500], ['overpaid', 9900]]) {
    test(`${status} é CONFIRMADO pela conciliação, não contado como abandono`, async () => {
      const { store, table, charge } = freshWorld();
      const check = await openDemoCheck(store, table, 10000);
      const c = await charge({ checkId: check.id, amountCents: 8000, tipCents: 800 });

      const confirmDeps = {
        loadEvents: store.loadEvents.bind(store),
        appendEvent: store.appendEvent.bind(store),
        recordPayment: store.recordPayment.bind(store),
        findCheckByTxid: store.findCheckByTxid.bind(store),
        getPayment: store.getPayment.bind(store),
      };
      const reconciler = createChargeReconciler({
        store, psp: cobrancaComStatus(status, pago),
        confirm: (parsed) => applyConfirmedPayment(parsed, confirmDeps),
      });

      const r = await reconciler.reconcile({ checkId: check.id, graceMs: 0 });
      expect(r.terminal).toBe(0);            // não é cobrança morta
      expect(r.confirmed).toBe(1);           // o dinheiro entrou no razão
      const st = reduce(await store.loadEvents(check.id));
      expect(st.paidCents + st.tipCents).toBe(pago);
      expect((await store.getPayment(c.txid)).status).toBe('confirmado');
    });
  }
});

describe('dinheiro que entrou e VOLTOU sem passar pelo razão', () => {
  /**
   * `refunded` e `chargedback` no adquirente sobre uma cobrança que a nossa
   * confirmação nunca alcançou: as duas pernas do dinheiro somem. Líquido zero
   * pra casa, e nenhum rastro de que houve dinheiro — o inegociável #6 no
   * miúdo. A linha ia pra `expirado` e um contador subia.
   */
  const { reduce } = require('../_lib/checks/check-state');

  for (const status of ['refunded', 'chargedback']) {
    test(`${status} deixa anomalia na conta, não só um contador`, async () => {
      const { store, table, charge } = freshWorld();
      const check = await openDemoCheck(store, table, 10000);
      const c = await charge({ checkId: check.id, amountCents: 8000, tipCents: 800 });

      const reconciler = createChargeReconciler({
        store,
        psp: { getCharge: async (txid) => ({ txid, status, paid: false, amountCents: 8000, tipCents: 800 }) },
        confirm: async () => ({ status: 'duplicate' }),
      });
      const r = await reconciler.reconcile({ checkId: check.id, graceMs: 0 });
      expect(r.terminal).toBe(1);

      const st = reduce(await store.loadEvents(check.id));
      const a = st.anomalies.find((x) => x.txid === c.txid);
      expect(a).toBeDefined();
      expect(a.severity).toBe('high');
      expect(a.reason).toMatch(new RegExp(status));

      // E a varredura seguinte não empilha a mesma anomalia.
      await reconciler.reconcile({ checkId: check.id, graceMs: 0 });
      expect(reduce(await store.loadEvents(check.id)).anomalies.length).toBe(1);
    });
  }

  test('cancelada de verdade (dinheiro nunca entrou) NÃO vira anomalia', async () => {
    const { store, table, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    await charge({ checkId: check.id, amountCents: 8000, tipCents: 800 });
    const reconciler = createChargeReconciler({
      store,
      psp: { getCharge: async (txid) => ({ txid, status: 'canceled', paid: false }) },
      confirm: async () => ({ status: 'duplicate' }),
    });
    const r = await reconciler.reconcile({ checkId: check.id, graceMs: 0 });
    expect(r.terminal).toBe(1);
    expect(reduce(await store.loadEvents(check.id)).anomalies).toEqual([]);
  });
});
