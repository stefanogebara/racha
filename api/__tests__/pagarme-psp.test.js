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
      // A moeda passou a ser OBRIGATÓRIA: sem padrão, um chamador que esquece
      // quebra em vez de herdar a única moeda que este adquirente atende.
      currency: 'brl',
    });
    expect(r).toEqual({ txid: 'ch_card1' });
    expect(calls[0].body.payments[0].credit_card.card_token).toBe('tok_gpay_123456');

    // token curto/lixo → 402 sem bater na API
    await expect(psp.createWalletCharge({
      chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rp_v', wallet: 'google_pay', paymentToken: 'x', currency: 'brl',
    })).rejects.toMatchObject({ statusCode: 402 });

    // charge failed → 402
    const failed = { id: 'or_3', charges: [{ id: 'ch_f', status: 'failed', payment_method: 'credit_card' }] };
    const s2 = stubFetch([{ match: '/orders', method: 'POST', reply: failed }]);
    const psp2 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s2.impl });
    await expect(psp2.createWalletCharge({
      chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rp_v', wallet: 'apple_pay', paymentToken: 'tok_apple_123456', currency: 'brl',
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

  test('createRecipient: payload correto (PJ por 14 dígitos, banco mapeado, repasse diário) e re_ de volta', async () => {
    // Pagar.me devolve o recebedor com prefixo re_ (confirmado na API 21/07) —
    // assumir rp_ rejeitava a resposta VÁLIDA (o bug que travou o aceite de split).
    const reply = { id: 're_cmrv0eg8u00v3', status: 'active' };
    const { impl, calls } = stubFetch([{ match: '/recipients', method: 'POST', reply }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });

    const r = await psp.createRecipient({
      name: '65.087.663 Stefano Chap Chap Gebara',
      email: 'x@y.com',
      document: '65.087.663/0001-30', // com máscara — adapter limpa
      bank: { code: '260', agencia: '0001', conta: '00544596', contaDv: '6' },
    });
    expect(r).toEqual({ recipientId: 're_cmrv0eg8u00v3', status: 'active' });

    const body = calls[0].body;
    expect(body.document).toBe('65087663000130');
    expect(body.type).toBe('company'); // 14 dígitos = PJ, automático
    expect(body.default_bank_account).toMatchObject({
      holder_document: '65087663000130', holder_type: 'company',
      bank: '260', branch_number: '0001', account_number: '00544596',
      account_check_digit: '6', type: 'checking',
    });
    expect(body.transfer_settings).toMatchObject({ transfer_enabled: true, transfer_interval: 'Daily' });

    await expect(psp.createRecipient({ name: 'x', document: null, bank: null }))
      .rejects.toThrow(/obrigatórios/);
  });

  test('getRecipient: status da análise (id real re_); id inválido → null sem chamada', async () => {
    const { impl, calls } = stubFetch([{ match: '/recipients/re_a', method: 'GET', reply: { id: 're_a', status: 'active', name: 'Bar' } }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });
    expect(await psp.getRecipient('re_a')).toEqual({ recipientId: 're_a', status: 'active', name: 'Bar' });
    expect(await psp.getRecipient('rcpt_demo')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('getRecipientBalance: centavos da API (prova do repasse); id inválido → null sem chamada', async () => {
    const reply = { currency: 'BRL', available_amount: 21000, waiting_funds_amount: 1000, transferred_amount: 500 };
    const { impl, calls } = stubFetch([{ match: '/recipients/re_a/balance', method: 'GET', reply }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });
    expect(await psp.getRecipientBalance('re_a')).toEqual({
      currency: 'BRL', availableCents: 21000, waitingCents: 1000, transferredCents: 500,
    });
    expect(await psp.getRecipientBalance('rcpt_demo')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/recipients\/re_a\/balance$/);
  });

  test('no-split de TESTE: só com flag E sk_test_; sk_live_ ignora o flag (custódia absoluta)', async () => {
    // flag + sk_test_ + sem rp_ → ordem SEM split, marcada no metadata
    const { impl, calls } = stubFetch([{ match: '/orders', method: 'POST', reply: PIX_ORDER_REPLY }]);
    const pspTest = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl, allowNoSplitInTest: true });
    await pspTest.createPixCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rcpt_demo' });
    expect(calls[0].body.split).toBeUndefined();
    expect(calls[0].body.metadata.split_mode).toBe('none_test');

    // com rp_ presente, o split volta mesmo com o flag ligado
    const s2 = stubFetch([{ match: '/orders', method: 'POST', reply: PIX_ORDER_REPLY }]);
    const pspRp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s2.impl, allowNoSplitInTest: true });
    await pspRp.createPixCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rp_venue1' });
    expect(s2.calls[0].body.split).toHaveLength(1);
    expect(s2.calls[0].body.metadata.split_mode).toBeUndefined();

    // sk_live_ + flag → custódia continua recusando (o flag é ignorado)
    const s3 = stubFetch([]);
    const pspLive = createPagarmePsp({ secretKey: 'sk_live_x', fetchImpl: s3.impl, allowNoSplitInTest: true });
    await expect(pspLive.createPixCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'rcpt_demo' }))
      .rejects.toThrow(/custódia/);
    expect(s3.calls).toHaveLength(0);
  });

  test('getCharge: paga → paid:true (valores da API); pendente → paid:false', async () => {
    const paid = { id: 'ch_x', status: 'paid', amount: 6600, payment_method: 'pix', metadata: { tip_cents: '600' } };
    const p1 = stubFetch([{ match: '/charges/ch_x', method: 'GET', reply: paid }]);
    const psp1 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: p1.impl });
    expect(await psp1.getCharge('ch_x')).toMatchObject({
      txid: 'ch_x', status: 'paid', paid: true, kind: 'payment_confirmed',
      amountCents: 6000, tipCents: 600, method: 'pix',
    });

    const pending = { id: 'ch_x', status: 'pending', amount: 5000, payment_method: 'pix', metadata: {} };
    const p2 = stubFetch([{ match: '/charges/ch_x', method: 'GET', reply: pending }]);
    const psp2 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: p2.impl });
    expect(await psp2.getCharge('ch_x')).toMatchObject({ paid: false, status: 'pending' });
  });

  test('getCharge: id fora do padrão ch_ → null sem chamar a API', async () => {
    const { impl, calls } = stubFetch([]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });
    expect(await psp.getCharge('mock123')).toBeNull();
    expect(await psp.getCharge(null)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('getCharge: 404 → null; 401/5xx RELANÇAM (a rede de segurança não morre calada)', async () => {
    // 404 (fallback do stub) = cobrança inexistente → pula
    const psp404 = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: stubFetch([]).impl });
    expect(await psp404.getCharge('ch_gone')).toBeNull();

    // 401 (chave revogada) NÃO pode virar "desconhecida" — relança pro cron alertar
    const s401 = stubFetch([{ match: '/charges/ch_x', method: 'GET', status: 401, reply: { message: 'unauthorized' } }]);
    await expect(createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s401.impl }).getCharge('ch_x')).rejects.toThrow();

    const s500 = stubFetch([{ match: '/charges/ch_x', method: 'GET', status: 500, reply: { message: 'boom' } }]);
    await expect(createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: s500.impl }).getCharge('ch_x')).rejects.toThrow();
  });
});
