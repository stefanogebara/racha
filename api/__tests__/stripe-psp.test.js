'use strict';

/**
 * Adapter Stripe (2º rail — cartão/Apple Pay via Connect). Contrato idêntico ao
 * mock/pagarme (pro reconciliador + webhook-handler), verificado com um cliente
 * Stripe stubado. O que está em jogo: DESTINATION CHARGE sempre pra conta
 * conectada do restaurante (sem custódia), gorjeta em metadata, e webhook que
 * NUNCA confia sem assinatura válida (constructEvent).
 */

const { createStripePsp, WebhookVerificationError } = require('../_lib/pay/stripe-psp');

function stubStripe(overrides = {}) {
  const calls = { create: [], retrieve: [], constructEvent: [], accounts: [] };
  return {
    calls,
    paymentIntents: {
      create: async (params) => {
        calls.create.push(params);
        return {
          id: 'pi_test1', client_secret: 'pi_test1_secret_abc',
          status: 'requires_payment_method', amount: params.amount,
          currency: params.currency, metadata: params.metadata,
          ...(overrides.createPI || {}),
        };
      },
      retrieve: async (id) => {
        calls.retrieve.push(id);
        if (overrides.retrieveError) throw overrides.retrieveError;
        return overrides.retrievePI || { id, status: 'succeeded', amount: 8800, metadata: { tip_cents: '800' } };
      },
    },
    webhooks: {
      constructEvent: (raw, sig, secret) => {
        calls.constructEvent.push({ raw, sig, secret });
        if (overrides.constructThrows) throw new Error('No signatures found matching the expected signature');
        return overrides.event;
      },
    },
    accounts: {
      create: async (params) => { calls.accounts.push(params); return { id: 'acct_test1', charges_enabled: false, ...(overrides.account || {}) }; },
      retrieve: async (id) => {
        calls.retrieve.push(id);
        if (overrides.accountRetrieveError) throw overrides.accountRetrieveError;
        return overrides.accountRetrieved || { id, charges_enabled: false, payouts_enabled: false, details_submitted: false };
      },
    },
    accountLinks: {
      create: async (params) => { calls.accountLinks = calls.accountLinks || []; calls.accountLinks.push(params); return { url: 'https://connect.stripe.com/setup/acct_test1/xyz' }; },
    },
  };
}

const mk = (o = {}, stub = stubStripe()) => createStripePsp({ secretKey: 'sk_test_x', stripeClient: stub, ...o });

