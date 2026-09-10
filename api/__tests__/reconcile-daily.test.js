'use strict';

/**
 * A varredura diária — a regra #8 do CLAUDE.md ("job diário, por restaurante,
 * ao centavo; um canário vermelho PAGINA, nunca só loga").
 *
 * O canário em si já é testado em reconcile.test.js. O que se testa aqui é o
 * que faltava: que ele TEM um caller que roda sozinho, que uma casa quebrada
 * não cega as outras, e que drift vira mensagem em vez de virar log.
 */

const { reconcileAllVenues, reconcileOneVenue, formatReconcileAlert } =
  require('../_lib/checks/reconcile-daily');
const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a, tip = 0) =>
  ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: tip, method: 'pix' } });
const row = (txid, a, tip = 0, status = 'confirmado') => ({ txid, amountCents: a, tipCents: tip, status });

/** Store mínimo: só o que a varredura consome. */
function fakeStore({ venues, checksByVenue = {}, accountsByVenue = {} }) {
  return {
    async listVenueActivation() { return venues; },
    async listChecksForReconcile(venueId) {
      if (checksByVenue[venueId] instanceof Error) throw checksByVenue[venueId];
      return checksByVenue[venueId] || [];
    },
    async listHouseAccountsForReconcile(venueId) { return accountsByVenue[venueId] || []; },
  };
}

const venue = (id, name, extra = {}) => ({ id, name, isTest: false, ...extra });

describe('reconcileAllVenues — a varredura', () => {
  test('casa limpa → verde, sem achado', async () => {
    const store = fakeStore({
      venues: [venue('v1', 'Bar do Zé')],
      checksByVenue: {
        v1: [{ checkId: 'c1', events: [opened(10000), paid('tx1', 10000)], payments: [row('tx1', 10000)] }],
      },
    });
    const r = await reconcileAllVenues(store);
    expect(r.venuesChecked).toBe(1);
    expect(r.venuesRed).toBe(0);
    expect(r.worstSeverity).toBe('ok');
    expect(r.totalDriftCents).toBe(0);
    expect(formatReconcileAlert(r)).toBeNull();   // verde não acorda ninguém
  });

  test('drift de um centavo aparece e vira alerta', async () => {
    // O log diz que entraram 100,00; a tabela de pagamentos diz 99,99.
    const store = fakeStore({
      venues: [venue('v1', 'Bar do Zé')],
      checksByVenue: {
        v1: [{ checkId: 'c1', events: [opened(10000), paid('tx1', 10000)], payments: [row('tx1', 9999)] }],
      },
    });
    const r = await reconcileAllVenues(store);
    expect(r.venuesRed).toBe(1);
    expect(r.totalDriftCents).toBeGreaterThan(0);
    const msg = formatReconcileAlert(r);
    expect(msg).toContain('Bar do Zé');          // a casa, pelo nome
    expect(msg).toMatch(/1 de 1/);               // quantas, de quantas
  });

  test('uma casa que explode não cega as outras', async () => {
    const store = fakeStore({
      venues: [venue('v1', 'Quebrada'), venue('v2', 'Boa')],
      checksByVenue: {
        v1: new Error('coluna sumiu'),
        v2: [{ checkId: 'c2', events: [opened(5000), paid('tx2', 5000)], payments: [row('tx2', 5000)] }],
      },
    });
    const r = await reconcileAllVenues(store);
    expect(r.venuesChecked).toBe(2);             // as duas foram olhadas
    expect(r.venuesRed).toBe(1);
    expect(r.worstSeverity).toBe('critical');
    const quebrada = r.venues.find((v) => v.venueId === 'v1');
    expect(quebrada.severity).toBe('critical');  // não-conferível é o pior estado
    const boa = r.venues.find((v) => v.venueId === 'v2');
    expect(boa.severity).toBe('ok');
  });

  test('restaurante de teste fica fora por padrão', async () => {
    const store = fakeStore({
      venues: [venue('v1', 'Real'), venue('vt', 'Sandbox', { isTest: true })],
      checksByVenue: {
        vt: [{ checkId: 'ct', events: [opened(10000), paid('tx', 10000)], payments: [row('tx', 500)] }],
      },
    });
    const r = await reconcileAllVenues(store);
    expect(r.venuesChecked).toBe(1);
    expect(r.venuesRed).toBe(0);
    // Um alerta que dispara toda noite por dado de teste é um alerta que
    // ninguém lê no terceiro dia.
    const comTeste = await reconcileAllVenues(store, { includeTest: true });
    expect(comTeste.venuesChecked).toBe(2);
    expect(comTeste.venuesRed).toBe(1);
  });

  test('a mensagem diz onde doeu, não só que doeu', async () => {
    const store = fakeStore({
      venues: [venue('v1', 'Bar do Zé')],
      checksByVenue: {
        v1: [{ checkId: 'c1', events: [opened(10000), paid('tx1', 10000)], payments: [row('tx1', 9000)] }],
      },
    });
    const msg = formatReconcileAlert(await reconcileAllVenues(store));
    // Um alerta que obriga a abrir o painel pra descobrir onde vira "vejo amanhã".
    expect(msg).toMatch(/drift/);
    expect(msg.split('\n').length).toBeGreaterThan(2);
  });

  test('sem restaurante nenhum, não inventa alerta', async () => {
    const r = await reconcileAllVenues(fakeStore({ venues: [] }));
    expect(r.venuesChecked).toBe(0);
    expect(r.worstSeverity).toBe('ok');
    expect(formatReconcileAlert(r)).toBeNull();
  });
});

