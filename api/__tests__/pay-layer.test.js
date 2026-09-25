'use strict';

/**
 * Pay layer: LGPD masking (allowlist), webhook signature verification
 * (timing-safe, no dev bypass), idempotency + divergence tracing, refunds,
 * and the charge-creation compliance gates.
 */

const { maskPixPayload, maskName, maskTaxId } = require('../_lib/pay/mask');
const { MockPsp, WebhookVerificationError } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce, STATUS } = require('../_lib/checks/check-state');

const SECRET = 'test-webhook-secret-0123456789';

function freshWorld() {
  const store = createMemoryStore();
  const psp = new MockPsp({ webhookSecret: SECRET });
  const venue = store.seedVenue({ name: 'Boteco Teste', servicoBp: 1000 });
  const table = store.seedTable(venue.id, 'Mesa 4');
  const handler = createWebhookHandler({
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    psp,
  });
  const charge = createChargeService({ store, psp });
  return { store, psp, venue, table, handler, charge };
}

async function openDemoCheck(store, table, priceCents = 12000) {
  // Item NUNCA negativo: com `priceCents` < 2000 isto fazia um item de valor
  // negativo, que o serviço recusa na entrada e o razão recusa desde que o
  // `OPENED` leva os itens (0039). O dado de teste era inválido.
  const chopp = Math.min(2000, Math.floor(priceCents / 2));
  return store.openCheck(table.qrToken, [
    { id: 'i1', name: 'Picanha', priceCents: priceCents - chopp },
    { id: 'i2', name: 'Chopp', priceCents: chopp },
  ]);
}

describe('maskPixPayload — allowlist, never raw', () => {
  test('keeps reconciliation fields, masks payer identity', () => {
    const masked = maskPixPayload({
      txid: 'abc123', amount: 5000, status: 'CONCLUIDA',
      pagador: { nome: 'Maria da Silva Sauro', cpf: '123.456.789-09', agencia: '0001', conta: '12345-6' },
      infoAdicional: 'campo livre com PII',
    });
    expect(masked.txid).toBe('abc123');
    expect(masked.amount).toBe(5000);
    // NADA do pagador entra. Nem mascarado: `payer_hint` guardava o primeiro
    // nome inteiro e `payer_doc_hint` os dois últimos dígitos do CPF, e
    // pseudonimizado continua sendo dado pessoal (art. 12). Ninguém lia os dois.
    expect(masked.payer_hint).toBeUndefined();
    expect(masked.payer_doc_hint).toBeUndefined();
    // A asserção que importa é a NEGATIVA e ela é sobre o objeto INTEIRO: um
    // campo novo de pagador, com qualquer nome, cai aqui.
    expect(Object.keys(masked).sort()).toEqual(['amount', 'status', 'txid']);
    expect(JSON.stringify(masked)).not.toMatch(/Maria|Silva|456\.789|agencia|conta|infoAdicional/);
  });

  test('weird shapes never throw and never leak nested objects', () => {
    expect(maskPixPayload(null)).toEqual({});
    expect(maskPixPayload({ txid: 'x', nested: { cpf: '111' } })).toEqual({ txid: 'x' });
  });

  test('maskName / maskTaxId degenerate inputs', () => {
    expect(maskName('Ana')).toBe('Ana');
    expect(maskTaxId('12')).toBe('***');
  });
});