describe('stripe adapter — createWalletCharge (destination charge)', () => {
  test('destination charge pro acct_, gorjeta em metadata, BRL, devolve clientSecret', async () => {
    const stub = stubStripe();
    const psp = mk({}, stub);
    const r = await psp.createWalletCharge({
      chargeRef: 'check1:0:8000:800', amountCents: 8000, tipCents: 800,
      recipientId: 'acct_venue1', wallet: 'apple_pay', currency: 'brl',
    });
    expect(r).toMatchObject({ txid: 'pi_test1', clientSecret: 'pi_test1_secret_abc', status: 'requires_payment_method' });
    const p = stub.calls.create[0];
    expect(p.amount).toBe(8800);              // total = consumo + gorjeta
    expect(p.currency).toBe('brl');
    expect(p.transfer_data).toEqual({ destination: 'acct_venue1' }); // sem custódia
    expect(p.metadata.tip_cents).toBe('800'); // gorjeta separada (Lei 13.419)
    expect(p.metadata.wallet).toBe('apple_pay');
    expect(p.application_fee_amount).toBeUndefined(); // 0 → omitido
  });

  test('gate de custódia (sem acct_) e entradas inválidas recusam antes da API', async () => {
    const psp = mk();
    await expect(psp.createWalletCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: null })).rejects.toThrow(/custódia/);
    await expect(psp.createWalletCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 're_pagarme' })).rejects.toThrow(/custódia/);
    await expect(psp.createWalletCharge({ chargeRef: 'x', amountCents: 0, tipCents: 0, recipientId: 'acct_v' })).rejects.toThrow(/zero-value/);
    await expect(psp.createWalletCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'acct_v', wallet: 'pix' })).rejects.toThrow(/unknown wallet/);
    await expect(psp.createWalletCharge({ chargeRef: 'x', amountCents: 100, tipCents: 0, recipientId: 'acct_v', applicationFeeCents: 100 })).rejects.toThrow(/applicationFee/);
  });

  test('a moeda é obrigatória: omitir não vira real em silêncio', async () => {
    // Estes dois testes passavam ANTES da correção, com a moeda omitida, porque
    // o adaptador tinha `currency = 'brl'` de padrão. O padrão era o bug: os
    // dois chamadores de produção também omitiam, então uma mesa espanhola no
    // trilho de cartão cobrava em REAL — e a Stripe aceita cartão em `brl` sem
    // reclamar (medido contra a API em 2026-09-07), então nada abaixo pegava.
    //
    // Passar a moeda nos testes acima não é enfraquecê-los: é dizer em voz alta
    // o que o padrão dizia baixinho. O que este teste novo acrescenta é a
    // garantia que a remoção do padrão criou.
    const psp = mk();
    const base = { chargeRef: 'x', amountCents: 1000, tipCents: 0, recipientId: 'acct_v' };
    await expect(psp.createWalletCharge(base)).rejects.toThrow(/moeda obrigatória/);
    for (const bad of [null, '', 'BRL', 'usd', 'eur ']) {
      await expect(psp.createWalletCharge({ ...base, currency: bad })).rejects.toThrow(/moeda obrigatória/);
    }
  });

  test('a moeda do mercado atravessa até o parâmetro da Stripe', async () => {
    const { pspCurrency } = require('../_lib/markets');
    for (const [marketCode, expected] of [['br', 'brl'], ['es', 'eur']]) {
      const stub = stubStripe();
      await mk({}, stub).createWalletCharge({
        chargeRef: 'x', amountCents: 2450, tipCents: 0, recipientId: 'acct_v',
        currency: pspCurrency(marketCode),
      });
      expect(stub.calls.create[0].currency).toBe(expected);
      // 24,50 € cobrados como 2450 — a mesma aritmética de centavos, moeda
      // diferente. O que estava errado nunca foi o número, era o rótulo.
      expect(stub.calls.create[0].amount).toBe(2450);
    }
  });

  test('o CPF do pagador NÃO vai pra Stripe, e o trilho vai', async () => {
    // Duas garantias que a revisão de compliance de 2026-09-07 pediu.
    //
    // 1. O CPF. A base legal do campo é a NECESSIDADE do Pagar.me (a doc do
    //    Pix exige `customer.document`; LGPD art. 6º III). A Stripe não exige
    //    nada disso num intent de cartão e o `metadata` é livre e não lido pela
    //    API — então o que ia pra lá era um documento completo guardado por
    //    prazo indefinido no painel de um processador estrangeiro, sem
    //    finalidade. Nenhum teste cobria isso, que é como ficou lá.
    //
    // 2. O trilho. Só o `createBizumCharge` marcava `metadata.rail`, e o
    //    `parseIntent` caía em `payment_method_types[0]` pra todo o resto. Numa
    //    conta espanhola com `bizum_payments` ativa, 'bizum' pode aparecer
    //    nessa lista sem ordem garantida — e a confirmação sobrescreveria como
    //    Bizum uma cobrança de cartão que foi gravada certa.
    const stub = stubStripe();
    await mk({}, stub).createWalletCharge({
      chargeRef: 'x', amountCents: 1000, tipCents: 100, recipientId: 'acct_v',
      wallet: 'google_pay', payerDocument: '12345678901', currency: 'brl',
    });
    const md = stub.calls.create[0].metadata;
    expect(md.payer_document).toBeUndefined();
    expect(JSON.stringify(md)).not.toContain('12345678901');
    expect(md.rail).toBe('card');
    // E o que TEM que continuar lá: a gorjeta rastreável (Lei 13.419).
    expect(md.tip_cents).toBe('100');
  });

  test('o documento da casa vai na forma do PAÍS, não sempre em dígitos', async () => {
    // Era `replace(/\D/g, '')` sempre. Certo pro CNPJ, destrutivo pro NIF:
    // "B12345674" chegava na Stripe como "12345674". Um documento que não
    // valida trava a verificação da conta que RECEBE o dinheiro — e é a última
    // coisa que se descobre, porque o erro aparece semanas depois no KYC.
    const brStub = stubStripe();
    await mk({}, brStub).createConnectedAccount({
      businessName: 'Bar do Zé', cnpj: '12.345.678/0001-99', marketCode: 'br',
    });
    expect(brStub.calls.accounts[0].company.tax_id).toBe('12345678000199');
    expect(brStub.calls.accounts[0].country).toBe('BR');

    const esStub = stubStripe();
    await mk({}, esStub).createConnectedAccount({
      businessName: 'Bar Pepe', cnpj: ' b12345674 ', marketCode: 'es',
    });
    // A letra sobrevive, e o espaço/caixa são normalizados.
    expect(esStub.calls.accounts[0].company.tax_id).toBe('B12345674');
    expect(esStub.calls.accounts[0].country).toBe('ES');
    expect(esStub.calls.accounts[0].capabilities.bizum_payments).toEqual({ requested: true });
    // E o Brasil NÃO pede Bizum — a capacidade não existe pra conta BR.
    expect(brStub.calls.accounts[0].capabilities.bizum_payments).toBeUndefined();
  });

  test('o adaptador declara as moedas que atende', async () => {
    // Declarado, não suposto: o portão compartilhado confere isto antes de
    // chamar. Sem a declaração, o `createWalletCharge` do Pagar.me recebia
    // `currency` e ignorava (nem estava no destructuring), então a correção de
    // moeda do mercado era um no-op no adquirente de produção.
    expect(mk().currencies).toEqual(['brl', 'eur']);
    const { createPagarmePsp } = require('../_lib/pay/pagarme-psp');
    const pm = createPagarmePsp({ secretKey: 'sk_test_x', webhookSecret: 'y'.repeat(24) });
    expect(pm.currencies).toEqual(['brl']);
    // E o adquirente brasileiro recusa euro por conta própria, mesmo que
    // alguém chegue nele sem passar pelo portão.
    await expect(pm.createWalletCharge({
      chargeRef: 'x', amountCents: 100, recipientId: 're_x',
      wallet: 'google_pay', paymentToken: 'tok_abcdefgh', currency: 'eur',
    })).rejects.toThrow(/moeda obrigatória/);
  });

  test('application_fee_amount vai junto quando > 0', async () => {
    const stub = stubStripe();
    await mk({}, stub).createWalletCharge({ chargeRef: 'x', amountCents: 1000, tipCents: 0, recipientId: 'acct_v', applicationFeeCents: 50, currency: 'brl' });
    expect(stub.calls.create[0].application_fee_amount).toBe(50);
  });
});

