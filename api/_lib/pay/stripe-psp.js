'use strict';

/**
 * Stripe — o SEGUNDO rail do Racha, só pra CARTÃO / Apple Pay / Google Pay web.
 * O Pix continua no Pagar.me (na Stripe o Pix é invite-only pra empresa BR); a
 * camada de PSP roteia por método. Este adapter existe porque o Pagar.me NÃO
 * tem Apple Pay web (o token Apple Pay é criptografado e só um processador que
 * suporta decripta — Stripe/Adyen/etc. sim, Pagar.me não).
 *
 * MODELO DE FUNDOS (regra nº4 — nunca custodiar): DESTINATION CHARGE. O
 * PaymentIntent liquida direto na conta CONECTADA do restaurante
 * (`transfer_data.destination = acct_...`); o Racha só tira sua margem via
 * `application_fee_amount` (0 por ora). Dinheiro nunca para na plataforma —
 * mesma garantia do split do Pagar.me, do jeito Stripe.
 *
 * ⚠️ CÓDIGO, NÃO FLUXO VIVO: nada aqui roteia dinheiro real até (a) existir uma
 * conta Stripe do Racha como plataforma Connect, (b) cada restaurante ter uma
 * conta conectada (`acct_`) via onboarding, e (c) o parecer do jurídico de
 * pagamentos (regra nº4). O deploy é gated; o adapter é a fundação testada.
 *
 * Contrato (compatível com o MockPsp/pagarme pro reconciliador/webhook-handler):
 *   createWalletCharge({ chargeRef, amountCents, tipCents, recipientId, wallet, ... })
 *     → { txid: 'pi_...', clientSecret, status }   (o front confirma com a sheet)
 *   getCharge(txid) → { txid, status, paid, amountCents, tipCents, method, kind, raw } | null
 *   verifyAndParseWebhook(rawBody, headers)
 *     → { kind, txid, amountCents, tipCents, method, raw }  (throws na assinatura ruim)
 *
 * Diferença de fluxo vs. Pagar.me (Google Pay): lá o front manda um `card_token`
 * e a cobrança fecha síncrona; aqui o backend cria o PaymentIntent e devolve o
 * `clientSecret` — o front confirma com o Apple Pay/Google Pay (Stripe Express
 * Checkout Element) e a confirmação chega por webhook `payment_intent.succeeded`.
 */

class WebhookVerificationError extends Error {
  constructor(message) { super(message); this.name = 'WebhookVerificationError'; }
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.secretKey       sk_… (ou rk_… restrita) da plataforma Racha
 * @param {string} [opts.webhookSecret] whsec_… do endpoint (verificação de assinatura)
 * @param {object} [opts.stripeClient]  injeção pra teste; default = require('stripe')(secretKey)
 */
function createStripePsp({ secretKey, webhookSecret = null, stripeClient = null } = {}) {
  if (!secretKey || !/^(sk|rk)_/.test(secretKey)) {
    throw new Error('createStripePsp: STRIPE_SECRET_KEY (sk_… ou rk_…) é obrigatória');
  }
  // Lazy: só carrega o SDK se não veio um client injetado (testes injetam stub).
  const stripe = stripeClient || require('stripe')(secretKey);

  /** PaymentIntent → o shape parseado comum (mesmo do pagarme.getCharge). */
  function parseIntent(pi) {
    const totalCents = Number(pi.amount) || 0;
    const tipCents = Number((pi.metadata && pi.metadata.tip_cents) || 0) || 0;
    const amountCents = Math.max(0, totalCents - tipCents);
    return {
      txid: pi.id,
      status: pi.status,
      paid: pi.status === 'succeeded',
      kind: 'payment_confirmed',
      amountCents,
      tipCents,
      method: 'card', // Apple/Google Pay web são cartões tokenizados
      raw: pi,
    };
  }

  return {
    provider: 'stripe',

    /**
     * Cria o PaymentIntent (destination charge) e devolve o clientSecret pro
     * front confirmar com a carteira. recipientId = conta conectada do
     * restaurante (acct_…) — sem ela, recusa (regra de custódia).
     */
    async createWalletCharge({
      chargeRef, amountCents, tipCents = 0, recipientId,
      wallet = null, payerDocument = null, applicationFeeCents = 0,
    }) {
      if (typeof recipientId !== 'string' || !/^acct_/.test(recipientId)) {
        throw new Error('stripe: conta conectada (acct_…) obrigatória — recusando custódia da plataforma');
      }
      if (typeof chargeRef !== 'string' || chargeRef.length === 0) {
        throw new TypeError('createWalletCharge: chargeRef required');
      }
      assertCents(amountCents, 'amountCents');
      assertCents(tipCents, 'tipCents');
      if (wallet !== null && !['apple_pay', 'google_pay'].includes(wallet)) {
        throw new TypeError(`createWalletCharge: unknown wallet ${wallet}`);
      }
      const total = amountCents + tipCents;
      if (total === 0) throw new TypeError('zero-value charge');
      if (!Number.isSafeInteger(applicationFeeCents) || applicationFeeCents < 0 || applicationFeeCents >= total) {
        throw new TypeError('applicationFeeCents fora de [0, total)');
      }

      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency: 'brl',
        // Apple/Google Pay entram pelo Payment/Express Checkout Element no front.
        automatic_payment_methods: { enabled: true },
        // DESTINATION CHARGE: liquida na conta do restaurante, não na plataforma.
        transfer_data: { destination: recipientId },
        ...(applicationFeeCents > 0 ? { application_fee_amount: applicationFeeCents } : {}),
        // Gorjeta viaja na MESMA cobrança e fica rastreável (Lei 13.419) — o
        // ledger lê tip_cents daqui, igual ao Pagar.me.
        metadata: {
          charge_ref: chargeRef.slice(0, 200),
          tip_cents: String(tipCents),
          ...(wallet ? { wallet } : {}),
          ...(payerDocument ? { payer_document: String(payerDocument).replace(/\D/g, '') } : {}),
        },
      });
      return { txid: pi.id, clientSecret: pi.client_secret, status: pi.status };
    },

