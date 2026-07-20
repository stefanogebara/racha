'use strict';

/**
 * PSP webhook → check event, pure orchestration with injected I/O.
 *
 * The store is injected ({ loadEvents, appendEvent, recordPayment }) so the
 * money path is fully unit-testable and the same code runs against the memory
 * store (demo) and Supabase (prod, where appendEvent calls the
 * append_check_event RPC — serialized per check by advisory lock).
 *
 * Idempotency contract (at-least-once webhooks):
 * - same txid, same amounts   → clean no-op, do NOT append (log stays lean)
 * - same txid, DIFFERENT money → APPEND anyway: the reducer records a
 *   'divergent_txid' anomaly, reconciliation alerts. Divergence must leave a
 *   trace (review finding) — dropping it silently is how tampering hides.
 * - refunds validate against current state (never exceed the original
 *   payment) at append time; the reducer stays total as defense-in-depth.
 */

const { reduce, validateEvent, EventValidationError } = require('../checks/check-state');
const { maskPixPayload } = require('./mask');

/**
 * @param {object} deps
 * @param {(checkId: string) => Promise<Array>} deps.loadEvents  seq-ordered
 * @param {(checkId: string, type: string, payload: object) => Promise<number>} deps.appendEvent
 * @param {(payment: object) => Promise<void>} [deps.recordPayment]  payments-table upsert (masked payload)
 * @param {{ verifyAndParseWebhook: Function }} deps.psp
 * @param {(checkId: string) => Promise<{id: string}|null>} deps.findCheckByTxid
 * @param {(parsed: object) => Promise<object|null>} [deps.fallback]
 *   Tried when the txid is not a check charge (e.g. house-account loads).
 *   Returns a result object to use, or null → the unknown-txid rejection.
 */
function createWebhookHandler({ loadEvents, appendEvent, recordPayment, psp, findCheckByTxid, fallback }) {
  if (!loadEvents || !appendEvent || !psp || !findCheckByTxid) {
    throw new Error('createWebhookHandler: missing dependencies');
  }

  /**
   * @returns {Promise<{status: 'appended'|'duplicate'|'divergent_appended'|'rejected', checkId?: string, seq?: number, reason?: string}>}
   * Throws WebhookVerificationError upward (HTTP layer → 401).
   */
  return async function handlePspWebhook(rawBody, signatureHeader) {
    const parsed = psp.verifyAndParseWebhook(rawBody, signatureHeader); // throws on bad sig

    const check = await findCheckByTxid(parsed.txid);
    if (!check) {
      // Not a check charge — maybe another charge family (house-account
      // loads). The fallback owns its own idempotency/validation.
      if (fallback) {
        const alt = await fallback(parsed);
        if (alt) return alt;
      }
      // A webhook for a txid we never issued: reject loudly. Never 200 an
      // unknown money event — that is how funds disappear from ledgers.
      return { status: 'rejected', reason: `unknown txid ${parsed.txid}` };
    }

    const events = await loadEvents(check.id);
    const state = reduce(events);

    const type = parsed.kind === 'refund' ? 'PAYMENT_REFUNDED' : 'PAYMENT_CONFIRMED';
    const payload = {
      txid: parsed.txid,
      amountCents: parsed.amountCents,
      tipCents: parsed.tipCents,
      // Real method from the PSP ('card' for Apple/Google Pay) — it used to be
      // hardcoded 'pix', which would mislabel wallet money in the ledger.
      ...(type === 'PAYMENT_CONFIRMED' ? { method: parsed.method || 'pix' } : {}),
    };

    if (type === 'PAYMENT_CONFIRMED' && state && state.payments[parsed.txid]) {
      const existing = state.payments[parsed.txid];
      if (existing.amountCents === parsed.amountCents && existing.tipCents === parsed.tipCents) {
        return { status: 'duplicate', checkId: check.id }; // clean at-least-once replay
      }
      // Divergent replay: append so the anomaly is durable and alertable.
      const seq = await appendEvent(check.id, type, payload);
      return { status: 'divergent_appended', checkId: check.id, seq };
    }

    try {
      validateEvent({ type, payload }, state);
    } catch (err) {
      if (err instanceof EventValidationError) {
        // e.g. refund exceeding the payment, refund for unknown txid after a
        // check swap. Reject: PSP retries will keep failing loudly, which is
        // what we want a human to see.
        return { status: 'rejected', checkId: check.id, reason: err.message };
      }
      throw err;
    }

    const seq = await appendEvent(check.id, type, payload);
    if (recordPayment) {
      await recordPayment({
        checkId: check.id,
        txid: parsed.txid,
        amountCents: parsed.amountCents,
        tipCents: parsed.tipCents,
        kind: parsed.kind,
        pspPayloadMasked: maskPixPayload(parsed.raw), // ONLY the masked subset is storable
        confirmedAt: new Date().toISOString(),
      });
    }
    return { status: 'appended', checkId: check.id, seq };
  };
}

module.exports = { createWebhookHandler };