describe('stripe adapter — getCharge (reconciliação)', () => {
  test('succeeded → paid com valores certos; id fora do padrão / ausente → null', async () => {
    const psp1 = mk({}, stubStripe({ retrievePI: { id: 'pi_x', status: 'succeeded', amount: 8800, metadata: { tip_cents: '800' } } }));
    expect(await psp1.getCharge('pi_x')).toMatchObject({
      txid: 'pi_x', paid: true, amountCents: 8000, tipCents: 800, method: 'card', kind: 'payment_confirmed',
    });
    const psp2 = mk();
    expect(await psp2.getCharge('ch_pagarme')).toBeNull();
    expect(await psp2.getCharge(null)).toBeNull();

    const missing = new Error('No such payment_intent'); missing.code = 'resource_missing';
    expect(await mk({}, stubStripe({ retrieveError: missing })).getCharge('pi_gone')).toBeNull();
  });

  test('pendente → paid:false; erro transitório RELANÇA (não vira null)', async () => {
    const psp = mk({}, stubStripe({ retrievePI: { id: 'pi_x', status: 'requires_payment_method', amount: 5000, metadata: {} } }));
    expect(await psp.getCharge('pi_x')).toMatchObject({ paid: false, status: 'requires_payment_method' });

    const boom = new Error('stripe down'); boom.statusCode = 500;
    await expect(mk({}, stubStripe({ retrieveError: boom })).getCharge('pi_x')).rejects.toThrow();
  });
});

