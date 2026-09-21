'use strict';

/**
 * Apple Pay / Google Pay — cobrança de cartão tokenizada pelo MESMO portão de
 * dinheiro do Pix. O que está em jogo: gates iguais, decline alto e claro,
 * método real no ledger ('card', nunca 'pix' mentiroso), gorjeta rastreada.
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');
const { reduce } = require('../_lib/checks/check-state');

const SECRET = 'wallet-webhook-secret-0123456789';

function setup() {
  const store = createMemoryStore();
  const psp = new MockPsp({ webhookSecret: SECRET });
  const charge = createChargeService({ store, psp });
  const webhook = createWebhookHandler({
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    psp,
  });
  const venue = store.seedVenue({ name: 'Bar Wallet', servicoBp: 1000, pspRecipientId: 'rcpt_w' });
  const table = store.seedTable(venue.id, 'Mesa 1');
  return { store, psp, charge, webhook, venue, table };
}

describe('wallet charges (Apple Pay / Google Pay)', () => {
  test('full loop: charge → webhook → ledger says card, tips ride, panel counts', async () => {
    const { store, psp, charge, webhook, venue, table } = setup();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 10000 }]);

    const c = await charge({
      checkId: check.id, amountCents: 6000, tipCents: 600, payerLabel: 'Apple Cliente',
      wallet: 'apple_pay', paymentToken: 'tok_demo_abcdef123456',
    });
    expect(c.method).toBe('card');
    expect(c.wallet).toBe('apple_pay');
    expect(c.copiaECola).toBeNull(); // carteira não tem BR Code

    const row0 = await store.getPayment(c.txid);
    expect(row0.method).toBe('card');
    expect(row0.status).toBe('pendente');

    const wh = psp.buildConfirmationWebhook({
      txid: c.txid, amountCents: 6000, tipCents: 600, method: 'card',
      payerName: 'Fulano Cartão da Silva', payerCpf: '390.533.447-05',
    });
    expect((await webhook(wh.rawBody, wh.signature)).status).toBe('appended');
    expect((await webhook(wh.rawBody, wh.signature)).status).toBe('duplicate'); // at-least-once

    const state = reduce(await store.loadEvents(check.id));
    expect(state.paidCents).toBe(6000);
    expect(state.tipCents).toBe(600); // Lei 13.419: gorjeta separada, também no cartão
    const seq = (await store.loadEvents(check.id)).find((e) => e.type === 'PAYMENT_CONFIRMED');
    expect(seq.payload.method).toBe('card'); // método REAL, não 'pix' hardcoded

    const row = await store.getPayment(c.txid);
    expect(row.status).toBe('confirmado');
    // LGPD: sobrenome e CPF completos nunca sobrevivem (o mask guarda só um
    // hint truncado — mesma convenção do pay-layer.test).
    expect(JSON.stringify(row.pspPayloadMasked)).not.toMatch(/Silva|390\.533/);

    const panel = await store.getPanelView(venue.id);
    expect(panel.today.confirmedCents).toBe(6000);
    expect(panel.today.tipsCents).toBe(600);
  });

  /**
   * DUAS COISAS DIFERENTES, e a versão anterior deste teste juntava as duas.
   *
   * Token MALFORMADO é recusa NOSSA, e ela passou a acontecer no portão —
   * antes da vaga de cobrança e antes de o adquirente ver qualquer coisa. Isso
   * importa porque um 4xx do adquirente conta na saúde da casa: qualquer campo
   * que o cliente controla e que provoque 4xx era caminho pra paginar o
   * fundador sobre um restaurante são (re-revisão de segurança, 2026-09-21).
   *
   * Token BEM FORMADO que o emissor recusa é 402, e continua sendo.
   */
  test('token malformado para no NOSSO portão, sem chegar no adquirente', async () => {
    const { store, charge, table } = setup();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 5000 }]);
    /**
     * O QUE O NOSSO PORTÃO AFIRMA, e só isso: é string, tem tamanho de gente,
     * e não carrega controle. O CHARSET é do Google — em `PAYMENT_GATEWAY` o
     * token é um envelope JSON de 1 a 3 KB, e a versão anterior deste portão
     * exigia `[A-Za-z0-9_-]`, o que recusaria TODO token real.
     */
    const comControle = `tok_abc${String.fromCharCode(10)}def`;
    for (const ruim of ['garbage', null, 'x', 7, comControle, 'a'.repeat(9000)]) {
      await expect(charge({
        checkId: check.id, amountCents: 1000, wallet: 'google_pay', paymentToken: ruim,
      })).rejects.toMatchObject({ statusCode: 400, code: 'card_token_invalid' });
    }
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0);
  });

  test('token BEM FORMADO que o emissor recusa segue 402, nada registrado', async () => {
    const { store, charge, table } = setup();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 5000 }]);
    // Passa no nosso portão e é recusado pelo mock (não é `tok_…`).
    await expect(charge({
      checkId: check.id, amountCents: 1000, wallet: 'google_pay', paymentToken: 'recusado1234',
    })).rejects.toMatchObject({ statusCode: 402 });

    /**
     * E O ENVELOPE DE VERDADE ATRAVESSA O NOSSO PORTÃO.
     *
     * É a asserção que faltava: sem ela, o portão podia recusar todo token do
     * Google Pay e a suíte ficava verde, porque as fixtures usavam a forma do
     * demo (`tok_…`). No dia do primeiro id em `RACHA_WALLET_VENUES`, botão
     * morto.
     */
    const envelope = JSON.stringify({
      signature: `MEUCIQ${'A'.repeat(90)}`,
      protocolVersion: 'ECv2',
      signedMessage: JSON.stringify({ encryptedMessage: 'b'.repeat(1200) }),
    });
    expect(envelope.length).toBeGreaterThan(1000);
    await expect(charge({
      checkId: check.id, amountCents: 1000, wallet: 'google_pay', paymentToken: envelope,
    })).rejects.toMatchObject({ statusCode: 402 });   // recusa do MOCK, não nossa

    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(0);
  });

  test('mesmos gates do Pix: carteira desconhecida, sem recipient, acima do restante, conta fechada', async () => {
    const { store, charge, table } = setup();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 5000 }]);

    await expect(charge({ checkId: check.id, amountCents: 100, wallet: 'samsung_pay', paymentToken: 'tok_demo_x12345678' }))
      .rejects.toThrow(/carteira desconhecida/);
    await expect(charge({ checkId: check.id, amountCents: 5001, wallet: 'apple_pay', paymentToken: 'tok_demo_x12345678' }))
      .rejects.toThrow(/exceeds remaining/);

    const bare = store.seedVenue({ name: 'SemRcpt', servicoBp: 1000, pspRecipientId: null });
    const bareTable = store.seedTable(bare.id, 'Mesa 1');
    const bareCheck = await store.openCheck(bareTable.qrToken, [{ id: 'x', name: 'X', priceCents: 500 }]);
    await expect(charge({ checkId: bareCheck.id, amountCents: 100, wallet: 'apple_pay', paymentToken: 'tok_demo_x12345678' }))
      .rejects.toThrow(/settlement recipient/);

    await store.appendEvent(check.id, 'CLOSED', {});
    await expect(charge({ checkId: check.id, amountCents: 100, wallet: 'apple_pay', paymentToken: 'tok_demo_x12345678' }))
      .rejects.toThrow(/closed/);
  });

  test('webhook sem method continua pix (retrocompatível)', async () => {
    const { store, psp, charge, webhook, table } = setup();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 5000 }]);
    const c = await charge({ checkId: check.id, amountCents: 2000 }); // Pix
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 2000, tipCents: 0 });
    await webhook(wh.rawBody, wh.signature);
    const evt = (await store.loadEvents(check.id)).find((e) => e.type === 'PAYMENT_CONFIRMED');
    expect(evt.payload.method).toBe('pix');
  });
});
