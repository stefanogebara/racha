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

  test('um pagamento Bizum entrega CINCO eventos, e só um move o razão', async () => {
    // Medido contra a Stripe de verdade em 2026-09-08, com `stripe listen`
    // apontado pro nosso handler: um único pagamento Bizum entregou
    // `payment_intent.created`, `payment_intent.requires_action`,
    // `payment_intent.succeeded`, `charge.succeeded` e `charge.updated`.
    //
    // Só o `succeeded` é nosso. Os outros quatro têm que virar `ignored` no
    // PORTÃO — se chegarem ao aplicador, ele não acha o txid (uma
    // `charge.succeeded` de Bizum carrega `py_…`, não `pi_…`), cai no fallback
    // e devolve `rejected`, que a rota mapeia pra 409. A Stripe reenvia e
    // depois DESABILITA o endpoint, levando um `refund.failed` junto.
    const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
    const psp = {
      async verifyAndParseWebhook(raw) {
        const type = String(raw);
        if (type === 'payment_intent.succeeded') {
          return { kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3390, tipCents: 0, method: 'bizum' };
        }
        return { kind: 'ignored', type };
      },
    };
    const chamadasAoAplicador = [];
    const handle = createWebhookHandler({
      psp,
      loadEvents: async () => [],
      appendEvent: async () => 1,
      findCheckByTxid: async (txid) => { chamadasAoAplicador.push(txid); return null; },
      fallback: async () => null,
    });

    for (const t of ['payment_intent.created', 'payment_intent.requires_action',
      'charge.succeeded', 'charge.updated']) {
      expect(await handle(t, 'sig')).toEqual({ status: 'ignored', type: t });
    }
    // Nenhum dos quatro chegou ao aplicador.
    expect(chamadasAoAplicador).toEqual([]);

    // E o que É nosso passa: chega ao aplicador e é recusado por txid
    // desconhecido, que é o comportamento certo pra um txid que não emitimos.
    const r = await handle('payment_intent.succeeded', 'sig');
    expect(r.status).toBe('rejected');
    expect(chamadasAoAplicador).toEqual(['pi_x']);
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
    const event = { type: 'payment_intent.succeeded', livemode: false, data: { object: { id: 'pi_x', status: 'succeeded', amount: 8800, metadata: { tip_cents: '800' } } } };
    const psp = mk({ webhookSecret: 'whsec_x' }, stubStripe({ event }));
    const parsed = await psp.verifyAndParseWebhook('{raw}', { 'stripe-signature': 't=1,v1=abc' });
    expect(parsed).toMatchObject({ kind: 'payment_confirmed', txid: 'pi_x', amountCents: 8000, tipCents: 800, method: 'card' });
  });

  test('charge.refunded devolve o ACUMULADO, não um valor já rateado', async () => {
    // Este teste mudou de forma, e a mudança é o achado.
    //
    // Antes ele exigia `amountCents: 8000, tipCents: 800` — o adaptador rateava
    // ali mesmo, com `Math.min(tipCents, refunded)`, que devolve a gorjeta
    // INTEIRA antes de tocar o consumo. Num estorno parcial isso raspa o
    // serviço todo: 500¢ sobre 3082+308 estornava 308 de gorjeta e 192 de
    // consumo. A gorjeta é remuneração do empregado (Lei 13.419 + STJ Tema
    // 1102), então quem perde primeiro num estorno é decisão sobre o salário
    // de alguém — não pode ser efeito colateral de um `Math.min`.
    //
    // E `amount_refunded` é ACUMULADO: o segundo estorno parcial reapresentava
    // o total como se fosse novo, o `validateEvent` recusava, a rota devolvia
    // 409, a Stripe reenviava e depois DESABILITAVA o endpoint.
    //
    // Agora o adaptador reporta o acumulado e diz que é acumulado; o delta e o
    // rateio proporcional acontecem no razão, que é quem sabe quanto já foi
    // estornado e qual era o split. Achado pela revisão de compliance de
    // 2026-09-08.
    const event = { type: 'charge.refunded', livemode: false, data: { object: { payment_intent: 'pi_x', amount_refunded: 8800 } } };
    const psp = mk({ webhookSecret: 'whsec_x' }, stubStripe({ event }));
    const parsed = await psp.verifyAndParseWebhook('{raw}', { 'stripe-signature': 'x' });
    expect(parsed).toMatchObject({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 8800, method: 'card' });
    // O adaptador NÃO rateia mais, e não deve fingir que rateou.
    expect(parsed.amountCents).toBeUndefined();
    expect(parsed.tipCents).toBeUndefined();
  });

  test('evento de modo trocado é RECUSADO — teste não confirma dinheiro real', async () => {
    // A assinatura prova que o corpo veio de quem tem o `whsec_`. Ela NÃO diz
    // nada sobre modo. Um segredo de webhook de teste emparelhado com chave
    // live — o desvio de configuração exato em que esta sessão viveu — fazia um
    // `payment_intent.succeeded` de TESTE virar confirmação válida no razão de
    // produção: dinheiro de mentira fechando mesa de verdade.
    const vivo = { type: 'payment_intent.succeeded', livemode: true, data: { object: { id: 'pi_x', status: 'succeeded', amount: 1000, metadata: {} } } };
    const teste = { ...vivo, livemode: false };

    // Chave de teste + evento LIVE → recusa.
    await expect(mk({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }, stubStripe({ event: vivo }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(/modo do evento/);
    // Chave live + evento de TESTE → recusa.
    await expect(mk({ secretKey: 'sk_live_x', webhookSecret: 'whsec_x' }, stubStripe({ event: teste }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(/modo do evento/);
    // AUSÊNCIA do campo é falsificação, não dispensa. A primeira versão da
    // guarda só rodava quando `livemode` era booleano, então quem tivesse um
    // `whsec_` de teste vazado — e são os que vazam: `stripe listen`, CI,
    // print de tela — assinava um corpo SEM o campo e passava. Verificado:
    // virava um `payment_confirmed` de R$ 5.000,00 no razão de produção.
    const semCampo = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_forjado', status: 'succeeded', amount: 500000, metadata: {} } } };
    for (const key of ['sk_live_x', 'sk_test_x']) {
      await expect(mk({ secretKey: key, webhookSecret: 'whsec_x' }, stubStripe({ event: semCampo }))
        .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(/modo do evento/);
    }

    // E os pares certos passam.
    expect((await mk({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }, stubStripe({ event: teste }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).kind).toBe('payment_confirmed');
    expect((await mk({ secretKey: 'sk_live_x', webhookSecret: 'whsec_x' }, stubStripe({ event: vivo }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).kind).toBe('payment_confirmed');
  });

  test('estorno órfão e eventos de conta não caem em ignorado', async () => {
    // `Refund.payment_intent` é NULÁVEL (cobrança criada pela API de Charges,
    // e algumas entregas de Connect). Ignorar isso é 200 pra dinheiro que se
    // moveu, em cima de um razão que já diz "estornado".
    const orfao = await mk({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'refund.failed', livemode: false, data: { object: { amount: 1000, status: 'failed' } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(orfao.kind).toBe('unusable_money_event');

    // `charge.refund.updated` é o nome DEPRECADO: endpoint em versão de API
    // anterior a 2024-10-28 recebe esse no lugar de `refund.*`. Sem o
    // sinônimo, um estorno que falhou era ignorado em silêncio.
    const velho = await mk({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'charge.refund.updated', livemode: false, data: { object: { payment_intent: 'pi_r', amount: 1000, status: 'failed' } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(velho.kind).toBe('refund_failed');

    // Conta e repasse: cada um é uma promessa nossa quebrando em silêncio.
    for (const type of ['payout.failed', 'capability.updated', 'account.updated', 'radar.early_fraud_warning.created']) {
      const p2 = await mk({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }, stubStripe({
        event: { type, livemode: false, account: 'acct_v', data: { object: { status: 'inactive' } } },
      })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
      expect(p2.kind).toBe('account_alert');
      expect(p2.type).toBe(type);
      expect(p2.accountId).toBe('acct_v');
    }
  });

  test('pagamento que FALHOU é lido, e a linha sai de pendente', async () => {
    // No Bizum é a pessoa recusando no app do banco. Era `ignored`, e o custo
    // era concreto: a linha ficava `pendente` até sair da janela de
    // conciliação, e ninguém nunca soube que aquela mesa tentou e não
    // conseguiu. Não move o razão — nenhum dinheiro se moveu.
    const { ROW_STATUS_FOR_KIND, NON_LEDGER_KINDS } = require('../_lib/pay/webhook-handler');
    for (const type of ['payment_intent.payment_failed', 'payment_intent.canceled']) {
      const p2 = await mk({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }, stubStripe({
        event: {
          type, livemode: false,
          data: { object: { id: 'pi_f', amount: 3390, status: 'requires_payment_method', last_payment_error: { code: 'payment_intent_authentication_failure' } } },
        },
      })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
      expect(p2).toMatchObject({ kind: 'payment_failed', txid: 'pi_f', amountCents: 3390 });
      expect(p2.reason).toBe('payment_intent_authentication_failure');
    }
    // Não é espécie de razão, e a linha vai pra `expirado` — status que o
    // esquema tem desde a primeira migração.
    expect(NON_LEDGER_KINDS.has('payment_failed')).toBe(true);
    expect(ROW_STATUS_FOR_KIND.payment_failed).toBe('expirado');
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
      stubStripe({ event: { type: 'customer.created', livemode: false, data: { object: {} } } }))
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
    // `livemode` explícito: a guarda de modo trata AUSÊNCIA como falsificação,
    // e um dublê sem o campo seria um dublê mais permissivo que a produção.
    livemode: false,
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

  test('disputa PERDIDA vira estorno, com o valor pra ratear no razão', async () => {
    const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'charge.dispute.closed', livemode: false, data: { object: { payment_intent: 'pi_d', amount: 3390, status: 'lost' } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    // `dispute_lost`, não `refund` genérico: o razão precisa saber que isto é
    // desfecho de disputa pra também LIMPAR a marca. E o valor vai como delta
    // pra ser rateado entre consumo e gorjeta — um chargeback leva a gorjeta
    // junto, e deixá-la nos livros como "paga" mentiria pra folha.
    expect(parsed).toMatchObject({
      kind: 'dispute_lost', txid: 'pi_d', refundDeltaCents: 3390, status: 'lost',
    });
  });

  test('disputa GANHA precisa de evento — senão a conta fica vermelha pra sempre', async () => {
    // Este teste mudou de sentido, e a mudança é o achado.
    //
    // Antes ele exigia `ignored`, e "não mexe em nada" parecia certo: o
    // dinheiro fica com o restaurante. Mas o `PAYMENT_DISPUTED` já tinha posto
    // uma ANOMALIA na conta, e anomalia não se resolve sozinha — a conta
    // aparecia vermelha na conciliação pra sempre, por uma disputa que a casa
    // GANHOU. Um canário que grita sem parar é o modo de falha do inegociável
    // #8. Achado pela revisão de compliance de 2026-09-08.
    for (const status of ['won', 'warning_closed']) {
      const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
        event: { type: 'charge.dispute.closed', livemode: false, data: { object: { payment_intent: 'pi_d', amount: 3390, status } } },
      })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
      expect(parsed).toMatchObject({ kind: 'dispute_won', txid: 'pi_d', status });
    }
  });

  test('o PRAZO DE PROVA é lido, e ele é a coisa mais cara do evento', async () => {
    // O Bizum dá 40 dias corridos pra apresentar prova, e perder o prazo é
    // perder o dinheiro por inação. O `evidence_details.due_by` era jogado
    // fora: a defesa inteira desse prazo era uma notificação best-effort que
    // degrada pra stderr sem `RACHA_NOTIFY_SECRET`.
    const dueBy = 1789000000; // unix, como a Stripe manda
    const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: {
        type: 'charge.dispute.created', livemode: false,
        data: { object: { payment_intent: 'pi_d', amount: 3390, reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: dueBy } } },
      },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(parsed.kind).toBe('dispute_opened');
    expect(parsed.dueBy).toBe(new Date(dueBy * 1000).toISOString());
    expect(parsed.reason).toBe('fraudulent');
  });

  test('a família inteira da disputa é classificada, nada cai em ignorado', async () => {
    // `updated` carrega mudança de prazo e envio de prova;
    // `funds_withdrawn`/`funds_reinstated` são dinheiro saindo e voltando do
    // saldo. Os três eram `ignored`, e o job diário não tem perna de razão do
    // PSP — então nada mais pegava.
    const casos = [
      ['charge.dispute.updated', 'dispute_updated'],
      ['charge.dispute.funds_withdrawn', 'dispute_funds'],
      ['charge.dispute.funds_reinstated', 'dispute_funds'],
    ];
    for (const [type, kind] of casos) {
      const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
        event: { type, livemode: false, data: { object: { payment_intent: 'pi_d', amount: 3390, status: 'under_review' } } },
      })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
      expect(parsed.kind).toBe(kind);
    }
    // E a direção do dinheiro é explícita, não deduzida do nome do evento
    // por quem lê depois.
    const saiu = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'charge.dispute.funds_withdrawn', livemode: false, data: { object: { payment_intent: 'pi_d', amount: 3390 } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(saiu.direction).toBe('withdrawn');

    // Disputa sem `payment_intent` é dinheiro que não sabemos endereçar —
    // nem ignorado nem processado.
    const orfa = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'charge.dispute.created', livemode: false, data: { object: { amount: 3390, status: 'needs_response' } } },
    })).verifyAndParseWebhook('{}', { 'stripe-signature': 'x' });
    expect(orfa.kind).toBe('unusable_money_event');
  });

  test('reembolso que falhou é reconhecido — o dinheiro voltou pro restaurante e o cliente ficou sem', async () => {
    const parsed = await mk({ webhookSecret: 'whsec_x' }, stubStripe({
      event: { type: 'refund.failed', livemode: false, data: { object: { payment_intent: 'pi_r', amount: 1000, status: 'failed' } } },
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

describe('a taxa da plataforma não incide sobre a GORJETA', () => {
  /**
   * A faixa era `[0, amountCents + tipCents)`. Ninguém passa taxa hoje — e é
   * por isso que o momento de corrigir é agora: no dia em que a margem sobre
   * volume ligar, uma taxa calculada sobre essa base tira um pedaço do serviço,
   * que não é receita da casa (STJ Tema 1102) e sim remuneração do empregado
   * (Lei 13.419). Margem sobre folha alheia já teria acontecido no primeiro
   * pagamento. Achado pela revisão de segurança de 2026-09-08.
   */
  const stubStripe = () => ({
    paymentIntents: { create: async (b) => ({ id: 'pi_x', client_secret: 'cs_x', ...b }) },
  });

  test('taxa que caberia no total mas não no consumo é RECUSADA', async () => {
    const psp = createStripePsp({ secretKey: 'sk_test_x', stripeClient: stubStripe() });
    // Consumo 1000, gorjeta 100. Uma taxa de 1050 cabia em [0, 1100) e comia
    // metade da gorjeta.
    await expect(psp.createWalletCharge({
      chargeRef: 'c:0', amountCents: 1000, tipCents: 100,
      recipientId: 'acct_x', applicationFeeCents: 1050, currency: 'brl',
    })).rejects.toThrow(/não incide sobre a gorjeta/);
  });

  test('taxa dentro do consumo passa', async () => {
    const psp = createStripePsp({ secretKey: 'sk_test_x', stripeClient: stubStripe() });
    const r = await psp.createWalletCharge({
      chargeRef: 'c:0', amountCents: 1000, tipCents: 100,
      recipientId: 'acct_x', applicationFeeCents: 50, currency: 'brl',
    });
    expect(r.txid).toBe('pi_x');
  });
});