describe('MockPsp webhook verification — no unsigned path exists', () => {
  test('valid signature roundtrip', () => {
    const psp = new MockPsp({ webhookSecret: SECRET });
    const { rawBody, signature } = psp.buildConfirmationWebhook({ txid: 't1', amountCents: 100 });
    const parsed = psp.verifyAndParseWebhook(rawBody, signature);
    expect(parsed).toMatchObject({ kind: 'payment_confirmed', txid: 't1', amountCents: 100, tipCents: 0 });
  });

  test('tampered body rejected', () => {
    const psp = new MockPsp({ webhookSecret: SECRET });
    const { rawBody, signature } = psp.buildConfirmationWebhook({ txid: 't1', amountCents: 100 });
    expect(() => psp.verifyAndParseWebhook(rawBody.replace('100', '900'), signature))
      .toThrow(WebhookVerificationError);
  });

  test('missing/malformed signature rejected before parsing', () => {
    const psp = new MockPsp({ webhookSecret: SECRET });
    expect(() => psp.verifyAndParseWebhook('{}', undefined)).toThrow(/signature/);
    expect(() => psp.verifyAndParseWebhook('{}', 'zz')).toThrow(/signature/);
  });

  test('constructor refuses weak/absent secret (no dev bypass)', () => {
    expect(() => new MockPsp({ webhookSecret: '' })).toThrow(/webhookSecret/);
    expect(() => new MockPsp({ webhookSecret: 'short' })).toThrow(/webhookSecret/);
  });
});

describe('webhook handler — money events land exactly once', () => {
  test('charge → confirmation webhook → state PAGA, payment row masked', async () => {
    const { store, psp, table, handler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 10000, tipCents: 1000, payerLabel: 'Ana' });

    const wh = psp.buildConfirmationWebhook({
      txid: c.txid, amountCents: 10000, tipCents: 1000,
      payerName: 'Ana Beatriz Souza', payerCpf: '390.533.447-05',
    });
    const res = await handler(wh.rawBody, wh.signature);
    expect(res.status).toBe('appended');

    const state = reduce(await store.loadEvents(check.id));
    expect(state.status).toBe(STATUS.PAGA);
    expect(state.tipCents).toBe(1000);

    const row = await store.getPayment(c.txid);
    expect(row.status).toBe('confirmado');
    expect(JSON.stringify(row.pspPayloadMasked)).not.toMatch(/Souza|390\.533/);
  });

  test('replayed webhook (at-least-once) is a duplicate no-op', async () => {
    const { store, psp, table, handler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 10000 });
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 10000 });
    expect((await handler(wh.rawBody, wh.signature)).status).toBe('appended');
    expect((await handler(wh.rawBody, wh.signature)).status).toBe('duplicate');
    expect(await store.loadEvents(check.id)).toHaveLength(2); // OPENED + 1 payment
  });

  test('divergent replay (same txid, different money) leaves a durable trace', async () => {
    const { store, psp, table, handler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 6000 });
    const ok = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 6000 });
    await handler(ok.rawBody, ok.signature);
    const bad = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 9000 });
    const res = await handler(bad.rawBody, bad.signature);
    expect(res.status).toBe('divergent_appended');
    const state = reduce(await store.loadEvents(check.id));
    expect(state.paidCents).toBe(6000); // original stands
    expect(state.anomalies).toHaveLength(1);
    expect(state.anomalies[0].reason).toMatch(/different amounts/);
  });

  test('refund webhook reduces paid; over-refund is rejected loudly', async () => {
    const { store, psp, table, handler, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    const c = await charge({ checkId: check.id, amountCents: 10000, tipCents: 500 });
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 10000, tipCents: 500 });
    await handler(wh.rawBody, wh.signature);

    const refund = psp.buildRefundWebhook({ txid: c.txid, amountCents: 4000 });
    expect((await handler(refund.rawBody, refund.signature)).status).toBe('appended');
    let state = reduce(await store.loadEvents(check.id));
    expect(state.paidCents).toBe(6000);
    expect(state.status).toBe(STATUS.PARCIAL);

    const tooMuch = psp.buildRefundWebhook({ txid: c.txid, amountCents: 7000 });
    const res = await handler(tooMuch.rawBody, tooMuch.signature);
    expect(res.status).toBe('rejected');
    expect(res.reason).toMatch(/exceeds/);
    state = reduce(await store.loadEvents(check.id));
    expect(state.paidCents).toBe(6000); // untouched
  });

  /**
   * UM TXID QUE NUNCA EMITIMOS — e a resposta depende de ter MOVIDO DINHEIRO.
   *
   * A intenção original deste teste era "não engolir com 200", e ela continua
   * valendo: nada aqui volta 200 sem deixar registro. O que mudou é que um 409
   * TAMBÉM não deixa registro — o adquirente reenvia, desiste, e a notícia some.
   * Quando o evento diz que dinheiro FOI PAGO, o desfecho passa a ser
   * `money_without_check`, que grava em `orphan_money_events` e só então
   * responde 200. É o caso do cartão capturado cuja linha de `payments` não foi
   * escrita (compliance HIGH-1 de 2026-09-16).
   */
  test('um txid desconhecido que MOVEU dinheiro vira órfão registrável, não um 409 que some', async () => {
    const { psp, handler } = freshWorld();
    const wh = psp.buildConfirmationWebhook({ txid: 'ghost', amountCents: 100 });
    const res = await handler(wh.rawBody, wh.signature);
    expect(res.status).toBe('money_without_check');
    // O valor viaja: um alerta que diz "sumiu dinheiro" sem dizer quanto não
    // serve pra nada.
    expect(res.raw.amountCents).toBe(100);
    expect(res.txid).toBe('ghost');
    // E o desfecho está na família que a rota grava antes de responder 200.
    const { NON_LEDGER_KINDS } = require('../_lib/pay/webhook-handler');
    expect(NON_LEDGER_KINDS.has(res.status)).toBe(true);
  });

  // A OUTRA METADE — "um txid desconhecido que NÃO moveu dinheiro segue
  // recusado" — mora no `webhook-kinds.test.js`, que percorre a matriz de
  // espécies com um portão instrumentado. O dublê deste arquivo só sabe montar
  // confirmação, então um teste aqui teria que inventar o evento, e um evento
  // inventado é a forma que já enganou o `login-indisponivel` três vezes.

  test('bad signature never reaches the store', async () => {
    const { psp, handler, store, table } = freshWorld();
    await openDemoCheck(store, table);
    const wh = psp.buildConfirmationWebhook({ txid: 'x', amountCents: 100 });
    await expect(handler(wh.rawBody, 'a'.repeat(64))).rejects.toThrow(WebhookVerificationError);
  });
});

