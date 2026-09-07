'use strict';

/**
 * Pagar.me (Stone) — o PSP real do Racha. Implementa o MESMO contrato do
 * MockPsp (create-charge/webhook-handler não sabem qual PSP está atrás):
 *
 *   createPixCharge({ chargeRef, amountCents, tipCents, recipientId, description })
 *     → { txid, copiaECola, expiresAt }
 *   createWalletCharge({ chargeRef, amountCents, tipCents, recipientId, wallet, paymentToken })
 *     → { txid }
 *   verifyAndParseWebhook(rawBody, signatureOrHeaders)
 *     → Promise<{ kind, txid, amountCents, tipCents, method, raw }>
 *
 * Decisões de segurança:
 * - O webhook do Pagar.me v5 NÃO tem assinatura HMAC. Nunca confiamos no
 *   corpo: extraímos o charge id e RE-BUSCAMOS a cobrança na API com a
 *   secret key — a API é a verdade, o webhook é só um sino. Opcionalmente
 *   validamos o Basic Auth configurado no endpoint (PAGARME_WEBHOOK_AUTH).
 * - Split SEMPRE presente com o recebedor do restaurante (rp_...) — dinheiro
 *   nunca para na conta da plataforma (BACEN Res. 494). O restaurante é o
 *   merchant of record do seu recebedor.
 * - Gorjeta viaja na MESMA cobrança (total = consumo + serviço) e fica
 *   separada via metadata.tip_cents — o ledger lê de lá (Lei 13.419).
 *
 * Campos batem com docs.pagar.me core/v5 (orders); a ativação em test mode
 * valida na prática (checklist em docs/psp/README.md).
 */

const BASE_URL = 'https://api.pagar.me/core/v5';

class WebhookVerificationError extends Error {
  constructor(message) { super(message); this.name = 'WebhookVerificationError'; }
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  }
}

