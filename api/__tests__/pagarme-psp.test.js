'use strict';

/**
 * Adapter Pagar.me — contrato idêntico ao mock, verificado com fetch stub.
 * O que está em jogo: split SEMPRE pro recebedor (sem custódia), gorjeta em
 * metadata, webhook NUNCA confia no corpo (re-busca a cobrança na API),
 * recusa de cartão vira 402 (não 500).
 */

const { createPagarmePsp, WebhookVerificationError } = require('../_lib/pay/pagarme-psp');

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    for (const r of routes) {
      if (url.includes(r.match) && (!r.method || r.method === (init && init.method))) {
        return {
          ok: r.status ? r.status < 400 : true,
          status: r.status || 200,
          text: async () => JSON.stringify(r.reply),
        };
      }
    }
    return { ok: false, status: 404, text: async () => '{"message":"route not stubbed"}' };
  };
  return { impl, calls };
}

const PIX_ORDER_REPLY = {
  id: 'or_1', charges: [{
    id: 'ch_pix1', status: 'pending', payment_method: 'pix',
    last_transaction: { qr_code: '00020126pixcode', expires_at: '2026-07-20T12:15:00Z' },
  }],
};

describe('pagarme adapter', () => {
  test('pix: order com split integral, gorjeta em metadata, devolve BR Code', async () => {
    const { impl, calls } = stubFetch([{ match: '/orders', method: 'POST', reply: PIX_ORDER_REPLY }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });

    const r = await psp.createPixCharge({
      chargeRef: 'check1:0:6000:600', amountCents: 6000, tipCents: 600,
      recipientId: 'rp_venue1', description: 'Racha Ana',
    });
    expect(r).toEqual({ txid: 'ch_pix1', copiaECola: '00020126pixcode', expiresAt: '2026-07-20T12:15:00Z' });

    const body = calls[0].body;
    expect(body.items[0].amount).toBe(6600);                       // total = consumo + serviço
    expect(body.metadata.tip_cents).toBe('600');                   // gorjeta separada (Lei 13.419)
    expect(body.split).toEqual([expect.objectContaining({
      recipient_id: 'rp_venue1', amount: 6600, type: 'flat',
    })]);
    expect(body.payments[0].payment_method).toBe('pix');
    expect(calls[0].init.headers.Authorization).toMatch(/^Basic /);
  });

  test('gate de custódia: sem rp_ recusa antes de qualquer chamada', async () => {
    const { impl, calls } = stubFetch([]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });
    await expect(psp.createPixCharge({
      chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: null,
    })).rejects.toThrow(/custódia/);
    await expect(psp.createPixCharge({
      chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'acc_errado',
    })).rejects.toThrow(/custódia/);
    expect(calls).toHaveLength(0);
  });

  test('wallet: card_token no payload; recusa do gateway vira 402', async () => {
    const ok = { id: 'or_2', charges: [{ id: 'ch_card1', status: 'paid', payment_method: 'credit_card' }] };
    const { impl, calls } = stubFetch([{ match: '/orders', method: 'POST', reply: ok }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });

    const r = await psp.createWalletCharge({
      chargeRef: 'check1:0:1000:0', amountCents: 1000, tipCents: 0,
      recipientId: 'rp_venue1', wallet: 'google_pay', paymentToken: 'tok_gpay_123456',
    });
    expect(r).toEqual({ txid: 'ch_card1' });
    expect(calls[0].body.payments[0].credit_card.card_token).toBe('tok_gpay_123456');

    // token curto/lixo → 402 sem bater na API
    await expect(psp.createWalletCharge({
      chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rp_v', wallet: 'google_pay', paymentToken: 'x',
    })).rejects.toMatchObject({ statusCode: 402 });

    // charge failed → 402
    const failed = { id: 'or_3', charges: [{ id: 'ch_f', status: 'failed', payment_method: 'credit_card' }] };
    const s2 = stubFetch([{ match: '/orders', method: 'POST', reply: failed }]);
    const psp2 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s2.impl });
    await expect(psp2.createWalletCharge({
      chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rp_v', wallet: 'apple_pay', paymentToken: 'tok_apple_123456',
    })).rejects.toMatchObject({ statusCode: 402 });
  });

  test('erro do gateway: 4xx vira 402 (recusa), 5xx vira 502', async () => {
    const s4 = stubFetch([{ match: '/orders', method: 'POST', status: 422, reply: { message: 'invalid card' } }]);
    const psp4 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s4.impl });
    await expect(psp4.createPixCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rp_v' }))
      .rejects.toMatchObject({ statusCode: 402 });

    const s5 = stubFetch([{ match: '/orders', method: 'POST', status: 500, reply: { message: 'boom' } }]);
    const psp5 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s5.impl });
    await expect(psp5.createPixCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rp_v' }))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  test('webhook: re-busca a cobrança — corpo mentiroso não passa', async () => {
    const apiCharge = {
      id: 'ch_pix1', status: 'paid', amount: 6600, payment_method: 'pix',
      metadata: { tip_cents: '600' },
    };
    const { impl } = stubFetch([{ match: '/charges/ch_pix1', method: 'GET', reply: apiCharge }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });

    // corpo diz "paid" com valores QUAISQUER — o parse usa a API, não o corpo
    const parsed = await psp.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.paid', data: { id: 'ch_pix1', amount: 999999 } }), {},
    );
    expect(parsed).toMatchObject({
      kind: 'payment_confirmed', txid: 'ch_pix1',
      amountCents: 6000, tipCents: 600, method: 'pix',
    });

    // corpo diz paid, API diz pending → verificação falha alto
    const pending = { ...apiCharge, status: 'pending' };
    const s2 = stubFetch([{ match: '/charges/ch_pix1', method: 'GET', reply: pending }]);
    const psp2 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s2.impl });
    await expect(psp2.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.paid', data: { id: 'ch_pix1' } }), {},
    )).rejects.toThrow(WebhookVerificationError);
  });

  test('webhook: refund mapeado, eventos irrelevantes e basic auth errado rejeitam', async () => {
    const refunded = {
      id: 'ch_card1', status: 'canceled', amount: 1000, payment_method: 'credit_card',
      metadata: { tip_cents: '0' },
    };
    const { impl } = stubFetch([{ match: '/charges/ch_card1', method: 'GET', reply: refunded }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });
    const parsed = await psp.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.refunded', data: { id: 'ch_card1' } }), {},
    );
    expect(parsed).toMatchObject({ kind: 'refund', txid: 'ch_card1', method: 'card' });

    await expect(psp.verifyAndParseWebhook(
      JSON.stringify({ type: 'order.created', data: { id: 'ch_card1' } }), {},
    )).rejects.toThrow(/ignorado/);
    await expect(psp.verifyAndParseWebhook('não é json', {})).rejects.toThrow(/JSON/);

    const pspAuth = createPagarmePsp({ secretKey: 'sk_test_x', webhookBasicAuth: 'racha:senha', fetchImpl: impl });
    await expect(pspAuth.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.paid', data: { id: 'ch_card1' } }),
      { authorization: 'Basic errado' },
    )).rejects.toThrow(/basic auth/);
    const okAuth = await pspAuth.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.refunded', data: { id: 'ch_card1' } }),
      { authorization: `Basic ${Buffer.from('racha:senha').toString('base64')}` },
    );
    expect(okAuth.kind).toBe('refund');
  });

  test('config: secret key sk_ obrigatória', () => {
    expect(() => createPagarmePsp({ secretKey: null })).toThrow(/PAGARME_SECRET_KEY/);
    expect(() => createPagarmePsp({ secretKey: 'pk_publica' })).toThrow(/PAGARME_SECRET_KEY/);
  });
});