describe('stripe adapter — webhook', () => {
  test('payment_intent.succeeded → payment_confirmed parseado', async () => {
    const event = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_x', status: 'succeeded', amount: 8800, metadata: { tip_cents: '800' } } } };
    const psp = mk({ webhookSecret: 'whsec_x' }, stubStripe({ event }));
    const parsed = await psp.verifyAndParseWebhook('{raw}', { 'stripe-signature': 't=1,v1=abc' });
    expect(parsed).toMatchObject({ kind: 'payment_confirmed', txid: 'pi_x', amountCents: 8000, tipCents: 800, method: 'card' });
  });

  test('charge.refunded → refund shape (consumo/gorjeta separados)', async () => {
    const event = { type: 'charge.refunded', data: { object: { payment_intent: 'pi_x', amount_refunded: 8800, metadata: { tip_cents: '800' } } } };
    const psp = mk({ webhookSecret: 'whsec_x' }, stubStripe({ event }));
    const parsed = await psp.verifyAndParseWebhook('{raw}', { 'stripe-signature': 'x' });
    expect(parsed).toMatchObject({ kind: 'refund', txid: 'pi_x', amountCents: 8000, tipCents: 800, method: 'card' });
  });

  test('assinatura ruim, sem secret e sem header rejeitam', async () => {
    await expect(mk({ webhookSecret: 'whsec_x' }, stubStripe({ constructThrows: true }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(WebhookVerificationError);
    await expect(mk({}, stubStripe({ event: {} }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(/WEBHOOK_SECRET/);
    await expect(mk({ webhookSecret: 'whsec_x' }, stubStripe({ event: {} }))
      .verifyAndParseWebhook('{}', {})).rejects.toThrow(/stripe-signature/);
  });

  test('evento irrelevante é IGNORADO com assinatura válida, não rejeitado', async () => {
    // Este teste mudou de sentido de propósito, e a mudança é o achado.
    //
    // Antes ele exigia que um evento fora do nosso interesse fosse RECUSADO. A
    // rota mapeia recusa pra 401, e a Stripe reage a 401 reenviando e depois
    // DESABILITANDO o endpoint — junto com os eventos que importam, incluindo
    // um `refund.failed` (dinheiro de volta no saldo do restaurante e cliente
    // sem reembolso). A assinatura estava válida; o evento é que não é nosso.
    // Recusar uma assinatura boa é dizer "não confio em você" pra quem manda o
    // dinheiro. Achado da revisão de compliance da abertura da Espanha.
    const parsed = await mk({ webhookSecret: 'whsec_x' },
      stubStripe({ event: { type: 'customer.created', data: { object: {} } } }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(parsed).toMatchObject({ kind: 'ignored', type: 'customer.created' });
  });
});

describe('stripe adapter — config + Connect', () => {
  test('secret key sk_/rk_ obrigatória', () => {
    expect(() => createStripePsp({ secretKey: null, stripeClient: stubStripe() })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => createStripePsp({ secretKey: 'pk_publica', stripeClient: stubStripe() })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => createStripePsp({ secretKey: 'rk_restrita', stripeClient: stubStripe() })).not.toThrow();
  });

  test('createConnectedAccount: express BR com CNPJ limpo', async () => {
    const stub = stubStripe({ account: { id: 'acct_new', charges_enabled: false } });
    const r = await mk({}, stub).createConnectedAccount({ email: 'a@b.com', businessName: 'Kitos', cnpj: '65.087.663/0001-30' });
    expect(r).toEqual({ recipientId: 'acct_new', status: 'registration' });
    expect(stub.calls.accounts[0].country).toBe('BR');
    expect(stub.calls.accounts[0].business_type).toBe('company');
    expect(stub.calls.accounts[0].company.tax_id).toBe('65087663000130');
  });

  test('createAccountLink: onboarding url; exige acct_ + urls', async () => {
    const stub = stubStripe();
    const r = await mk({}, stub).createAccountLink({ accountId: 'acct_x', refreshUrl: 'https://r', returnUrl: 'https://d' });
    expect(r.url).toMatch(/connect\.stripe\.com/);
    expect(stub.calls.accountLinks[0]).toMatchObject({ account: 'acct_x', type: 'account_onboarding', refresh_url: 'https://r', return_url: 'https://d' });
    await expect(mk().createAccountLink({ accountId: 're_x', refreshUrl: 'a', returnUrl: 'b' })).rejects.toThrow(/acct_/);
    await expect(mk().createAccountLink({ accountId: 'acct_x' })).rejects.toThrow(/obrigatórios/);
  });

  test('getConnectedAccount: status por charges_enabled/details_submitted; ausente → null', async () => {
    const active = await mk({}, stubStripe({ accountRetrieved: { id: 'acct_x', charges_enabled: true, payouts_enabled: true, details_submitted: true } })).getConnectedAccount('acct_x');
    expect(active).toMatchObject({ recipientId: 'acct_x', chargesEnabled: true, status: 'active' });
    const pending = await mk({}, stubStripe({ accountRetrieved: { id: 'acct_x', charges_enabled: false, details_submitted: true } })).getConnectedAccount('acct_x');
    expect(pending).toMatchObject({ status: 'pending', chargesEnabled: false });
    const fresh = await mk({}, stubStripe({ accountRetrieved: { id: 'acct_x', charges_enabled: false, details_submitted: false } })).getConnectedAccount('acct_x');
    expect(fresh).toMatchObject({ status: 'registration' });
    expect(await mk().getConnectedAccount('re_pagarme')).toBeNull();
    const missing = new Error('no acct'); missing.code = 'resource_missing';
    expect(await mk({}, stubStripe({ accountRetrieveError: missing })).getConnectedAccount('acct_gone')).toBeNull();
  });
});

describe('disputa e reembolso que falha', () => {
  // Duas coisas que ninguém descobre sozinho, e que o Bizum tornou urgentes:
  // 120 dias de janela de reclamação (contra a janela curta do MED do Pix) e
  // reembolso assíncrono que pode falhar depois de ter sido pedido.
  const dispute = (over) => ({
    type: 'charge.dispute.created',
    data: { object: { payment_intent: 'pi_d', amount: 3390, reason: 'fraudulent', ...over } },
  });

  test('disputa aberta NÃO é estorno — é evento próprio, sem mover saldo', async () => {
    const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({ event: dispute() }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(parsed).toMatchObject({ kind: 'dispute_opened', txid: 'pi_d', amountCents: 3390, reason: 'fraudulent' });
    // O que este teste protege: marcar como 'refund' reabriria a conta por
    // causa de uma reclamação que talvez não proceda.
    expect(parsed.kind).not.toBe('refund');
  });

  test('disputa PERDIDA vira estorno de verdade', async () => {
    const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'charge.dispute.closed', data: { object: { payment_intent: 'pi_d', amount: 3390, status: 'lost' } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(parsed).toMatchObject({ kind: 'refund', txid: 'pi_d', amountCents: 3390 });
  });

  test('disputa GANHA não mexe em nada', async () => {
    const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'charge.dispute.closed', data: { object: { payment_intent: 'pi_d', amount: 3390, status: 'won' } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(parsed.kind).toBe('ignored');
  });

  test('reembolso que falhou é reconhecido — o dinheiro voltou pro restaurante e o cliente ficou sem', async () => {
    const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'refund.failed', data: { object: { payment_intent: 'pi_r', amount: 1000, status: 'failed' } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(parsed).toMatchObject({ kind: 'refund_failed', txid: 'pi_r', amountCents: 1000 });
  });
});

describe('Bizum: os parâmetros exatos que vão pra Stripe', () => {
  /**
   * Este teste fixa o CONTRATO da chamada, porque as partes dele foram
   * confirmadas de formas diferentes e a mais importante não pôde ser.
   *
   * Verificado contra a API de verdade num sandbox (2026-09-07):
   *   - `currency: 'eur'` e `payment_method_types: ['bizum']` são aceitos;
   *   - o mínimo é 0,50 € (`amount_too_small`) e o máximo 5.000 €
   *     (`amount_too_large`) — os números batem com os do markets.js;
   *   - confirmar devolve `requires_action` / `await_authorization`;
   *   - um PaymentMethod de bizum exige `billing_details[phone]`.
   *
   * NÃO verificado contra a API: `transfer_data` + `on_behalf_of`, porque criar
   * conta conectada exige um sandbox REIVINDICADO e a chave do sandbox
   * reivindicável não tem essa permissão. É justamente a parte que decide o
   * fluxo de fundos (inegociável #4: liquida na conta do restaurante, sem
   * custódia nossa) e quem aparece como comerciante no app do banco do cliente.
   * Então ela fica fixada AQUI, no parâmetro, até alguém rodar uma cobrança com
   * conta conectada de verdade.
   */
  const ACCT = 'acct_1TESTconnected';

  async function bizum(over = {}) {
    const stub = stubStripe();
    const psp = mk({ webhookSecret: 'whsec_x' }, stub);
    await psp.createBizumCharge({
      chargeRef: 'check:0:3390:0', amountCents: 3390, tipCents: 0,
      recipientId: ACCT, ...over,
    });
    return stub.calls.create[0];
  }

  test('euro, bizum, e nada de automatic_payment_methods', async () => {
    const p = await bizum();
    expect(p.currency).toBe('eur');
    expect(p.payment_method_types).toEqual(['bizum']);
    // O automático ofereceria tudo que a conta tem habilitado, e o Express
    // Checkout Element não suporta Bizum — o intent tem que nomear o trilho.
    expect(p.automatic_payment_methods).toBeUndefined();
  });

  test('destination charge PARA a conta do restaurante, e ele é o comerciante', async () => {
    const p = await bizum();
    // Sem isto o dinheiro liquidaria na plataforma: custódia, que o
    // inegociável #4 proíbe.
    expect(p.transfer_data).toEqual({ destination: ACCT });
    // Sem isto o comerciante que aparece no app do banco do cliente é a
    // PLATAFORMA, não a casa onde ele acabou de comer.
    expect(p.on_behalf_of).toBe(ACCT);
  });

  test('o trilho e a gorjeta viajam no metadata, que é o que o webhook lê', async () => {
    const p = await bizum({ tipCents: 0 });
    expect(p.metadata.rail).toBe('bizum');
    expect(p.metadata.tip_cents).toBe('0');
    expect(p.metadata.charge_ref).toBe('check:0:3390:0');
  });

  test('o valor é consumo + gorjeta, em centavos inteiros', async () => {
    const p = await bizum({ amountCents: 3390, tipCents: 110 });
    expect(p.amount).toBe(3500);
  });

  test('sem conta conectada não sai cobrança — recusa custódia da plataforma', async () => {
    await expect(bizum({ recipientId: null })).rejects.toThrow(/conta conectada/i);
    await expect(bizum({ recipientId: 'rcpt_pagarme' })).rejects.toThrow(/conta conectada/i);
  });

  test('os limites do esquema são conferidos no adaptador, não só na tela', async () => {
    // Confirmados contra a API real: 0,50 € e 5.000 €.
    await expect(bizum({ amountCents: 49, tipCents: 0 })).rejects.toThrow(/mínimo/i);
    await expect(bizum({ amountCents: 500001, tipCents: 0 })).rejects.toThrow(/máximo/i);
    await expect(bizum({ amountCents: 499999, tipCents: 2 })).rejects.toThrow(/máximo/i);
  });

  test('a chave restrita de sandbox (rkcs_) é aceita como secreta', async () => {
    // Recusar `rkcs_test_…` fazia o adaptador virar null e o caminho de cartão
    // dizer "Stripe não configurado" sem explicar por quê. Achado ligando um
    // sandbox de verdade.
    expect(() => mk({ secretKey: 'rkcs_test_abc', webhookSecret: 'whsec_x' }, stubStripe())).not.toThrow();
    expect(() => mk({ secretKey: 'pk_test_abc', webhookSecret: 'whsec_x' }, stubStripe())).toThrow();
  });
});