describe('reconcileOneVenue — o que o painel mostra', () => {
  test('devolve contagem conferida mesmo quando está tudo certo', async () => {
    const store = fakeStore({
      venues: [venue('v1', 'Bar do Zé')],
      checksByVenue: {
        v1: [
          { checkId: 'c1', events: [opened(5000), paid('t1', 5000)], payments: [row('t1', 5000)] },
          { checkId: 'c2', events: [opened(3000), paid('t2', 3000)], payments: [row('t2', 3000)] },
        ],
      },
    });
    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Bar do Zé' });
    // Sem isso, "não apareceu nada" e "não conferi nada" são a mesma tela.
    expect(r.checksChecked).toBe(2);
    expect(r.severity).toBe('ok');
  });

  test('nunca lança — a falha vira achado', async () => {
    const store = fakeStore({ venues: [], checksByVenue: { v1: new Error('boom') } });
    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Casa' });
    expect(r.severity).toBe('critical');
    expect(r.findings[0].code).toBe('venue_reconcile_threw');
  });
});


describe('a varredura sobre o store de verdade', () => {
  const SECRET = 'reconcile-daily-secret-0123456789';

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
    const venue = store.seedVenue({ name: 'Bar do Zé', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    const table = store.seedTable(venue.id, 'M12');
    return { store, psp, handler, charge, venue, table };
  }

  test('um jantar pago pelo caminho real fecha verde', async () => {
    const { store, psp, handler, charge, table } = await world();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'Picanha', priceCents: 12900 }]);
    const c = await charge({ checkId: check.id, amountCents: 12900, tipCents: 1290, payerLabel: 'Ana' });
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 12900, tipCents: 1290 });
    await handler(wh.rawBody, wh.signature);

    const r = await reconcileAllVenues(store);
    expect(r.venuesChecked).toBe(1);
    expect(r.venuesRed).toBe(0);
    expect(r.totalDriftCents).toBe(0);
    expect(formatReconcileAlert(r)).toBeNull();
  });

  test('meia escrita — evento sem linha de pagamento — vira alerta com o nome da casa', async () => {
    // A permutação que o canário existe pra pegar, montada como acontece de
    // verdade: o append do log passou e o insert da tabela de pagamentos não.
    // Nada de hook de teste no store — só as duas escritas que o webhook faz,
    // com a segunda faltando.
    const { store, table } = await world();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'Picanha', priceCents: 12900 }]);
    await store.appendEvent(check.id, 'PAYMENT_CONFIRMED', {
      txid: 'tx-orfao', amountCents: 12900, tipCents: 0, method: 'pix',
    });

    const r = await reconcileAllVenues(store);
    expect(r.venuesRed).toBe(1);
    const msg = formatReconcileAlert(r);
    expect(msg).toContain('Bar do Zé');
  });
});

describe('evento de dinheiro SEM conta correspondente', () => {
  /**
   * `orphan_money_events` (migração 0024) existe pro evento que não tem onde
   * ser lançado — cobrança de outro ambiente, linha apagada. Guardar sem ler
   * seria perder com passos extras: uma tabela que ninguém olha é onde as
   * coisas vão pra ser esquecidas.
   */
  const { reconcileAllVenues, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');

  const storeCom = (orfaos) => ({
    listVenueActivation: async () => [],
    listChecksForReconcile: async () => [],
    listOpenOrphanMoneyEvents: async () => orfaos,
  });

  test('órfão aberto pinta o relatório de ALTO mesmo com toda casa verde', async () => {
    const r = await reconcileAllVenues(storeCom([
      { id: 1, kind: 'unusable_money_event', txid: 'ch_x', amountCents: 500 },
    ]));
    expect(r.orphanMoneyEvents).toBe(1);
    expect(r.worstSeverity).toBe('high');
    // E o alerta SAI — antes ele só saía com restaurante vermelho.
    const msg = formatReconcileAlert(r);
    expect(msg).toMatch(/SEM conta correspondente/);
    expect(msg).toMatch(/ch_x/);
  });

  test('sem órfão e sem casa vermelha, nada acorda ninguém', async () => {
    const r = await reconcileAllVenues(storeCom([]));
    expect(r.orphanMoneyEvents).toBe(0);
    expect(r.worstSeverity).toBe('ok');
    expect(formatReconcileAlert(r)).toBeNull();
  });

  test('store antigo sem a tabela não quebra a varredura', async () => {
    const r = await reconcileAllVenues({
      listVenueActivation: async () => [],
      listChecksForReconcile: async () => [],
    });
    expect(r.orphanMoneyEvents).toBe(0);
  });
});
