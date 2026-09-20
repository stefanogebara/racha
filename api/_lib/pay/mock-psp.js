'use strict';

/**
 * Mock PSP — the reference implementation of the PSP adapter contract.
 *
 * Used by tests and the local demo (RACHA_PSP=mock). Deterministic where it
 * matters (txids derive from inputs), and it implements webhook SIGNING so
 * the verification path is exercised for real: the mock signs exactly like a
 * production PSP would (HMAC-SHA256 over the raw body), and the handler
 * verifies with a timing-safe compare. No "skip verification in dev" branch
 * exists anywhere — dev signs properly instead. (Seatable lesson: silent
 * bypasses become production behavior.)
 *
 * Adapter contract (every real PSP adapter must implement):
 *   createPixCharge({ chargeRef, amountCents, tipCents, recipientId, description })
 *     → { txid, copiaECola, expiresAt }
 *   createWalletCharge({ chargeRef, amountCents, tipCents, recipientId, wallet, paymentToken })
 *     → { txid }   (wallet: 'apple_pay' | 'google_pay' — tokenized CARD charges;
 *     the real adapter passes the wallet token to the acquirer. Mock validates
 *     the token shape and declines garbage, like a real gateway would.)
 *   verifyAndParseWebhook(rawBody, signatureHeader)
 *     → { kind: 'payment_confirmed'|'refund', txid, amountCents, tipCents, method, raw }
 *     (throws WebhookVerificationError on bad signature/shape; method defaults
 *     to 'pix' for backward compatibility with older webhook bodies)
 */

const crypto = require('crypto');

class WebhookVerificationError extends Error {
  // name explícito: o router mapeia por err.name → 401 (subclasse de Error
  // sozinha ficaria 'Error' e viraria 500).
  // code explícito: sem ele o `errorBody` deixa a MENSAGEM viajar, e a
  // mensagem de uma falha de assinatura é um oráculo. Ver os adaptadores reais.
  constructor(message) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = 'webhook_invalid';
  }
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  }
}

class MockPsp {
  /** As moedas que o mock atende. Ver `currencies` no Pagar.me. */
  get currencies() { return ['brl', 'eur']; }

  get provider() { return 'mock'; }

  /** dinheiro de mentira: nada é capturado em lugar nenhum */
  get walletCaptures() { return false; }

  /** @param {{webhookSecret: string}} opts */
  constructor({ webhookSecret }) {
    if (!webhookSecret || webhookSecret.length < 16) {
      throw new Error('MockPsp requires a webhookSecret (>=16 chars) — no unsigned webhooks, even in dev');
    }
    this.webhookSecret = webhookSecret;
    // Charge registry: mirrors the gateway's own record so getCharge() can
    // answer "was this paid?" — the input the active reconciler needs when a
    // webhook goes missing. A real adapter reads this from the PSP API.
    this.charges = new Map(); // txid → { txid, amountCents, tipCents, method, status }
  }