function createPagarmePsp({
  secretKey,
  webhookBasicAuth = null,
  fetchImpl = fetch,
  // Escape hatch SÓ DE TESTE: contas novas têm o Split desabilitado até o
  // suporte liberar (não dá nem pra criar recebedor). Com este flag E chave
  // sk_test_, cobranças sem rp_ saem SEM split (caem no saldo da conta de
  // teste) pra bateria de aceite rodar. Com sk_live_ o flag é IGNORADO —
  // a regra de custódia (split obrigatório) é absoluta em produção.
  allowNoSplitInTest = process.env.PAGARME_ALLOW_NO_SPLIT === 'true',
} = {}) {
  if (!secretKey || !/^sk_/.test(secretKey)) {
    throw new Error('createPagarmePsp: PAGARME_SECRET_KEY (sk_...) é obrigatória');
  }
  const isTestKey = /^sk_test_/.test(secretKey);
  const noSplitOk = allowNoSplitInTest && isTestKey;
  const authHeader = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

  async function api(method, path, body, timeoutMs = 15000) {
    let res;
    try {
      res = await fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        // Um gateway pendurado nunca pode pendurar o chamador (o confirm-on-read
        // roda no /api/check público). Timeout → 502 (transitório), jamais 4xx.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (netErr) {
      const e = new Error(`pagarme ${method} ${path}: ${netErr.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : netErr.message}`);
      e.statusCode = 502;
      e.httpStatus = 0; // rede/timeout — nunca "recusa" nem "inexistente"
      throw e;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const msg = (json && (json.message || JSON.stringify(json.errors || json))) || `HTTP ${res.status}`;
      const err = new Error(`pagarme ${method} ${path}: ${msg}`);
      // 4xx do gateway em cobrança = recusa (402 pro diner), não bug nosso.
      err.statusCode = res.status >= 400 && res.status < 500 ? 402 : 502;
      err.httpStatus = res.status; // status exato — getCharge precisa separar 404 de 401/403
      throw err;
    }
    return json;
  }

  /** Corpo comum do pedido: total = consumo + gorjeta, split integral pro venue. */
  function baseOrder({ chargeRef, amountCents, tipCents, recipientId, description, payerDocument = null }) {
    // Pagar.me devolve o id do recebedor com prefixo re_ (confirmado na API,
    // 21/07); rp_ é aceito também por causa do mock e de venues legados.
    const hasRecipient = typeof recipientId === 'string' && /^r[ep]_/.test(recipientId);
    if (!hasRecipient && !noSplitOk) {
      throw new Error('pagarme: recipientId (re_...) é obrigatório — recusando cobrança de custódia da plataforma');
    }
    assertCents(amountCents, 'amountCents');
    assertCents(tipCents, 'tipCents');
    const total = amountCents + tipCents;
    if (total === 0) throw new TypeError('zero-value charge');
    return {
      code: chargeRef.slice(0, 64),
      items: [{ description: (description || 'Racha').slice(0, 64), amount: total, quantity: 1, code: 'racha' }],
      // O gateway exige documento e telefone do pagador ("The customer
      // Document/phone is required") — em cartão E em Pix: a doc lista
      // name/email/document/phones como obrigatórios pro Pix
      // (docs.pagar.me/reference/pix-2, conferido 2026-09-07). Por isso o
      // checkout pede CPF nos dois trilhos, e não é coleta a mais. O telefone
      // é placeholder da plataforma por ora — se o modo LIVE exigir o real, o
      // checkout ganha o campo (decisão anotada no runbook).
      customer: {
        name: 'Cliente Racha', type: 'individual',
        // E-mail único por cobrança: o gateway deduplica customer por e-mail
        // e reutiliza o registro antigo (sem telefone/documento) — cada
        // cobrança leva o snapshot completo.
        email: `cliente+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@racha.app`,
        ...(payerDocument ? { document: payerDocument } : {}),
        phones: { mobile_phone: { country_code: '55', area_code: '11', number: '987654321' } },
      },
      metadata: {
        charge_ref: chargeRef,
        tip_cents: String(tipCents),
        ...(hasRecipient ? {} : { split_mode: 'none_test' }), // rastreável no extrato
      },
      // 100% pro recebedor do restaurante; taxas do gateway saem dele
      // (repasse comercial é assunto do contrato, não do fluxo de fundos).
      ...(hasRecipient ? {
        split: [{
          recipient_id: recipientId,
          amount: total,
          type: 'flat',
          options: { charge_processing_fee: true, charge_remainder_fee: true, liable: true },
        }],
      } : {}),
    };
  }

  return {
    provider: 'pagarme',
    /**
     * As moedas que este adquirente atende. Declarado, não suposto.
     *
     * O portão de dinheiro compartilhado confere isto antes de chamar: sem a
     * declaração, `createWalletCharge` recebia `currency` e IGNORAVA (não
     * estava nem no destructuring), então a correção de moeda do mercado era
     * um no-op no PSP de produção — achado da revisão de compliance de
     * 2026-09-07. Uma mesa espanhola no trilho de carteira viraria uma ordem
     * Pagar.me em REAL.
     */
    currencies: Object.freeze(['brl']),

    async createPixCharge({ chargeRef, amountCents, tipCents = 0, recipientId, description = '', payerDocument = null }) {
      const order = await api('POST', '/orders', {
        ...baseOrder({ chargeRef, amountCents, tipCents, recipientId, description, payerDocument }),
        payments: [{
          payment_method: 'pix',
          pix: { expires_in: 900 }, // 15 min, igual ao mock
        }],
      });
      const charge = order.charges && order.charges[0];
      const tx = (charge && charge.last_transaction) || {};
      if (!charge || !tx.qr_code) {
        // O motivo real (ex.: Pix não habilitado na conta) mora no
        // gateway_response — sem ele o erro é inacionável.
        const gw = tx.gateway_response || {};
        const reason = (Array.isArray(gw.errors) && gw.errors.map((e) => e.message || e).join('; '))
          || gw.code || tx.status || (charge && charge.status) || 'sem detalhe';
        throw new Error(`pagarme: cobrança Pix sem qr_code (${String(reason).slice(0, 140)})`);
      }
      return {
        txid: charge.id, // ch_... — chave de idempotência do webhook
        copiaECola: tx.qr_code,
        expiresAt: tx.expires_at || new Date(Date.now() + 900 * 1000).toISOString(),
      };
    },

    async createWalletCharge({ chargeRef, amountCents, tipCents = 0, recipientId, wallet, paymentToken, payerDocument = null, currency = 'brl' }) {
      // Defesa em profundidade, do mesmo tipo da do adaptador da Stripe: o
      // portão compartilhado já confere `currencies`, e ainda assim quem emite
      // recusa uma moeda que não sabe emitir. O que este `if` pega é o
      // chamador NOVO que não passou pelo portão.
      if (currency !== 'brl') {
        throw new TypeError(`pagarme: moeda não atendida ${JSON.stringify(currency)} — este adquirente é BRL`);
      }
      if (!['apple_pay', 'google_pay'].includes(wallet)) {
        throw new TypeError(`createWalletCharge: unknown wallet ${wallet}`);
      }
      if (typeof paymentToken !== 'string' || paymentToken.length < 8) {
        const err = new Error('cartão recusado — token de pagamento inválido');
        err.statusCode = 402;
        throw err;
      }
      const order = await api('POST', '/orders', {
        ...baseOrder({ chargeRef, amountCents, tipCents, recipientId, description: `Racha ${wallet}`, payerDocument }),
        payments: [{
          payment_method: 'credit_card',
          credit_card: {
            installments: 1,
            statement_descriptor: 'RACHA',
            // Token do Google Pay via gateway tokenization (docs: Google Pay™
            // guide — gatewayMerchantId = acc_...). Apple Pay: fase 2.
            card_token: paymentToken,
            // billing_address é obrigatório em cartão; o diner não digita
            // endereço na mesa — vai o do estabelecimento (é onde a compra
            // acontece de fato). Se o antifraude LIVE exigir o do titular,
            // o checkout ganha o campo (runbook).
            card: {
              billing_address: {
                line_1: 'Av. Paulista, 1000',
                zip_code: '01310100',
                city: 'São Paulo',
                state: 'SP',
                country: 'BR',
              },
            },
          },
        }],
      });
      const charge = order.charges && order.charges[0];
      if (!charge) throw new Error('pagarme: resposta sem charge — cobrança de cartão não criada');
      const status = charge.status;
      if (status === 'failed' || status === 'canceled') {
        // O motivo real do gateway vai no erro — "recusado" seco não ajuda
        // nem o diner nem o debug (acquirer_message/gateway_response).
        const tx = charge.last_transaction || {};
        const gw = tx.gateway_response || {};
        const reason = tx.acquirer_message
          || (Array.isArray(gw.errors) && gw.errors.map((e) => e.message || e).join('; '))
          || gw.code || tx.status || status;
        const err = new Error(`cartão recusado (${String(reason).slice(0, 140)})`);
        err.statusCode = 402;
        throw err;
      }
      return { txid: charge.id };
    },

    /**
     * Cria o recebedor do restaurante (o passo com LATÊNCIA do onboarding —
     * análise KYC do Pagar.me). Exige a conta em modo marketplace (senão o
     * gateway recusa: "verifique a configuração da funcionalidade Split").
     * Dados vêm do formulário do DONO no admin; nada é inventado aqui.
     */
    async createRecipient({ name, email, document, type = 'individual', bank }) {
      if (!name || !document || !bank) throw new TypeError('createRecipient: name, document e bank são obrigatórios');
      const digits = String(document).replace(/\D/g, '');
      const body = {
        name: String(name).slice(0, 128),
        email: email || undefined,
        document: digits,
        type: digits.length === 14 ? 'company' : (type || 'individual'),
        default_bank_account: {
          holder_name: String(bank.holderName || name).slice(0, 30),
          holder_type: digits.length === 14 ? 'company' : 'individual',
          holder_document: digits,
          bank: String(bank.code),
          branch_number: String(bank.agencia),
          ...(bank.agenciaDv ? { branch_check_digit: String(bank.agenciaDv) } : {}),
          account_number: String(bank.conta),
          account_check_digit: String(bank.contaDv),
          type: bank.type === 'savings' ? 'savings' : 'checking',
        },
        // Repasse automático diário — o "nunca atrasaram o repasse" da Meep
        // é argumento de venda; D+1 automático é o nosso.
        transfer_settings: { transfer_enabled: true, transfer_interval: 'Daily', transfer_day: 0 },
      };
      const r = await api('POST', '/recipients', body);
      if (!r || !/^r[ep]_/.test(r.id || '')) throw new Error('pagarme: resposta sem id de recebedor (re_...) — não criado');
      return { recipientId: r.id, status: r.status || 'registration' };
    },

    /** Status atual do recebedor (análise KYC: registration → active). */
    async getRecipient(recipientId) {
      if (!/^r[ep]_/.test(recipientId || '')) return null;
      const r = await api('GET', `/recipients/${recipientId}`);
      return { recipientId: r.id, status: r.status, name: r.name };
    },

    /**
     * Saldo do recebedor — a PROVA do repasse do split. Um pagamento dividido
     * pinga aqui (waiting_funds → available conforme liquida). Valores em
     * centavos, direto da API. Read-only; o dono vê "quanto já caiu".
     */
    async getRecipientBalance(recipientId) {
      if (!/^r[ep]_/.test(recipientId || '')) return null;
      const r = await api('GET', `/recipients/${recipientId}/balance`);
      return {
        currency: r.currency || 'BRL',
        availableCents: Number(r.available_amount ?? 0) || 0,
        waitingCents: Number(r.waiting_funds_amount ?? 0) || 0,
        transferredCents: Number(r.transferred_amount ?? 0) || 0,
      };
    },

    /**
     * Estado atual de UMA cobrança, direto da API (a mesma verdade que o
     * webhook consulta). Usado pela reconciliação ativa: quando o webhook não
     * chega (best-effort), o servidor re-pergunta "essa cobrança foi paga?" e
     * confirma a que já está `paid`. Retorna null pra id fora do padrão ou 4xx
     * (cobrança inexistente/não-acionável); relança 5xx pra retry no próximo
     * tick — um soluço do gateway não pode virar "não pago".
     * @returns {Promise<null|{txid,status,paid,kind,amountCents,tipCents,method,raw}>}
     */
    async getCharge(chargeId) {
      if (typeof chargeId !== 'string' || !/^ch_/.test(chargeId)) return null;
      let charge;
      try {
        charge = await api('GET', `/charges/${chargeId}`, null, 4000);
      } catch (err) {
        // SÓ 404 (cobrança inexistente/estranha) vira null e é pulada. 401/403
        // (chave revogada), 422, 5xx e timeout RELANÇAM — a reconciliação
        // contabiliza como erro e o cron alerta. Engolir um 4xx de auth como
        // "desconhecida" derrubaria a rede de segurança inteira sem sinal.
        if (err.httpStatus === 404) return null;
        throw err;
      }
      if (!charge || !charge.id) return null;
      const totalCents = charge.amount;
      const tipCents = Number((charge.metadata && charge.metadata.tip_cents) || 0) || 0;
      const amountCents = Math.max(0, totalCents - tipCents);
      const method = charge.payment_method === 'pix' ? 'pix' : 'card';
      return {
        txid: charge.id,
        status: charge.status,
        paid: charge.status === 'paid',
        kind: 'payment_confirmed',
        amountCents, tipCents, method,
        raw: charge,
      };
    },

    /**
     * Webhook: valida o Basic Auth do endpoint (se configurado) e RE-BUSCA a
     * cobrança na API — o corpo do POST nunca é a fonte de verdade.
     */
    async verifyAndParseWebhook(rawBody, signatureOrHeaders) {
      if (webhookBasicAuth) {
        const headers = (signatureOrHeaders && typeof signatureOrHeaders === 'object')
          ? signatureOrHeaders : {};
        const got = headers.authorization || headers.Authorization || '';
        const want = `Basic ${Buffer.from(webhookBasicAuth).toString('base64')}`;
        if (got !== want) throw new WebhookVerificationError('webhook basic auth mismatch');
      }
      let event;
      try { event = JSON.parse(rawBody); } catch {
        throw new WebhookVerificationError('body is not JSON');
      }
      const type = event && event.type; // ex.: charge.paid, charge.refunded
      const chargeId = event && event.data && (event.data.id || (event.data.charge && event.data.charge.id));
      if (!type || typeof chargeId !== 'string' || !/^ch_/.test(chargeId)) {
        throw new WebhookVerificationError(`webhook sem charge id (type=${type})`);
      }
      if (!/^charge\.(paid|refunded|partial_canceled)$/.test(type)) {
        // Outros eventos (order.*, charge.created...) não movem dinheiro no
        // nosso ledger — o handler rejeita txids desconhecidos, então
        // devolvemos um shape que nunca casa.
        throw new WebhookVerificationError(`evento ignorado: ${type}`);
      }

      // A VERDADE: estado atual da cobrança direto da API.
      const charge = await api('GET', `/charges/${chargeId}`);
      const totalCents = charge.amount;
      const tipCents = Number((charge.metadata && charge.metadata.tip_cents) || 0) || 0;
      const amountCents = Math.max(0, totalCents - tipCents);
      const method = charge.payment_method === 'pix' ? 'pix' : 'card';

      if (type === 'charge.paid') {
        if (charge.status !== 'paid') {
          throw new WebhookVerificationError(`webhook diz paid mas API diz ${charge.status}`);
        }
        return { kind: 'payment_confirmed', txid: charge.id, amountCents, tipCents, method, raw: charge };
      }
      // Reembolso: v1 trata reembolso TOTAL (parciais entram no checklist de
      // ativação — exigem mapear canceled_amount por transação).
      return { kind: 'refund', txid: charge.id, amountCents, tipCents, method, raw: charge };
    },
  };
}

module.exports = { createPagarmePsp, WebhookVerificationError };
