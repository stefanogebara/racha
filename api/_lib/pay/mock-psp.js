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
 *   verifyAndParseWebhook(rawBody, signatureHeader)
 *     → { kind: 'payment_confirmed'|'refund', txid, amountCents, tipCents, raw }
 *     (throws WebhookVerificationError on bad signature/shape)
 */

const crypto = require('crypto');

class WebhookVerificationError extends Error {}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  }
}

class MockPsp {
  /** @param {{webhookSecret: string}} opts */
  constructor({ webhookSecret }) {
    if (!webhookSecret || webhookSecret.length < 16) {
      throw new Error('MockPsp requires a webhookSecret (>=16 chars) — no unsigned webhooks, even in dev');
    }
    this.webhookSecret = webhookSecret;
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
    return {
      txid,
      copiaECola,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  /** Sign a webhook body the way the mock "PSP side" would. */
  signWebhook(rawBody) {
    return crypto.createHmac('sha256', this.webhookSecret).update(rawBody, 'utf8').digest('hex');
  }

  /** Build a signed confirmation webhook for a charge (demo/tests). */
  buildConfirmationWebhook({ txid, amountCents, tipCents = 0, payerName = null, payerCpf = null }) {
    const body = JSON.stringify({
      kind: 'payment_confirmed',
      txid,
      amount: amountCents,
      tip: tipCents,
      horario: new Date().toISOString(),
      pagador: payerName || payerCpf ? { nome: payerName, cpf: payerCpf } : undefined,
    });
    return { rawBody: body, signature: this.signWebhook(body) };
  }

  /** Build a signed refund (devolução) webhook. */
  buildRefundWebhook({ txid, amountCents, tipCents = 0 }) {
    const body = JSON.stringify({
      kind: 'refund', txid, amount: amountCents, tip: tipCents,
      horario: new Date().toISOString(),
    });
    return { rawBody: body, signature: this.signWebhook(body) };
  }

  /**
   * Verify + parse an incoming webhook. Timing-safe signature check FIRST;
   * only then is the body parsed. Throws WebhookVerificationError — the HTTP
   * layer maps it to 401 and never processes the body.
   */
  verifyAndParseWebhook(rawBody, signatureHeader) {
    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      throw new WebhookVerificationError('empty webhook body');
    }
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
    return { kind, txid, amountCents, tipCents, raw: parsed };
  }
}

module.exports = { MockPsp, WebhookVerificationError };