  /**
   * Create a Pix cobrança. Refuses to create a charge without a settlement
   * recipient — funds must never default to the platform account
   * (BACEN Res. 494 custody perimeter; fintech-compliance rule).
   */
  async createPixCharge({ chargeRef, amountCents, tipCents = 0, recipientId, description = '' }) {
    if (typeof recipientId !== 'string' || recipientId.length === 0) {
      throw new Error('createPixCharge: recipientId is required — refusing platform-custody charge');
    }
    if (typeof chargeRef !== 'string' || chargeRef.length === 0) {
      throw new TypeError('createPixCharge: chargeRef required');
    }
    assertCents(amountCents, 'amountCents');
    assertCents(tipCents, 'tipCents');
    if (amountCents + tipCents === 0) throw new TypeError('zero-value charge');

    const txid = 'mock' + crypto
      .createHash('sha256')
      .update(`${chargeRef}|${amountCents}|${tipCents}|${recipientId}`)
      .digest('hex')
      .slice(0, 28);
    // Shape mimics a BR Code (Pix copia-e-cola) enough for UI work.
    const copiaECola = `00020126580014br.gov.bcb.pix${txid}5204000053039865406${((amountCents + tipCents) / 100).toFixed(2)}5802BR6009Sao Paulo${description.slice(0, 20)}6304MOCK`;
    this.charges.set(txid, { txid, amountCents, tipCents, method: 'pix', status: 'pending' });
    return {
      txid,
      copiaECola,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  /**
   * Bizum, simulated. Same shape as the real Stripe rail minus the Element:
   * there is no copy-and-paste code, because Bizum has none — the payer
   * authorises in their bank app. So the mock returns a txid and nothing to
   * copy, and the demo's "confirm" button plays the bank.
   *
   * It exists for the same reason `createPixCharge` does: the demo has to be
   * clickable end to end without a PSP key (decision #12 — MockTransport is a
   * production mode, not a stub). A Spanish table with no way to pay is a
   * screen nobody can review.
   */
  async createBizumCharge({ chargeRef, amountCents, tipCents = 0, recipientId }) {
    if (typeof recipientId !== 'string' || recipientId.length === 0) {
      throw new Error('createBizumCharge: recipientId is required — refusing platform-custody charge');
    }
    if (typeof chargeRef !== 'string' || chargeRef.length === 0) {
      throw new TypeError('createBizumCharge: chargeRef required');
    }
    assertCents(amountCents, 'amountCents');
    assertCents(tipCents, 'tipCents');
    const total = amountCents + tipCents;
    if (total === 0) throw new TypeError('zero-value charge');
    // Os limites do esquema também aqui: um mock que aceita o que o real
    // recusa ensina o fluxo errado a quem está desenvolvendo.
    if (total < 50) throw new TypeError('bizum: abaixo do mínimo (50 centavos)');
    if (total > 500000) throw new TypeError('bizum: acima do máximo (500000 centavos)');

    const txid = 'mockbz' + crypto
      .createHash('sha256')
      .update(`${chargeRef}|${amountCents}|${tipCents}|${recipientId}`)
      .digest('hex')
      .slice(0, 26);
    this.charges.set(txid, { txid, amountCents, tipCents, method: 'bizum', status: 'pending' });
    // `copiaECola: null` de propósito: o Bizum não tem código pra copiar, e
    // devolver um string vazio faria a tela desenhar uma caixa vazia.
    return { txid, copiaECola: null, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
  }

  /**
   * Tokenized card charge via wallet (Apple Pay / Google Pay). The token came
   * from the device's payment sheet; a real adapter forwards it to the
   * acquirer. The mock enforces the same gates a gateway would: recipient
   * required (no platform custody), token shape validated — a malformed token
   * is DECLINED loudly, never absorbed.
   */
  async createWalletCharge({ chargeRef, amountCents, tipCents = 0, recipientId, wallet, paymentToken, currency }) {
    // O mock atende as duas moedas e GUARDA a que recebeu, pra que um teste
    // possa afirmar sobre ela. Um mock que ignora um parâmetro faz o teste
    // passar exatamente onde a produção erra — foi assim que a correção de
    // moeda do mercado ficou um no-op sem nenhum teste vermelho.
    //
    // E a moeda NÃO tem padrão aqui, pelo mesmo motivo, um nível abaixo: com
    // `= 'brl'`, um chamador novo que esquecesse o argumento passaria nos
    // testes e estouraria em produção contra a Stripe, que não tem padrão.
    // Um dublê mais permissivo que a produção é uma armadilha, não um dublê.
    if (currency !== 'brl' && currency !== 'eur') {
      throw new TypeError(`mock: moeda obrigatória, veio ${JSON.stringify(currency)}`);
    }
    this.lastCurrency = currency;
    if (typeof recipientId !== 'string' || recipientId.length === 0) {
      throw new Error('createWalletCharge: recipientId is required — refusing platform-custody charge');
    }
    if (typeof chargeRef !== 'string' || chargeRef.length === 0) {
      throw new TypeError('createWalletCharge: chargeRef required');
    }
    if (!['apple_pay', 'google_pay'].includes(wallet)) {
      throw new TypeError(`createWalletCharge: unknown wallet ${wallet}`);
    }
    assertCents(amountCents, 'amountCents');
    assertCents(tipCents, 'tipCents');
    if (amountCents + tipCents === 0) throw new TypeError('zero-value charge');
    if (typeof paymentToken !== 'string' || !/^tok_[A-Za-z0-9_-]{8,}$/.test(paymentToken)) {
      const err = new Error('cartão recusado — token de pagamento inválido');
      err.statusCode = 402; // decline, not a server error
      /**
       * `card_token_invalid`, igual ao adaptador real — esta é uma recusa
       * NOSSA, de formato de token, antes de qualquer emissor ver nada.
       *
       * O mock ficou com `card_declined` quando o adaptador real foi renomeado,
       * e os dois passaram a discordar na única semântica de que o aceite de
       * produção depende: ele exige `card_declined` como prova de que um
       * emissor negou. Com a discordância, apontar o script pra um deploy de
       * PREVIEW (que roda o MockPsp, porque preview está fora de `EM_PRODUCAO`)
       * imprimia `✓ recusado como esperado` e `ACEITE OK` sem nunca falar com a
       * Pagar.me. Quarta iteração do mesmo buraco, na mesma linha.
       *
       * O comentário que estava aqui também afirmava que o mock simula recusa
       * do emissor por "CVV 6xx". A única ocorrência de `cvv` neste arquivo era
       * esse comentário: `createWalletCharge` nem recebe CVV.
       *
       * Achado pela nona revisão de compliance (2026-09-19, HIGH-3).
       */
      err.code = 'card_token_invalid';
      throw err;
    }
    const txid = 'mockw' + crypto
      .createHash('sha256')
      .update(`${chargeRef}|${amountCents}|${tipCents}|${recipientId}|${wallet}`)
      .digest('hex')
      .slice(0, 27);
    this.charges.set(txid, { txid, amountCents, tipCents, method: 'card', status: 'pending' });
    return { txid };
  }

  /** Recebedor de mentira — o admin funciona igual no demo. */
  async createRecipient({ name, document, bank }) {
    if (!name || !document || !bank) throw new TypeError('createRecipient: name, document e bank são obrigatórios');
    const id = 'rp_mock' + crypto.createHash('sha256')
      .update(`${document}|${bank.conta || ''}`).digest('hex').slice(0, 20);
    return { recipientId: id, status: 'active' };
  }

  async getRecipient(recipientId) {
    if (!/^r[ep]_/.test(recipientId || '')) return null;
    return { recipientId, status: 'active', name: 'Recebedor demo' };
  }

  /** Saldo de mentira — o painel funciona igual no demo. */
  async getRecipientBalance(recipientId) {
    if (!/^r[ep]_/.test(recipientId || '')) return null;
    return { currency: 'BRL', availableCents: 0, waitingCents: 0, transferredCents: 0 };
  }

  /**
   * Estado de uma cobrança (parity com pagarme.getCharge) — o que a
   * reconciliação ativa consulta. null pra txid desconhecida. `raw` imita o
   * shape da API real o suficiente pro maskPixPayload.
   */
  async getCharge(txid) {
    const c = this.charges.get(txid);
    if (!c) return null;
    return {
      txid: c.txid,
      // Leitura pela API não tem evento: null, e o índice parcial da 0018
      // ignora nulos. O campo existe pra ninguém esquecer de passá-lo onde há.
      eventId: null,
      status: c.status,
      paid: c.status === 'paid',
      kind: 'payment_confirmed',
      amountCents: c.amountCents,
      tipCents: c.tipCents,
      method: c.method,
      raw: {
        id: c.txid, status: c.status, amount: c.amountCents + c.tipCents,
        payment_method: c.method, metadata: { tip_cents: String(c.tipCents) },
      },
    };
  }

  /**
   * Test/demo affordance: marca a cobrança como paga NO GATEWAY sem emitir o
   * webhook — encena exatamente o buraco que a reconciliação cobre (banco
   * confirmou, o sino não tocou). Não toca o ledger; só o registro do "PSP".
   */
  settleCharge(txid) {
    const c = this.charges.get(txid);
    if (!c) throw new Error(`settleCharge: unknown txid ${txid}`);
    c.status = 'paid';
    return { txid, status: 'paid' };
  }

  /** Sign a webhook body the way the mock "PSP side" would. */
  signWebhook(rawBody) {
    return crypto.createHmac('sha256', this.webhookSecret).update(rawBody, 'utf8').digest('hex');
  }

  /** Build a signed confirmation webhook for a charge (demo/tests). */
  buildConfirmationWebhook({
    txid, amountCents, tipCents = 0, payerName = null, payerCpf = null, method = 'pix',
    eventId = null,
  }) {
    const body = JSON.stringify({
      kind: 'payment_confirmed',
      // O ID DO EVENTO. Todo PSP de verdade manda um, e é ele que fecha a
      // corrida entre duas entregas (índice único da migração 0018, que ignora
      // nulos). Um duble sem id faz TODO teste de ponta a ponta passar por
      // fora da defesa — que foi como ela chegou a produção inerte no trilho do
      // Pix. O default é determinístico pra reentrega ser reentrega.
      // O default deriva do CONTEÚDO: a mesma confirmação reentregue é o mesmo
      // evento, e uma confirmação com dinheiro DIFERENTE é outro — que é o
      // caso da "reentrega divergente", onde o razão precisa gravar a anomalia
      // em vez de dedupar em silêncio.
      eventId: eventId || `evt_mock_${txid}_confirm_${amountCents}_${tipCents}`,
      txid,
      amount: amountCents,
      tip: tipCents,
      method,
      horario: new Date().toISOString(),
      pagador: payerName || payerCpf ? { nome: payerName, cpf: payerCpf } : undefined,
    });
    return { rawBody: body, signature: this.signWebhook(body) };
  }

  /** Build a signed refund (devolução) webhook. */
  buildRefundWebhook({ txid, amountCents, tipCents = 0, eventId = null }) {
    const body = JSON.stringify({
      kind: 'refund', txid, amount: amountCents, tip: tipCents,
      eventId: eventId || `evt_mock_${txid}_refund_${amountCents}_${tipCents}`,
      horario: new Date().toISOString(),
    });
    return { rawBody: body, signature: this.signWebhook(body) };
  }

  /**
   * Verify + parse an incoming webhook. Timing-safe signature check FIRST;
   * only then is the body parsed. Throws WebhookVerificationError — the HTTP
   * layer maps it to 401 and never processes the body.
   */
  verifyAndParseWebhook(rawBody, signatureOrHeaders) {
    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      throw new WebhookVerificationError('empty webhook body');
    }
    // Aceita o header cru (testes) OU o objeto req.headers (router).
    const signatureHeader = typeof signatureOrHeaders === 'object' && signatureOrHeaders !== null
      ? signatureOrHeaders['x-racha-signature']
      : signatureOrHeaders;
    if (typeof signatureHeader !== 'string' || !/^[a-f0-9]{64}$/i.test(signatureHeader)) {
      throw new WebhookVerificationError('missing/malformed signature');
    }
    const expected = this.signWebhook(rawBody);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHeader, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new WebhookVerificationError('signature mismatch');
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError('body is not JSON');
    }
    const { kind, txid } = parsed;
    if (!['payment_confirmed', 'refund'].includes(kind)) {
      throw new WebhookVerificationError(`unknown webhook kind: ${kind}`);
    }
    if (typeof txid !== 'string' || txid.length === 0) {
      throw new WebhookVerificationError('webhook missing txid');
    }
    const amountCents = parsed.amount;
    const tipCents = parsed.tip ?? 0;
    assertCents(amountCents, 'webhook amount');
    assertCents(tipCents, 'webhook tip');
    // 'card' covers wallet charges (Apple/Google Pay are tokenized cards).
    const method = parsed.method === 'card' ? 'card' : 'pix';
    const eventId = typeof parsed.eventId === 'string' && parsed.eventId ? parsed.eventId : null;
    return { kind, txid, amountCents, tipCents, method, eventId, raw: parsed };
  }
}

module.exports = { MockPsp, WebhookVerificationError };
