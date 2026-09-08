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
 *
 * `applyConfirmedPayment` is the SHARED confirmation core: it takes an already
 * verified/parsed charge and folds it into the ledger. Both the webhook
 * handler (verify → apply) and the active reconciler (re-fetch → apply) call
 * it, so a payment confirmed by a POLL is byte-identical to one confirmed by a
 * webhook — same idempotency, same event-sourcing, one code path for money.
 */

const { reduce, validateEvent, EventValidationError } = require('../checks/check-state');
const { maskPixPayload } = require('./mask');

/**
 * Fold a verified+parsed PSP charge into the check ledger. Pure orchestration
 * over injected I/O; safe to call more than once for the same txid — the
 * reducer is idempotent by txid, so a retried webhook OR a webhook-vs-reconcile
 * race can never double-count money (paidCents/tipCents). The "already seen"
 * check reads state BEFORE the per-check append lock, so an exact-simultaneous
 * race could append a second identical PAYMENT_CONFIRMED row: harmless to money
 * (reduce() collapses it) and to the drift canary, just a duplicate log row.
 *
 * @param {{kind:string, txid:string, amountCents:number, tipCents:number, method?:string, raw?:any}} parsed
 * @param {object} deps
 * @param {(checkId:string)=>Promise<Array>} deps.loadEvents
 * @param {(checkId:string, type:string, payload:object)=>Promise<number>} deps.appendEvent
 * @param {(payment:object)=>Promise<void>} [deps.recordPayment]
 * @param {(txid:string)=>Promise<{id:string}|null>} deps.findCheckByTxid
 * @param {(parsed:object)=>Promise<object|null>} [deps.fallback]
 * @returns {Promise<{status:'appended'|'duplicate'|'divergent_appended'|'rejected', checkId?:string, seq?:number, reason?:string}>}
 */
async function applyConfirmedPayment(parsed, { loadEvents, appendEvent, recordPayment, findCheckByTxid, fallback }) {
  const check = await findCheckByTxid(parsed.txid);
  if (!check) {
    // Not a check charge — maybe another charge family (house-account loads).
    // The fallback owns its own idempotency/validation.
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
}

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
/** As duas únicas espécies que viram lançamento no razão. */
const LEDGER_KINDS = new Set(['payment_confirmed', 'refund']);

/**
 * Espécies de evento de DINHEIRO que não viram lançamento aqui.
 *
 * Cada uma tem um dono: a disputa tem prazo de prova, o estorno que falhou
 * significa que o dinheiro voltou pro restaurante e o cliente ficou sem, e o
 * `unusable_money_event` é dinheiro que saiu num valor que o adaptador não
 * consegue medir. Nenhuma delas move saldo, e nenhuma delas pode cair no
 * aplicador — lá dentro tudo que não é `refund` é tratado como pagamento.
 */
const NON_LEDGER_KINDS = new Set([
  'dispute_opened', 'refund_failed', 'refund_progress', 'unusable_money_event',
]);

function createWebhookHandler({ loadEvents, appendEvent, recordPayment, psp, findCheckByTxid, fallback }) {
  if (!loadEvents || !appendEvent || !psp || !findCheckByTxid) {
    throw new Error('createWebhookHandler: missing dependencies');
  }
  const deps = { loadEvents, appendEvent, recordPayment, findCheckByTxid, fallback };

  /**
   * @returns {Promise<{status: 'appended'|'duplicate'|'divergent_appended'|'rejected'|'ignored', checkId?: string, seq?: number, reason?: string, type?: string}>}
   * Throws WebhookVerificationError upward (HTTP layer → 401).
   */
  return async function handlePspWebhook(rawBody, signatureHeader) {
    // await: o mock verifica em memória (sync), o Pagar.me RE-BUSCA a
    // cobrança na API (async) — o corpo do webhook nunca é a verdade.
    const parsed = await psp.verifyAndParseWebhook(rawBody, signatureHeader); // throws on bad sig/auth

    // CONJUNTO FECHADO. Só duas espécies de evento chegam ao razão.
    //
    // A primeira versão desta guarda testava só `kind === 'ignored'`, e as duas
    // revisões de 2026-09-08 apontaram o mesmo problema: ela endurecia a
    // espécie inofensiva e deixava as PERIGOSAS passando. `dispute_opened`,
    // `refund_failed` e `refund_progress` eram tratadas só na ROTA, então
    // qualquer outro chamador as mandava pro aplicador, e lá dentro:
    //
    //     const type = parsed.kind === 'refund' ? 'PAYMENT_REFUNDED' : 'PAYMENT_CONFIRMED';
    //
    // Uma notificação de CHARGEBACK viraria PAYMENT_CONFIRMED. Concretamente:
    // a disputa chega pra um `pi_` cuja confirmação nunca caiu, o `payments`
    // resolve o check, o razão grava o valor disputado como dinheiro RECEBIDO,
    // a conta vira `paga`, o write-back empurra "pago" pro POS e a mesa fecha
    // em cima de um chargeback.
    //
    // Então: lista de quem PODE mover o razão, e tudo o mais para aqui. Espécie
    // desconhecida ESTOURA — é erro de programação, e um 500 alto é melhor que
    // um evento de dinheiro classificado por acidente.
    if (!parsed || typeof parsed.kind !== 'string') {
      throw new Error('webhook: parse sem `kind`');
    }
    // Ignorado é o caso comum e barato. Medido rodando de verdade
    // (2026-09-08): um pagamento Bizum entrega CINCO eventos —
    // `payment_intent.created`, `.requires_action`, `.succeeded`,
    // `charge.succeeded` e `charge.updated` — e só um move dinheiro.
    if (parsed.kind === 'ignored') {
      return { status: 'ignored', type: parsed.type };
    }
    // Evento de dinheiro que NÃO se resolve num lançamento: disputa aberta,
    // estorno que falhou, estorno em progresso, e o "saiu dinheiro e não
    // sabemos quanto" de um cancelamento parcial. Quem trata é o chamador
    // (alerta, prazo, registro) — o razão não se mexe aqui.
    if (NON_LEDGER_KINDS.has(parsed.kind)) {
      return { status: parsed.kind, type: parsed.type || null, txid: parsed.txid || null, raw: parsed };
    }
    if (!LEDGER_KINDS.has(parsed.kind)) {
      throw new Error(`webhook: kind desconhecido ${JSON.stringify(parsed.kind)}`);
    }
    return applyConfirmedPayment(parsed, deps);
  };
}

module.exports = { createWebhookHandler, applyConfirmedPayment, LEDGER_KINDS, NON_LEDGER_KINDS };
