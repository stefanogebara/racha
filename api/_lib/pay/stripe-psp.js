'use strict';

/** Limites do esquema Bizum, em centavos de euro (docs.stripe.com/payments/bizum). */
const { market } = require('../markets');

const BIZUM_MIN_CENTS = 50;
const BIZUM_MAX_CENTS = 500000;

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
  // A guarda existe pra recusar uma chave PUBLICÁVEL (`pk_`) passada como
  // secreta — não pra listar todos os prefixos que a Stripe já inventou. Ela
  // recusava `rkcs_test_…`, que é o formato de chave restrita de um sandbox
  // reivindicável (achado ligando um sandbox de verdade em 2026-09-07): o
  // adaptador virava null e o caminho de cartão "não estava configurado", sem
  // dizer por quê.
  if (!secretKey || !/^(sk|rk|rkcs)_/.test(secretKey)) {
    throw new Error('createStripePsp: STRIPE_SECRET_KEY (sk_…, rk_… ou rkcs_…) é obrigatória');
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
      // O trilho REAL, não 'card' fixo. O `registerCharge` gravava 'bizum'
      // honestamente e o evento de confirmação sobrescrevia com 'card' — e o
      // log de eventos é a verdade. Isso contaminava a conciliação por método,
      // o painel e qualquer conversa de taxa com o restaurante.
      method: (pi.metadata && pi.metadata.rail)
        || ((pi.payment_method_types || [])[0] === 'bizum' ? 'bizum' : 'card'), // Apple/Google Pay web são cartões tokenizados
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
      wallet = null, payerDocument = null, applicationFeeCents = 0, currency,
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

      // A MOEDA vem do mercado, e NÃO TEM PADRÃO.
      //
      // Era `'brl'` fixo, e a revisão de compliance mandou parametrizar: como
      // `MARKETS.es.rails` inclui 'card', um cliente espanhol devendo 24,50 €
      // seria cobrado 2450 centavos de REAL na conta conectada espanhola. Pior
      // que o erro, a conciliação compararia centavos de real com cêntimos de
      // euro e reportaria 0,00 de divergência — o inegociável #8 derrotado em
      // silêncio.
      //
      // Mas parametrizar com `currency = 'brl'` de padrão consertou metade: os
      // DOIS chamadores continuaram sem passar nada, então o literal seguiu
      // valendo, agora escondido atrás de um comentário que dizia o contrário.
      // É a forma exata do inegociável #7 — a guarda que nunca dispara.
      //
      // Medido contra a Stripe (2026-09-07): uma cobrança de CARTÃO em `brl`
      // é **aceita sem reclamação**. Ninguém abaixo de nós pega isto. (No
      // Bizum o esquema pega: `currency: 'brl'` é recusado com "Payments with
      // bizum support the following currencies: eur".) Então esta linha é a
      // única defesa que existe no trilho de cartão, e por isso ela não pode
      // ter um padrão simpático.
      if (currency !== 'brl' && currency !== 'eur') {
        throw new TypeError(`createWalletCharge: moeda obrigatória e vinda do mercado, veio ${JSON.stringify(currency)}`);
      }
      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency,
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
     * Bizum — o trilho principal da Espanha.
     *
     * É um pagamento em tempo real entre contas: o pagador põe o telefone que
     * tem registrado no Bizum e autoriza **no app do banco dele**. Por isso
     * não há código copia-e-cola como no Pix e não há CPF: quem autentica é o
     * banco, e o documento do pagador nunca passa por aqui.
     *
     * Três decisões que valem comentário:
     *
     * - `payment_method_types: ['bizum']`, explícito, em vez de
     *   `automatic_payment_methods`. O automático ofereceria tudo que a conta
     *   tem habilitado, e o Express Checkout Element **não suporta Bizum** —
     *   então o front precisa do Payment Element e o intent precisa dizer qual
     *   é o trilho.
     * - `on_behalf_of: recipientId` junto do `transfer_data`. Numa destination
     *   charge sem isso, o comerciante que aparece no app do banco do cliente é
     *   a PLATAFORMA; com ele, é o restaurante. Quem cobrou tem que ser quem o
     *   cliente reconhece — e é também o que a Stripe documenta pro descritor.
     * - Os limites do esquema são conferidos AQUI, não só na tela. Um adaptador
     *   que confia no chamador é a guarda que nunca dispara (inegociável #7).
     */
    async createBizumCharge({
      chargeRef, amountCents, tipCents = 0, recipientId, applicationFeeCents = 0,
    }) {
      if (typeof recipientId !== 'string' || !/^acct_/.test(recipientId)) {
        throw new Error('stripe: conta conectada (acct_…) obrigatória — recusando custódia da plataforma');
      }
      if (typeof chargeRef !== 'string' || chargeRef.length === 0) {
        throw new TypeError('createBizumCharge: chargeRef required');
      }
      assertCents(amountCents, 'amountCents');
      assertCents(tipCents, 'tipCents');
      const total = amountCents + tipCents;
      if (total === 0) throw new TypeError('zero-value charge');
      // Limites do esquema Bizum: 0,50 € a 5.000 € por cobrança.
      if (total < BIZUM_MIN_CENTS) throw new TypeError(`bizum: abaixo do mínimo (${BIZUM_MIN_CENTS} centavos)`);
      if (total > BIZUM_MAX_CENTS) throw new TypeError(`bizum: acima do máximo (${BIZUM_MAX_CENTS} centavos)`);
      if (!Number.isSafeInteger(applicationFeeCents) || applicationFeeCents < 0 || applicationFeeCents >= total) {
        throw new TypeError('applicationFeeCents fora de [0, total)');
      }

      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency: 'eur',
        payment_method_types: ['bizum'],
        transfer_data: { destination: recipientId },
        on_behalf_of: recipientId,
        ...(applicationFeeCents > 0 ? { application_fee_amount: applicationFeeCents } : {}),
        metadata: {
          charge_ref: chargeRef.slice(0, 200),
          tip_cents: String(tipCents),
          rail: 'bizum',
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
    /**
     * `marketCode` decide o PAÍS e as capacidades. Era 'BR' fixo, e os
     * business locations do Bizum não incluem o Brasil — então nenhuma casa
     * espanhola podia ser cadastrada, e a capacidade `bizum_payments` (que
     * precisa estar ativa na plataforma E na conta conectada) nunca era nem
     * pedida. Achado da revisão de compliance.
     */
    async createConnectedAccount({ email = null, businessName = null, cnpj = null, marketCode = 'br' } = {}) {
      const m = market(marketCode);
      const country = m.code === 'es' ? 'ES' : 'BR';
      const acct = await stripe.accounts.create({
        type: 'express',
        country,
        ...(email ? { email } : {}),
        business_type: 'company',
        ...(businessName || cnpj ? {
          company: {
            ...(businessName ? { name: String(businessName).slice(0, 128) } : {}),
            ...(cnpj ? { tax_id: String(cnpj).replace(/\D/g, '') } : {}),
          },
        } : {}),
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
          // Bizum só cobra depois que a Stripe verifica o onboarding do
          // esquema; fica `pending` até lá, e sem pedir nunca sai de inativo.
          ...(m.rails.includes('bizum') ? { bizum_payments: { requested: true } } : {}),
        },
      });
      return { recipientId: acct.id, status: acct.charges_enabled ? 'active' : 'registration' };
    },

    /**
     * Link de ONBOARDING (KYC) da conta conectada — o dono abre, preenche os
     * dados bancários/KYC na hosted page da Stripe (nada disso passa por nós) e
     * volta pro admin. Expira; gera de novo se preciso.
     */
    async createAccountLink({ accountId, refreshUrl, returnUrl }) {
      if (!/^acct_/.test(accountId || '')) throw new Error('createAccountLink: accountId (acct_…) obrigatório');
      if (!refreshUrl || !returnUrl) throw new TypeError('createAccountLink: refreshUrl e returnUrl obrigatórios');
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });
      return { url: link.url };
    },

    /** Status da conta conectada — a prova de que o restaurante pode receber. */
    async getConnectedAccount(accountId) {
      if (!/^acct_/.test(accountId || '')) return null;
      let a;
      try {
        a = await stripe.accounts.retrieve(accountId);
      } catch (err) {
        if (err && (err.statusCode === 404 || err.code === 'resource_missing')) return null;
        throw err;
      }
      const chargesEnabled = a.charges_enabled === true;
      return {
        recipientId: a.id,
        chargesEnabled,
        payoutsEnabled: a.payouts_enabled === true,
        // 'active' só quando dá pra cobrar; 'pending' se enviou dados mas ainda
        // em análise; 'registration' se nem começou o onboarding.
        status: chargesEnabled ? 'active' : (a.details_submitted ? 'pending' : 'registration'),
      };
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
        // `tip_cents` é gravado no PAYMENT INTENT (ver createWalletCharge /
        // createBizumCharge), não na charge — ler da charge devolvia sempre 0 e
        // punha a gorjeta inteira em `amountCents`, nos DOIS trilhos. A charge
        // carrega o PI expandido em alguns eventos; quando não carrega,
        // buscamos. Achado da revisão de compliance.
        let tipCents = Number((charge.metadata && charge.metadata.tip_cents) || 0) || 0;
        if (!tipCents) {
          try {
            const pi = await stripe.paymentIntents.retrieve(txid);
            tipCents = Number((pi.metadata && pi.metadata.tip_cents) || 0) || 0;
          } catch { /* sem o PI, fica 0 — melhor subestimar a gorjeta que inventar */ }
        }
        const refunded = Number(charge.amount_refunded) || 0;
        return {
          kind: 'refund', txid,
          amountCents: Math.max(0, refunded - tipCents),
          tipCents: Math.min(tipCents, refunded),
          method: (charge.payment_method_details && charge.payment_method_details.type) === 'bizum'
            ? 'bizum' : 'card',
          raw: charge,
        };
      }
      // Disputa aberta. NÃO é estorno: o dinheiro fica retido enquanto o
      // esquema decide (Bizum dá 120 dias pro cliente reclamar, 40 pra prova,
      // 90 pra decisão). Vira evento de ledger sem mover saldo, e alerta.
      if (type === 'charge.dispute.created') {
        const d = event.data.object;
        const txid = d.payment_intent;
        if (typeof txid !== 'string') return { kind: 'ignored', type, raw: d };
        return {
          kind: 'dispute_opened', txid,
          amountCents: Number(d.amount) || 0,
          reason: typeof d.reason === 'string' ? d.reason : null,
          raw: d,
        };
      }
      // Disputa PERDIDA: aí sim o dinheiro foi. Vira estorno de verdade.
      if (type === 'charge.dispute.closed') {
        const d = event.data.object;
        const txid = d.payment_intent;
        if (typeof txid !== 'string' || d.status !== 'lost') {
          return { kind: 'ignored', type, raw: d };
        }
        return {
          kind: 'refund', txid,
          amountCents: Number(d.amount) || 0,
          tipCents: 0,
          method: 'dispute',
          raw: d,
        };
      }
      // Reembolso que FALHOU. O dinheiro voltou pro saldo do restaurante e o
      // cliente continua sem receber — e ninguém descobre isso sozinho. Não
      // move o ledger (o estorno não aconteceu), mas tem que gritar.
      if (type === 'refund.failed' || type === 'refund.updated') {
        const r = event.data.object;
        const txid = r.payment_intent;
        if (typeof txid !== 'string') return { kind: 'ignored', type, raw: r };
        return {
          kind: r.status === 'failed' ? 'refund_failed' : 'refund_progress',
          txid, amountCents: Number(r.amount) || 0, status: r.status || null, raw: r,
        };
      }
      // Outros eventos não movem o nosso ledger — mas ignorar é 200, não 401.
      // Antes isto lançava `WebhookVerificationError`, que a rota mapeia pra
      // 401: a Stripe reenvia, depois DESABILITA o endpoint, e aí um
      // `refund.failed` (dinheiro de volta no saldo do restaurante, cliente
      // sem reembolso) se perde junto com todo o resto. A assinatura ESTAVA
      // válida; o evento é que não nos interessa. Achado da revisão.
      return { kind: 'ignored', type, raw: event.data && event.data.object };
    },
  };
}

module.exports = { createStripePsp, WebhookVerificationError };