describe('createCharge — the money-out gates', () => {
  test('refuses venue without settlement recipient (custody perimeter)', async () => {
    const { store, psp, table } = freshWorld();
    const check = await openDemoCheck(store, table);
    const venue = await store.getVenueForCheck(check.id);
    venue.pspRecipientId = null;
    const charge = createChargeService({ store, psp });
    await expect(charge({ checkId: check.id, amountCents: 100 }))
      .rejects.toThrow(/settlement recipient/);
  });

  test('refuses consumption above remaining; tips are unconstrained by remaining', async () => {
    const { store, table, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 10000);
    await expect(charge({ checkId: check.id, amountCents: 10001 })).rejects.toThrow(/exceeds remaining/);
    const tipOnly = await charge({ checkId: check.id, amountCents: 0, tipCents: 800 });
    expect(tipOnly.txid).toBeTruthy();
  });

  test('refuses zero-value, closed checks, oversized payer labels', async () => {
    const { store, table, handler, psp, charge } = freshWorld();
    const check = await openDemoCheck(store, table, 1000);
    await expect(charge({ checkId: check.id, amountCents: 0, tipCents: 0 })).rejects.toThrow(/zero-value/);
    await expect(charge({ checkId: check.id, amountCents: 100, payerLabel: 'x'.repeat(61) }))
      .rejects.toThrow(/60 chars/);
    const c = await charge({ checkId: check.id, amountCents: 1000 });
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 1000 });
    await handler(wh.rawBody, wh.signature);
    await store.appendEvent(check.id, 'CLOSED', {});
    await expect(charge({ checkId: check.id, amountCents: 1 })).rejects.toThrow(/closed/);
  });
});
