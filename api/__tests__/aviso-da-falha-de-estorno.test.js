'use strict';

/**
 * UMA FALHA, UM AVISO.
 *
 * A Stripe entrega a MESMA falha de estorno em dois eventos — `refund.failed` e
 * `refund.updated` com status `failed`, `evt_` diferentes, mesmo `re_`. A rota
 * avisava o fundador nos DOIS: duas linhas idênticas no canal que também carrega
 * o canário da conciliação (inegociável #8), em toda falha de estorno, por
 * comportamento normal do adquirente. Canário que se repete é canário que se
 * aprende a ignorar (segurança LOW-2 de 53c9ff0).
 *
 * O teste vai pela ROTA, porque é lá que a decisão mora: o tratador já devolvia
 * `duplicate` na segunda entrega, e era a rota que avisava assim mesmo.
 */

const http = require('node:http');
const Stripe = require('stripe');

describe('a segunda entrega da mesma falha não repagina o fundador', () => {
  let srv; let porta; let store; let linhas;

  beforeAll(async () => {
    const antes = {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      RACHA_NOTIFY_SECRET: process.env.RACHA_NOTIFY_SECRET,
    };
    process.env.STRIPE_SECRET_KEY = 'sk_test_naoexiste';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_teste';
    // SEM o segredo da ponte o aviso sai no stderr em vez de na rede — e é
    // exatamente ele que dá pra contar sem falsear a ponte.
    delete process.env.RACHA_NOTIFY_SECRET;
    let route;
    jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv && srv.close());

  beforeEach(() => {
    linhas = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((s) => { linhas.push(String(s)); return true; });
  });
  afterEach(() => jest.restoreAllMocks());

  const entregar = async (evento) => {
    const corpo = JSON.stringify(evento);
    const assinatura = Stripe.webhooks.generateTestHeaderString({ payload: corpo, secret: 'whsec_teste' });
    const r = await fetch(`http://127.0.0.1:${porta}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': assinatura },
      body: corpo,
    });
    return { status: r.status, body: await r.json() };
  };

  const falha = (id, re) => ({
    id, type: 'refund.failed', livemode: false,
    data: { object: { id: re, object: 'refund', payment_intent: 'pi_aviso', amount: 1100, status: 'failed' } },
  });

  const avisos = () => linhas.filter((l) => /MONEY EVENT ALERT/.test(l) || /refund_failed txid=/.test(l));

  test('duas entregas da mesma falha, um aviso só', async () => {
    const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
    const venue = await store.seedVenue({ name: 'Aviso', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
    const mesa = await store.seedTable(venue.id, 'Mesa 1');
    const conta = await store.openCheck(mesa.qrToken, [{ id: 'i', name: 'Prato', priceCents: 3000 }]);
    await store.registerCharge({
      checkId: conta.id, txid: 'pi_aviso', amountCents: 3000, tipCents: 300, payerLabel: null, method: 'card',
    });
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_aviso', amountCents: 3000, tipCents: 300, method: 'card', eventId: 'evt_pago',
    }, deps);
    await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_aviso', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_estorno',
    }, deps);

    linhas = [];
    const primeira = await entregar(falha('evt_falha_1', 're_aviso'));
    expect(primeira.status).toBe(200);
    expect(primeira.body.data.status).toBe('appended');
    const depoisDaPrimeira = avisos().length;
    // A falha PAGINA. Se este número for zero o teste abaixo não prova nada.
    expect(depoisDaPrimeira).toBe(1);

    const segunda = await entregar(falha('evt_falha_2', 're_aviso'));
    expect(segunda.status).toBe(200);
    expect(segunda.body.data.status).toBe('duplicate');
    expect(avisos().length).toBe(depoisDaPrimeira);
  });
});
