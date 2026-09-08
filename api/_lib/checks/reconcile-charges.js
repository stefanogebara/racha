'use strict';

/**
 * Active charge reconciliation — the safety net for missed webhooks.
 *
 * Webhooks are best-effort: they can be dropped, mis-delivered, or rejected by
 * a config mismatch (a live/test endpoint gap, a Basic Auth typo). A money
 * system must NEVER depend solely on a webhook arriving. This reconciler is
 * the guaranteed path: it re-asks the PSP "was this charge paid?" for charges
 * still pending in our ledger, and confirms the ones the gateway reports paid.
 *
 * The confirmation itself goes through the SAME `confirm` function the webhook
 * uses (applyConfirmedPayment), so a poll-confirmed payment is byte-identical
 * to a webhook-confirmed one — same idempotency (a duplicate is a clean
 * no-op), same event-sourcing. One code path for money.
 *
 * Trigger points (both call this):
 *  - confirm-on-read: the diner's /api/check poll heals its own check;
 *  - a low-frequency cron: the backstop for checks nobody is watching.
 *
 * TOTAL over a sweep: a single charge failing (transient PSP 5xx, a DB hiccup)
 * is recorded and skipped — it never aborts the batch or throws.
 */

const DEFAULT_GRACE_MS = 20_000;                   // give the webhook first crack
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;     // a paid-but-unconfirmed charge stays healable for a day
const DEFAULT_LIMIT = 50;

// Gateway states that mean "this charge will never be paid" — distinct from a
// Pix still waiting for the diner. Surfaced separately so they don't hide in
// the "stillPending" bucket and vanish after the window.
const TERMINAL_UNPAID = new Set(['canceled', 'failed', 'refunded', 'chargedback', 'voided', 'overpaid']);

/**
 * `requires_payment_method` é ambíguo, e por isso não está na lista acima.
 *
 * Na Stripe ele é o estado INICIAL de um intent recém-criado E o estado em que
 * um intent volta a cair quando o pagador recusa. Pôr na lista marcaria toda
 * cobrança recém-criada como terminal; deixar de fora conta uma recusa como
 * "ainda esperando" até a cobrança sair da janela, em silêncio.
 *
 * O que separa os dois é `attempted` (ver `parseIntent`): um erro de pagamento
 * ou uma cobrança existindo. Alguém TENTOU e não deu.
 *
 * Isso importa no Bizum mais que em qualquer outro trilho, porque quem recusa
 * recusa no app do banco e nada nos avisa — o adaptador nem interpreta
 * `payment_intent.payment_failed`. A conciliação é o único lugar que descobre.
 */
function isTerminalUnpaid(info) {
  if (TERMINAL_UNPAID.has(info.status)) return true;
  return info.status === 'requires_payment_method' && info.attempted === true;
}

/**
 * @param {object} deps
 * @param {{ listPendingCharges: Function }} deps.store
 * @param {{ getCharge?: Function }} deps.psp
 * @param {(parsed:object)=>Promise<{status:string, checkId?:string}>} deps.confirm
 *   Bound applyConfirmedPayment (store I/O already injected by the caller).
 */
function createChargeReconciler({ store, psp, confirm }) {
  if (!store || !psp || typeof confirm !== 'function') {
    throw new Error('createChargeReconciler: missing dependencies');
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.checkId]   scope to one check (confirm-on-read)
   * @param {number} [opts.graceMs]   ignore charges younger than this
   * @param {number} [opts.windowMs]  ignore charges older than this
   * @param {number} [opts.limit]
   */
  async function reconcile({
    checkId = null,
    graceMs = DEFAULT_GRACE_MS,
    windowMs = DEFAULT_WINDOW_MS,
    limit = DEFAULT_LIMIT,
  } = {}) {
    // A PSP without getCharge (mock w/o support, or the 503 fallback) can't be
    // polled — nothing to do, and never throw (this runs on the read path).
    if (typeof psp.getCharge !== 'function') {
      return { checked: 0, confirmed: 0, stillPending: 0, terminal: 0, unknown: 0, errors: 0, details: [], note: 'psp sem getCharge' };
    }

    let pending;
    try {
      pending = await store.listPendingCharges({ checkId, graceMs, windowMs, limit });
    } catch (err) {
      return { checked: 0, confirmed: 0, stillPending: 0, terminal: 0, unknown: 0, errors: 1, details: [{ error: `list: ${String(err.message).slice(0, 120)}` }] };
    }

    let confirmed = 0;
    let stillPending = 0;
    let terminal = 0;
    let unknown = 0;
    let errors = 0;
    const details = [];

    for (const p of pending) {
      try {
        const info = await psp.getCharge(p.txid);
        if (!info) { unknown += 1; continue; }       // not this PSP's charge (mock/house/gone)
        if (!info.paid) {
          // A charge the gateway settled as canceled/failed/refunded before we
          // ever confirmed it is NOT a normal "still awaiting Pix" — surface it
          // separately so it's visible, not silently dropped after windowMs.
          if (isTerminalUnpaid(info)) {
            terminal += 1;
            details.push({ txid: p.txid, checkId: p.checkId, status: `psp:${info.status}` });
          } else {
            stillPending += 1;
          }
          continue;
        }
        const res = await confirm({
          kind: 'payment_confirmed',
          txid: info.txid,
          amountCents: info.amountCents,
          tipCents: info.tipCents,
          method: info.method,
          raw: info.raw,
        });
        if (res.status === 'appended' || res.status === 'divergent_appended') {
          confirmed += 1;
        }
        details.push({ txid: p.txid, checkId: res.checkId || p.checkId, status: res.status });
      } catch (err) {
        errors += 1;
        details.push({ txid: p.txid, error: String(err.message).slice(0, 120) });
      }
    }

    return { checked: pending.length, confirmed, stillPending, terminal, unknown, errors, details };
  }

  return { reconcile };
}

module.exports = { createChargeReconciler, DEFAULT_GRACE_MS, DEFAULT_WINDOW_MS };
