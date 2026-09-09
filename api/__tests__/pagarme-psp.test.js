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
    // A credencial é OBRIGATÓRIA agora. Estes testes rodavam sem ela, o que
    // significa que encodavam o `if (webhookBasicAuth)` que falhava aberto.
    const AUTH = 'racha:senha';
    const HDR = { authorization: `Basic ${Buffer.from(AUTH).toString('base64')}` };
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', webhookBasicAuth: AUTH, fetchImpl: impl });

    // corpo diz "paid" com valores QUAISQUER — o parse usa a API, não o corpo
    const parsed = await psp.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.paid', data: { id: 'ch_pix1', amount: 999999 } }), HDR,
    );
    expect(parsed).toMatchObject({
      kind: 'payment_confirmed', txid: 'ch_pix1',
      amountCents: 6000, tipCents: 600, method: 'pix',
    });

    // corpo diz paid, API diz pending → verificação falha alto
    const pending = { ...apiCharge, status: 'pending' };
    const s2 = stubFetch([{ match: '/charges/ch_pix1', method: 'GET', reply: pending }]);
    const psp2 = createPagarmePsp({ secretKey: 'sk_test_x', webhookBasicAuth: AUTH, fetchImpl: s2.impl });
    await expect(psp2.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.paid', data: { id: 'ch_pix1' } }), HDR,
    )).rejects.toThrow(WebhookVerificationError);
  });

  test('webhook: refund mapeado, evento irrelevante é IGNORADO, auth errado rejeita', async () => {
    const AUTH = 'racha:senha';
    const HDR = { authorization: `Basic ${Buffer.from(AUTH).toString('base64')}` };
    const refunded = {
      id: 'ch_card1', status: 'canceled', amount: 1000, payment_method: 'credit_card',
      metadata: { tip_cents: '0' },
    };
    const { impl } = stubFetch([{ match: '/charges/ch_card1', method: 'GET', reply: refunded }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', webhookBasicAuth: AUTH, fetchImpl: impl });
    const parsed = await psp.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.refunded', data: { id: 'ch_card1' } }), HDR,
    );
    expect(parsed).toMatchObject({ kind: 'refund', txid: 'ch_card1', method: 'card' });

    // Evento irrelevante é IGNORADO, não recusado. Antes era `throw`, que a
    // rota mapeia pra 401 — a Pagar.me reenvia e depois DESABILITA o endpoint,
    // levando um `charge.refunded` de verdade junto. `order.*`,
    // `charge.created` e `charge.antifraud_*` chegam a toda hora.
    expect(await psp.verifyAndParseWebhook(
      JSON.stringify({ type: 'order.created', data: { id: 'ch_card1' } }), HDR,
    )).toMatchObject({ kind: 'ignored', type: 'order.created' });

    await expect(psp.verifyAndParseWebhook('não é json', HDR)).rejects.toThrow(/JSON/);
    await expect(psp.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.paid', data: { id: 'ch_card1' } }),
      { authorization: 'Basic errado' },
    )).rejects.toThrow(/basic auth/);
  });

  test('SEM credencial configurada, nenhum corpo entra', async () => {
    // O buraco que este teste fecha, e ele era explorável em produção.
    //
    // Era `if (webhookBasicAuth) { …confere… }`: com `PAGARME_WEBHOOK_AUTH`
    // ausente — e o router passa `null` por padrão — `/api/webhooks/psp`
    // aceitava corpo NÃO AUTENTICADO. Junto com o ramo de reembolso que não
    // conferia status, um cliente que conhece o `ch_` da própria cobrança (o
    // `/api/pay` devolve o txid na resposta) desquitava a própria conta paga
    // com um POST sem cabeçalho nenhum. Qualquer terceiro que descobrisse um
    // `ch_` fazia o mesmo em qualquer mesa.
    //
    // Os testes antigos rodavam SEM credencial e passavam, então encodavam o
    // buraco. Achado pela revisão de segurança de 2026-09-08.
    const { impl } = stubFetch([{ match: '/charges/ch_x', method: 'GET', reply: { id: 'ch_x', status: 'paid', amount: 1000 } }]);
    const semAuth = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });
    for (const headers of [{}, { authorization: 'Basic qualquer' }, null, undefined]) {
      await expect(semAuth.verifyAndParseWebhook(
        JSON.stringify({ type: 'charge.refunded', data: { id: 'ch_x' } }), headers,
      )).rejects.toThrow(/auth não configurado/);
    }
  });

  test('estorno só sai de uma cobrança que a API diz estornada', async () => {
    const AUTH = 'racha:senha';
    const HDR = { authorization: `Basic ${Buffer.from(AUTH).toString('base64')}` };
    // O ramo de reembolso não conferia NADA: devolvia estorno total pra
    // qualquer cobrança, inclusive uma que a API reporta como `paid`. Era a
    // segunda metade do buraco de autenticação.
    const paga = { id: 'ch_p', status: 'paid', amount: 20000, payment_method: 'pix', metadata: { tip_cents: '0' } };
    const s1 = stubFetch([{ match: '/charges/ch_p', method: 'GET', reply: paga }]);
    const p1 = createPagarmePsp({ secretKey: 'sk_test_x', webhookBasicAuth: AUTH, fetchImpl: s1.impl });
    await expect(p1.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.refunded', data: { id: 'ch_p' } }), HDR,
    )).rejects.toThrow(/mas API diz paid/);

    // Cancelamento PARCIAL não é estorno total. Era: um cancelamento de R$ 5
    // numa cobrança de R$ 200 gravava R$ 200 de estorno, a conta reabria, e a
    // conciliação mostrava R$ 195 de divergência sem explicação. O
    // `validateEvent` não pega, porque o estorno bate com o valor pago.
    const parcial = { ...paga, status: 'partial_canceled' };
    const s2 = stubFetch([{ match: '/charges/ch_p', method: 'GET', reply: parcial }]);
    const p2 = createPagarmePsp({ secretKey: 'sk_test_x', webhookBasicAuth: AUTH, fetchImpl: s2.impl });
    const r = await p2.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.refunded', data: { id: 'ch_p' } }), HDR,
    );
    // Nem estorno nem ignorado: dinheiro saiu e não sabemos quanto.
    expect(r.kind).toBe('unusable_money_event');
    expect(r.status).toBe('partial_canceled');

    // E `charge.partial_canceled` como TIPO de evento também não vira estorno.
    const s3 = stubFetch([{ match: '/charges/ch_p', method: 'GET', reply: parcial }]);
    const p3 = createPagarmePsp({ secretKey: 'sk_test_x', webhookBasicAuth: AUTH, fetchImpl: s3.impl });
    expect(await p3.verifyAndParseWebhook(
      JSON.stringify({ type: 'charge.partial_canceled', data: { id: 'ch_p' } }), HDR,
    )).toMatchObject({ kind: 'ignored' });
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

  /**
   * `overpaid` e `underpaid` são DINHEIRO QUE CHEGOU.
   *
   * O pagador digita o valor no app do banco, e o Pix aceita qualquer número:
   * a Pagar.me tem três status em que a conta da casa foi creditada. A gente
   * tratava um (`paid`), ignorava `underpaid` — a cobrança seguia "pendente"
   * com o dinheiro na conta — e listava `overpaid` em TERMINAL_UNPAID, a lista
   * das cobranças que "nunca vão ser pagas". Nos dois casos a conta ficava
   * aberta, a mesa era cobrada de novo, e a conciliação ficava verde porque as
   * nossas duas contagens concordavam entre si.
   *
   * Achado pela revisão de compliance de 2026-09-08.
   */
  describe('o cliente pagou um valor diferente do pedido', () => {
    const pedido = {
      id: 'ch_x', payment_method: 'pix', amount: 6600, metadata: { tip_cents: '600' },
    };
    const daApi = async (charge) => {
      const { impl } = stubFetch([{ match: '/charges/ch_x', method: 'GET', reply: charge }]);
      return createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl }).getCharge('ch_x');
    };

    test('underpaid: o SERVIÇO é o resíduo — quem paga menos recusa a linha opcional', async () => {
      // Pediu 6600 (6000 de consumo + 600 de serviço), pagou 3300. O consumo
      // vem primeiro: 3300 de comida, zero de gorjeta.
      //
      // A regra proporcional (que esteve aqui) devolvia 3000 + 300 e deixava a
      // conta devendo comida que a casa já tinha recebido — e inflava a base da
      // folha com 300 centavos que o cliente recusou. Ver `allocateUnderpayment`.
      const r = await daApi({ ...pedido, status: 'underpaid', paid_amount: 3300 });
      expect(r.paid).toBe(true);
      expect(r.kind).toBe('payment_confirmed');
      expect(r.amountCents + r.tipCents).toBe(3300);   // exato, sempre
      expect(r.amountCents).toBe(3300);
      expect(r.tipCents).toBe(0);
    });

    test('underpaid por pouco: só o serviço encolhe, o consumo fica inteiro', async () => {
      // Pagou 6300 de 6600: a comida (6000) está paga, o serviço arrecadado é
      // 300 dos 600 cobrados. A conta QUITA.
      const r = await daApi({ ...pedido, status: 'underpaid', paid_amount: 6300 });
      expect(r.amountCents).toBe(6000);
      expect(r.tipCents).toBe(300);
    });

    test('overpaid: o excedente vai pro CONSUMO — a gorjeta não infla sozinha', async () => {
      // Gorjeta é base de folha (Lei 13.419 / STJ Tema 1102): inflar por
      // arredondamento é inventar remuneração que ninguém prometeu.
      const r = await daApi({ ...pedido, status: 'overpaid', paid_amount: 7000 });
      expect(r.paid).toBe(true);
      expect(r.tipCents).toBe(600);                    // o que a conta pediu
      expect(r.amountCents).toBe(6400);                // 6000 + 400 a mais
      expect(r.amountCents + r.tipCents).toBe(7000);
    });

    test('sem paid_amount cai no valor pedido — API antiga não vira zero', async () => {
      const r = await daApi({ ...pedido, status: 'paid' });
      expect(r.amountCents + r.tipCents).toBe(6600);
    });

    test('o webhook dos dois status chega ao razão, com o valor RECEBIDO', async () => {
      for (const status of ['underpaid', 'overpaid']) {
        const { impl } = stubFetch([{
          match: '/charges/ch_x', method: 'GET',
          reply: { ...pedido, status, paid_amount: status === 'underpaid' ? 3300 : 7000 },
        }]);
        const psp = createPagarmePsp({
          secretKey: 'sk_test_x', fetchImpl: impl, webhookBasicAuth: 'u:p',
        });
        const corpo = JSON.stringify({ id: 'hook_1', type: `charge.${status}`, data: { id: 'ch_x' } });
        const r = await psp.verifyAndParseWebhook(corpo, {
          authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
        });
        expect(r.kind).toBe('payment_confirmed');
        expect(r.eventId).toBe('hook_1');
        expect(r.amountCents + r.tipCents).toBe(status === 'underpaid' ? 3300 : 7000);
      }
    });

    test('o webhook mente e a API desmente: `paid` sobre uma cobrança pendente é RECUSA', async () => {
      const { impl } = stubFetch([{
        match: '/charges/ch_x', method: 'GET', reply: { ...pedido, status: 'pending' },
      }]);
      const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl, webhookBasicAuth: 'u:p' });
      const corpo = JSON.stringify({ id: 'hook_2', type: 'charge.paid', data: { id: 'ch_x' } });
      await expect(psp.verifyAndParseWebhook(corpo, {
        authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
      })).rejects.toThrow(WebhookVerificationError);
    });
  });

  describe('estorno de uma cobrança que recebeu valor diferente do pedido', () => {
    /**
     * O TETO do estorno é o que ENTROU.
     *
     * Eu ensinei o `parseCharge` a ler `paid_amount` e deixei o ramo do estorno
     * lendo `charge.amount`. Num Pix `underpaid` o estorno chegava maior que o
     * pagamento: o razão recusava (com razão), a rota devolvia 409, e a
     * Pagar.me reenviava até desabilitar o endpoint — o que derruba TODA
     * confirmação de Pix, não só esta. E os R$ 33,00 já tinham saído da conta
     * da casa com os nossos dois registros dizendo "pago".
     * Achado pela revisão de compliance de 2026-09-08.
     */
    const hook = async (charge) => {
      const { impl } = stubFetch([{ match: '/charges/ch_x', method: 'GET', reply: charge }]);
      const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl, webhookBasicAuth: 'u:p' });
      return psp.verifyAndParseWebhook(
        JSON.stringify({ id: 'hook_r', type: 'charge.refunded', data: { id: 'ch_x' } }),
        { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` },
      );
    };

    test('underpaid: o acumulado estornado é o RECEBIDO, não o pedido', async () => {
      const r = await hook({
        id: 'ch_x', status: 'refunded', payment_method: 'pix',
        amount: 3698, paid_amount: 3300, metadata: { tip_cents: '336' },
      });
      expect(r.kind).toBe('refund');
      expect(r.cumulativeRefundedCents).toBe(3300);   // e não 3698
    });

    test('overpaid: o acumulado inclui o excedente que também precisa voltar', async () => {
      const r = await hook({
        id: 'ch_x', status: 'refunded', payment_method: 'pix',
        amount: 3698, paid_amount: 4000, metadata: { tip_cents: '336' },
      });
      expect(r.cumulativeRefundedCents).toBe(4000);
    });

    test('cancelamento PARCIAL com `canceled_amount` vira estorno normal', async () => {
      // Com o valor na mão deixa de ser "saiu dinheiro e não sabemos quanto".
      const r = await hook({
        id: 'ch_x', status: 'partial_canceled', payment_method: 'pix',
        amount: 3698, paid_amount: 3698, canceled_amount: 500, metadata: { tip_cents: '336' },
      });
      expect(r.kind).toBe('refund');
      expect(r.cumulativeRefundedCents).toBe(500);
    });

    test('cancelamento parcial SEM o valor continua sendo evento não lançável', async () => {
      const r = await hook({
        id: 'ch_x', status: 'partial_canceled', payment_method: 'pix',
        amount: 3698, paid_amount: 3698, metadata: { tip_cents: '336' },
      });
      expect(r.kind).toBe('unusable_money_event');   // anomalia durável + alerta
    });

    test('`canceled_amount` maior que o recebido não é aceito às cegas', async () => {
      const r = await hook({
        id: 'ch_x', status: 'partial_canceled', payment_method: 'pix',
        amount: 3698, paid_amount: 3000, canceled_amount: 3698, metadata: {},
      });
      expect(r.kind).toBe('unusable_money_event');
    });
  });

  test('valor que não é centavo inteiro vira evento NÃO LANÇÁVEL, não dinheiro torto', async () => {
    // Inegociável #5: `parseCharge` afirma centavos nos dois valores da API e
    // afirma que as partes somam o recebido. Mas estourar aqui viraria 500 →
    // reenvio em laço → endpoint desabilitado, o que derruba TODA confirmação
    // de Pix por causa de uma cobrança. É dinheiro que se moveu e não dá pra
    // medir: anomalia durável, que é o que `unusable_money_event` significa.
    const { impl } = stubFetch([{ match: '/charges/ch_x', method: 'GET',
      reply: { id: 'ch_x', status: 'paid', amount: 6600.5, payment_method: 'pix', metadata: {} } }]);
    const r = await createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl }).getCharge('ch_x');
    expect(r.kind).toBe('unusable_money_event');
    expect(r.paid).toBe(false);
  });

  describe('cancelamento parcial visto pela CONCILIAÇÃO', () => {
    /**
     * `partial_canceled` não estava em `PAID_STATUSES` nem em nenhuma lista de
     * terminal, então a cobrança saía da varredura como `stillPending`: sem
     * lançamento, sem anomalia, e depois de 24h fora da janela pra sempre. Os
     * dois registros concordavam que nada aconteceu e o canário ficava verde.
     *
     * E esta é a ÚNICA via quando o webhook não chega — o cenário de um
     * `PAGARME_WEBHOOK_AUTH` com typo, já que a verificação falha fechado.
     * Achado pela revisão de compliance de 2026-09-08.
     */
    const daApi = async (charge) => {
      const { impl } = stubFetch([{ match: '/charges/ch_x', method: 'GET', reply: charge }]);
      return createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl }).getCharge('ch_x');
    };
    const base = {
      id: 'ch_x', status: 'partial_canceled', payment_method: 'pix',
      amount: 3698, paid_amount: 3698, metadata: { tip_cents: '336' },
    };

    test('com `canceled_amount` é estorno mensurável', async () => {
      const r = await daApi({ ...base, canceled_amount: 500 });
      expect(r.kind).toBe('refund');
      expect(r.cumulativeRefundedCents).toBe(500);
      expect(r.paid).toBe(true);        // o dinheiro ENTROU: não é abandono
    });

    test('sem o valor é evento não lançável, nunca `stillPending`', async () => {
      const r = await daApi({ ...base });
      expect(r.kind).toBe('unusable_money_event');
      expect(r.paid).toBe(false);
    });

    test('valor cancelado maior que o recebido não é aceito às cegas', async () => {
      const r = await daApi({ ...base, paid_amount: 3000, canceled_amount: 3698 });
      expect(r.kind).toBe('unusable_money_event');
    });
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

describe('o retrato mascarado guarda o valor que ENTROU', () => {
  /**
   * A lista branca do `mask.js` não tinha `paid_amount`. Numa conta de 36,98
   * em que o cliente digitou 33,00, o registro que existe pra ser consultado
   * quando alguém contesta guardava 36,98 — não incompleto, afirmativamente o
   * número errado, e justo pros estados que esta série acrescentou.
   * Achado pela revisão de segurança de 2026-09-08.
   */
  const { maskPixPayload } = require('../_lib/pay/mask');

  test('`paid_amount` e `canceled_amount` atravessam; o pagador não', () => {
    const m = maskPixPayload({
      id: 'ch_x', status: 'underpaid', amount: 3698, paid_amount: 3300,
      canceled_amount: 500, payment_method: 'pix', created_at: '2026-09-08T12:00:00Z',
      customer: { name: 'Maria da Silva', document: '39053344705' },
      last_transaction: { qr_code: '00020126…' },
    });
    expect(m.paid_amount).toBe(3300);
    expect(m.canceled_amount).toBe(500);
    expect(m.amount).toBe(3698);          // o pedido continua, pra comparação
    expect(JSON.stringify(m)).not.toContain('Maria');
    expect(JSON.stringify(m)).not.toContain('39053344705');
    expect(m.customer).toBeUndefined();   // objeto aninhado nunca entra
    expect(m.last_transaction).toBeUndefined();
  });

  test('a lista é BRANCA: campo novo do PSP não entra de carona', () => {
    const m = maskPixPayload({ id: 'ch_x', campo_inventado_amanha: 'qualquer coisa' });
    expect(m.campo_inventado_amanha).toBeUndefined();
  });
});

/**
 * O MAPEADOR DE RECEBÍVEIS CONTRA FORMA HOSTIL.
 *
 * `centavos()` nasceu pra tirar o `|| 0` — um `amount` ausente virava zero
 * DENTRO da soma que decide `custody_leak` (inegociável #5). Mas a primeira
 * versão era `Number.isSafeInteger(Number(v))`, e `Number()` coage: medido,
 * `null → 0`, `'' → 0`, `false → 0`, `[] → 0`, `'1e3' → 1000`. Só `undefined`,
 * `12.5` e `{}` viravam `null`.
 *
 * Consequência: um `"amount": null` no JSON do adquirente virava um crédito
 * VÁLIDO de 0¢. Passava pelo `Number.isSafeInteger` do módulo puro (logo, não
 * era `payable_shape_invalid`), entrava no bruto da casa e produzia um
 * `payable_amount_mismatch` CRÍTICO falso — "capturou 23710¢ e a casa recebeu
 * 0¢" — justamente na perna cuja única função é decidir custódia. Um crítico
 * falso na primeira noite é como um canário morre na semana um.
 *
 * Este bloco não tinha teste nenhum com forma hostil. Achado pela revisão de
 * segurança de 2026-09-09 (MEDIUM-4).
 */
describe('listChargePayables: número tem que CHEGAR número', () => {
  async function mapear(linhas) {
    const { impl } = stubFetch([{ match: '/payables', method: 'GET', reply: { data: linhas } }]);
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: impl });
    return psp.listChargePayables('ch_1');
  }

  const HOSTIS = [null, '', false, [], '12', '1e3', 12.5, {}, undefined, NaN, Infinity];

  test('nenhuma forma hostil vira centavo — todas viram `null`', async () => {
    for (const v of HOSTIS) {
      const [linha] = await mapear([{ recipient_id: 're_x', type: 'credit', amount: v, fee: 100 }]);
      expect(linha.amountCents).toBe(null);
    }
    // E o inteiro de verdade passa: o guarda não fechou a porta certa.
    const [ok] = await mapear([{ recipient_id: 're_x', type: 'credit', amount: 23710, fee: 100 }]);
    expect(ok.amountCents).toBe(23710);
  });

  test('taxa AUSENTE não vira taxa zero — zero mente sobre o líquido', async () => {
    for (const v of HOSTIS) {
      const [linha] = await mapear([{ recipient_id: 're_x', type: 'credit', amount: 23710, fee: v }]);
      expect(linha.feeCents).toBe(null);
    }
    const [ok] = await mapear([{ recipient_id: 're_x', type: 'credit', amount: 23710, fee: 0 }]);
    expect(ok.feeCents).toBe(0); // taxa zero DECLARADA é legítima
  });

  test('e a forma ilegível sai como ACHADO, não como crédito de 0¢', async () => {
    const { reconcilePayables } = require('../_lib/checks/reconcile-payables');
    const linhas = await mapear([
      { recipient_id: 're_casa', type: 'credit', amount: null, fee: 100 },
    ]);
    const { findings: achados } = reconcilePayables({
      chargeId: 'ch_1', paidAmountCents: 23710, venueRecipientId: 're_casa', payables: linhas,
    });
    // O crítico FALSO de custódia não sai…
    expect(achados.some((f) => f.code === 'payable_amount_mismatch')).toBe(false);
    // …e a linha ilegível é dita, com a severidade de quem pede olhada.
    expect(achados.some((f) => f.code === 'payable_shape_invalid' && f.severity === 'high')).toBe(true);
  });
});

/**
 * CUSTÓDIA SE DECIDE PELO DESTINO — e o destino é legível mesmo sem o valor.
 *
 * A linha de forma inválida saía de `creditos`, então `estranhos` nunca a via,
 * então o `custody_leak` não podia disparar: um crédito de valor ilegível
 * destinado a um recebedor que NÃO é a casa virava `payable_shape_invalid`
 * (`high`) em vez de crítico. É literalmente "um vazamento de verdade
 * reportado como problema de forma" — o modo de falha que eu disse temer ao
 * propor a suspensão da soma, vivo na linha de cima dela.
 *
 * Achado pela revisão de compliance de 2026-09-09 (HIGH-2).
 */
describe('recebível ilegível: o que ainda dá pra afirmar', () => {
  const { reconcilePayables } = require('../_lib/checks/reconcile-payables');
  const CASA = 're_casa';

  const conferir = (payables, paidAmountCents = 23710) =>
    reconcilePayables({ chargeId: 'ch_1', paidAmountCents, venueRecipientId: CASA, payables }).findings;

  test('valor ilegível para um recebedor ESTRANHO segue CRÍTICO', () => {
    const achados = conferir([
      { recipientId: 're_outro', amountCents: null, feeCents: 100, type: 'credit' },
    ]);
    const vaz = achados.find((f) => f.code === 'custody_leak_unreadable');
    expect(vaz).toBeTruthy();
    expect(vaz.severity).toBe('critical');
    expect(vaz.recipientId).toBe('re_outro');   // dá pra nomear pra quem foi
    // E NÃO é rebaixado a problema de forma.
    expect(achados.some((f) => f.code === 'payable_shape_invalid')).toBe(false);
  });

  test('valor ilegível SEM recebedor nomeável é problema de forma — não sei pra quem', () => {
    const achados = conferir([
      { recipientId: null, amountCents: null, feeCents: 100, type: 'credit' },
    ]);
    expect(achados.some((f) => f.code === 'payable_shape_invalid' && f.severity === 'high')).toBe(true);
    expect(achados.some((f) => f.code === 'custody_leak_unreadable')).toBe(false);
  });

  test('valor ilegível da PRÓPRIA casa é forma, não vazamento', () => {
    const achados = conferir([
      { recipientId: CASA, amountCents: null, feeCents: 100, type: 'credit' },
    ]);
    expect(achados.some((f) => f.code === 'payable_shape_invalid')).toBe(true);
    expect(achados.some((f) => f.code === 'custody_leak_unreadable')).toBe(false);
    // E a soma fica SUSPENSA: não poder ler não é "o dinheiro sumiu".
    expect(achados.some((f) => f.code === 'payable_amount_mismatch')).toBe(false);
  });

  test('um ESTORNO sem taxa não cega a conferência de uma cobrança sadia', () => {
    // A taxa só é exigida de quem entra na soma. Antes, um `refund` sem `fee`
    // virava `high` E suspendia a comparação de uma cobrança cujos créditos
    // liam perfeitamente — barulhenta e cega ao mesmo tempo.
    const achados = conferir([
      { recipientId: CASA, amountCents: 23710, feeCents: 300, type: 'credit' },
      { recipientId: CASA, amountCents: -1000, feeCents: null, type: 'refund' },
    ]);
    expect(achados.some((f) => f.code === 'payable_shape_invalid')).toBe(false);
    // A soma dos créditos bate, então nada de mismatch.
    expect(achados.some((f) => f.code === 'payable_amount_mismatch')).toBe(false);
  });

  test('e o vazamento LEGÍVEL de sempre continua crítico', () => {
    const achados = conferir([
      { recipientId: 're_outro', amountCents: 23710, feeCents: 300, type: 'credit' },
    ]);
    expect(achados.some((f) => f.code === 'custody_leak' && f.severity === 'critical')).toBe(true);
  });
});