    /**
     * Estado de um PaymentIntent — a verdade pra reconciliação ativa (mesmo
     * papel do pagarme.getCharge). null pra id fora do padrão / inexistente;
     * relança erro transitório pro próximo tick.
     */
    async getCharge(txid) {
      if (typeof txid !== 'string' || !/^pi_/.test(txid)) return null;
      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(txid);
      } catch (err) {
        if (err && (err.statusCode === 404 || err.code === 'resource_missing')) return null;
        throw err; // 5xx/rede: transitório
      }
      if (!pi || !pi.id) return null;
      return parseIntent(pi);
    },

    /**
     * Cria a conta CONECTADA do restaurante (Connect Express) — o análogo do
     * recebedor do Pagar.me. Onboarding (link de KYC) é passo separado no admin;
     * aqui só o esqueleto. Dados bancários/KYC vêm do restaurante, nunca daqui.
     */
    async createConnectedAccount({ email = null, businessName = null, cnpj = null } = {}) {
      const acct = await stripe.accounts.create({
        type: 'express',
        country: 'BR',
        ...(email ? { email } : {}),
        business_type: 'company',
        ...(businessName || cnpj ? {
          company: {
            ...(businessName ? { name: String(businessName).slice(0, 128) } : {}),
            ...(cnpj ? { tax_id: String(cnpj).replace(/\D/g, '') } : {}),
          },
        } : {}),
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      return { recipientId: acct.id, status: acct.charges_enabled ? 'active' : 'registration' };
    },

    /**
     * Webhook: verifica a assinatura Stripe (constructEvent) e devolve o shape
     * parseado comum. O corpo CRU é obrigatório (a assinatura é sobre os bytes).
     */
    async verifyAndParseWebhook(rawBody, signatureOrHeaders) {
      if (!webhookSecret) throw new WebhookVerificationError('STRIPE_WEBHOOK_SECRET não configurado');
      const headers = (signatureOrHeaders && typeof signatureOrHeaders === 'object') ? signatureOrHeaders : {};
      const sig = headers['stripe-signature'] || headers['Stripe-Signature']
        || (typeof signatureOrHeaders === 'string' ? signatureOrHeaders : null);
      if (!sig) throw new WebhookVerificationError('sem header stripe-signature');

      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      } catch (err) {
        throw new WebhookVerificationError(`assinatura Stripe inválida: ${String(err.message).slice(0, 120)}`);
      }

      const type = event.type;
      if (type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        return { ...parseIntent(pi), kind: 'payment_confirmed' };
      }
      if (type === 'charge.refunded') {
        // v1: reembolso TOTAL (paridade com o pagarme). O objeto é uma charge;
        // charge.payment_intent aponta pro pi (nossa chave). Gorjeta/consumo
        // separados via metadata do PI (o reembolso parcial entra no checklist).
        const charge = event.data.object;
        const txid = charge.payment_intent;
        if (typeof txid !== 'string') throw new WebhookVerificationError('refund sem payment_intent');
        const tipCents = Number((charge.metadata && charge.metadata.tip_cents) || 0) || 0;
        const refunded = Number(charge.amount_refunded) || 0;
        return {
          kind: 'refund', txid,
          amountCents: Math.max(0, refunded - tipCents),
          tipCents: Math.min(tipCents, refunded),
          method: 'card', raw: charge,
        };
      }
      // Outros eventos não movem o nosso ledger — shape que nunca casa.
      throw new WebhookVerificationError(`evento ignorado: ${type}`);
    },
  };
}

module.exports = { createStripePsp, WebhookVerificationError };
