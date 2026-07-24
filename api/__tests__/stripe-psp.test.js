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
      recipientId: 'acct_venue1', wallet: 'apple_pay',
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

  test('application_fee_amount vai junto quando > 0', async () => {
    const stub = stubStripe();
    await mk({}, stub).createWalletCharge({ chargeRef: 'x', amountCents: 1000, tipCents: 0, recipientId: 'acct_v', applicationFeeCents: 50 });
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

  test('assinatura ruim, evento irrelevante, sem secret e sem header rejeitam', async () => {
    await expect(mk({ webhookSecret: 'whsec_x' }, stubStripe({ constructThrows: true }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(WebhookVerificationError);
    await expect(mk({ webhookSecret: 'whsec_x' }, stubStripe({ event: { type: 'customer.created', data: { object: {} } } }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(/ignorado/);
    await expect(mk({}, stubStripe({ event: {} }))
      .verifyAndParseWebhook('{}', { 'stripe-signature': 'x' })).rejects.toThrow(/WEBHOOK_SECRET/);
    await expect(mk({ webhookSecret: 'whsec_x' }, stubStripe({ event: {} }))
      .verifyAndParseWebhook('{}', {})).rejects.toThrow(/stripe-signature/);
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
});
