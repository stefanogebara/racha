'use strict';

/**
 * Check state machine — event-sourced, pure, and TOTAL.
 *
 * The append-only event log is the source of truth (rows in check_events);
 * this module derives state by folding events in seq order. Nothing here does
 * I/O. Money bugs must be replayable: given the same events, reduce() always
 * returns the same state.
 *
 * TOTALITY (review finding, 2026-07-17): reduce() NEVER throws on a stored
 * log. A raced or malformed event must not make real money unreadable — it is
 * recorded in state.anomalies and skipped. Strict validation happens at
 * APPEND time (validateEvent, called by the API before append_check_event,
 * which serializes appends per check with an advisory lock).
 *
 * Event types:
 *   OPENED             { totalCents }
 *   ADJUSTED           { totalCents }
 *   PAYMENT_CONFIRMED  { txid, amountCents, tipCents, method }   (at-least-once!)
 *   PAYMENT_REFUNDED   { txid, amountCents, tipCents }           (Pix devolução / MED)
 *   CLOSED             {}
 *
 * Money rules encoded:
 * - PAYMENT_CONFIRMED is idempotent by txid; a replay with DIFFERENT amounts
 *   is flagged (anomaly 'divergent_txid'), never absorbed silently.
 * - Consumption (amountCents) and tips (tipCents) are tracked SEPARATELY:
 *   tips are employee remuneration (Lei 13.419/2017); the payroll report
 *   reads them from here.
 * - Refunds reference the original txid and can never exceed what that txid
 *   paid (excess → anomaly, ignored).
 * - Overpayment is flagged (overpaidCents), recomputed on every money event
 *   including after CLOSED. Payments after CLOSED are recorded (late:true)
 *   and counted; status never regresses.
 */

const STATUS = Object.freeze({
  ABERTA: 'aberta',
  PARCIAL: 'parcial',
  PAGA: 'paga',
  FECHADA: 'fechada',
});

const EVENT_TYPES = Object.freeze([
  'OPENED', 'ADJUSTED', 'PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'CLOSED',
  // Uma disputa NÃO é um estorno. O dinheiro fica retido enquanto o esquema
  // decide, e o cliente pode perder — então marcar como PAYMENT_REFUNDED
  // reabriria a conta por causa de uma reclamação que talvez não proceda.
  //
  // Mas ela É um evento de dinheiro, e o inegociável #6 diz que estado de
  // pagamento é event-sourced: se a disputa não entra no log, o estorno que
  // aparece noventa dias depois não tem antecedente nenhum. Então ela entra,
  // sem mover saldo, e marca a conta pra alguém olhar.
  //
  // O Bizum abriu essa necessidade: 120 dias de janela, contra a janela curta
  // do MED do Pix.
  'PAYMENT_DISPUTED',
]);

// Money accumulations must stay in exact-integer territory.
const MAX_CENTS = Number.MAX_SAFE_INTEGER;

class EventValidationError extends Error {}

function invalid(msg) {
  throw new EventValidationError(`check-state: ${msg}`);
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) invalid(`${name} must be a non-negative integer, got ${v}`);
}

/**
 * Strict validation for the APPEND path: the API calls this against current
 * state before appending. Throws EventValidationError on any violation.
 * (The reducer reuses it but converts throws into anomalies — totality.)
 */
function validateEvent(evt, prevState) {
  if (!evt || !EVENT_TYPES.includes(evt.type)) invalid(`unknown event type: ${evt && evt.type}`);
  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      if (prevState) invalid('OPENED must be the first event');
      assertCents(p.totalCents, 'OPENED.totalCents');
      break;
    case 'ADJUSTED':
      if (!prevState) invalid('ADJUSTED before OPENED');
      if (prevState.status === STATUS.FECHADA) invalid('cannot ADJUST a closed check');
      assertCents(p.totalCents, 'ADJUSTED.totalCents');
      break;
    case 'PAYMENT_CONFIRMED':
      if (!prevState) invalid('PAYMENT_CONFIRMED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_CONFIRMED.txid required');
      assertCents(p.amountCents, 'PAYMENT_CONFIRMED.amountCents');
      assertCents(p.tipCents ?? 0, 'PAYMENT_CONFIRMED.tipCents');
      if (p.amountCents === 0 && (p.tipCents ?? 0) === 0) invalid('zero-value payment');
      break;
    case 'PAYMENT_REFUNDED': {
      if (!prevState) invalid('PAYMENT_REFUNDED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_REFUNDED.txid required');
      assertCents(p.amountCents ?? 0, 'PAYMENT_REFUNDED.amountCents');
      assertCents(p.tipCents ?? 0, 'PAYMENT_REFUNDED.tipCents');
      if ((p.amountCents ?? 0) === 0 && (p.tipCents ?? 0) === 0) invalid('zero-value refund');
      const pay = prevState.payments[p.txid];
      if (!pay) invalid(`refund for unknown txid ${p.txid}`);
      if (pay.refundedAmountCents + (p.amountCents ?? 0) > pay.amountCents) {
        invalid(`refund exceeds paid amount for txid ${p.txid}`);
      }
      if (pay.refundedTipCents + (p.tipCents ?? 0) > pay.tipCents) {
        invalid(`tip refund exceeds paid tip for txid ${p.txid}`);
      }
      break;
    }
    case 'PAYMENT_DISPUTED': {
      if (!prevState) invalid('PAYMENT_DISPUTED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_DISPUTED.txid required');
      assertCents(p.amountCents ?? 0, 'PAYMENT_DISPUTED.amountCents');
      // Disputa de um txid que não existe é um sinal de que o webhook e o
      // ledger discordam — alto, não silencioso.
      if (!prevState.payments[p.txid]) invalid(`dispute for unknown txid ${p.txid}`);
      break;
    }
    case 'CLOSED':
      if (!prevState) invalid('CLOSED before OPENED');
      if (prevState.status === STATUS.FECHADA) invalid('already closed');
      break;
    default:
      invalid(`unhandled type ${evt.type}`);
  }
}

function initialState() {
  return null; // no OPENED yet
}

/** payments map uses a null-prototype object: txids are external strings. */
function emptyPayments() {
  return Object.create(null);
}

/**
 * Fold one event into state — TOTAL. Invalid events return the previous state
 * with an anomaly appended (except a valid duplicate PAYMENT_CONFIRMED, which
 * is a clean idempotent no-op). Pure; returns a NEW state object.
 */
function applyEvent(state, evt, seq = null) {
  // Idempotent replay short-circuit must run BEFORE strict validation so a
  // duplicate webhook is a no-op, not an anomaly.
  if (state && evt && evt.type === 'PAYMENT_CONFIRMED') {
    const p = evt.payload || {};
    const existing = typeof p.txid === 'string' ? state.payments[p.txid] : undefined;
    if (existing) {
      if (existing.amountCents === p.amountCents && existing.tipCents === (p.tipCents ?? 0)) {
        return state; // clean at-least-once replay
      }
      // Same txid, different money: never absorb silently (review finding).
      return withAnomaly(state, seq, 'divergent_txid',
        `txid ${p.txid} replayed with different amounts`);
    }
  }

  try {
    validateEvent(evt, state);
  } catch (err) {
    if (err instanceof EventValidationError) {
      // Totality: a stored log must always reduce. Raced duplicates
      // (CLOSED,CLOSED), adjust-after-close, malformed payloads → anomaly.
      if (state === null) {
        // Pre-OPENED garbage: keep a bootstrap anomaly holder.
        return {
          ...emptyOpenState(0),
          status: STATUS.ABERTA,
          bootstrapped: true,
          anomalies: [{ seq, type: evt && evt.type, reason: err.message }],
        };
      }
      return withAnomaly(state, seq, evt && evt.type, err.message);
    }
    throw err; // programmer errors stay loud
  }

  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      return emptyOpenState(p.totalCents);
    case 'ADJUSTED':
      return recompute({ ...cloneState(state), totalCents: p.totalCents });
    case 'PAYMENT_CONFIRMED': {
      const next = cloneState(state);
      const tip = p.tipCents ?? 0;
      guardCap(next.paidCents, p.amountCents);
      guardCap(next.tipCents, tip);
      next.payments[p.txid] = {
        amountCents: p.amountCents,
        tipCents: tip,
        refundedAmountCents: 0,
        refundedTipCents: 0,
        disputedAmountCents: 0,
        late: state.status === STATUS.FECHADA,
      };
      next.paidCents += p.amountCents;
      next.tipCents += tip;
      return recompute(next);
    }
    case 'PAYMENT_REFUNDED': {
      const next = cloneState(state);
      const amount = p.amountCents ?? 0;
      const tip = p.tipCents ?? 0;
      const pay = next.payments[p.txid];
      pay.refundedAmountCents += amount;
      pay.refundedTipCents += tip;
      next.paidCents -= amount;
      next.tipCents -= tip;
      return recompute(next);
    }
    case 'PAYMENT_DISPUTED': {
      // Não mexe em `paidCents`: o dinheiro ainda é do restaurante até o
      // esquema decidir. Marca o pagamento e registra uma anomalia, que é o
      // que faz a conta aparecer vermelha na conciliação em vez de parecer
      // normal enquanto alguém contesta.
      const next = cloneState(state);
      const pay = next.payments[p.txid];
      if (pay) pay.disputedAmountCents = (pay.disputedAmountCents || 0) + (p.amountCents ?? 0);
      return withAnomaly(recompute(next), seq, 'PAYMENT_DISPUTED',
        `disputa aberta em ${p.txid}${p.reason ? ` (${p.reason})` : ''}`);
    }
    case 'CLOSED':
      return recompute({ ...cloneState(state), closed: true });
    default:
      return withAnomaly(state, seq, evt.type, 'unhandled type');
  }
}

function emptyOpenState(totalCents) {
  return {
    status: STATUS.ABERTA,
    totalCents,
    paidCents: 0,
    tipCents: 0,
    overpaidCents: 0,
    closed: false,
    payments: emptyPayments(),
    anomalies: [],
  };
}

function cloneState(state) {
  const payments = emptyPayments();
  for (const txid of Object.keys(state.payments)) {
    payments[txid] = { ...state.payments[txid] };
  }
  return { ...state, payments, anomalies: [...state.anomalies] };
}

function withAnomaly(state, seq, type, reason) {
  const next = cloneState(state);
  next.anomalies.push({ seq, type: type || 'UNKNOWN', reason });
  return next;
}

function guardCap(current, add) {
  if (current + add > MAX_CENTS) invalid('money accumulation exceeds safe integer range');
}

/**
 * Derive status + overpaid from totals. FECHADA (closed flag) wins and never
 * regresses; overpaidCents is recomputed on EVERY money event, including
 * post-close payments (review finding: it used to go stale).
 */
function recompute(state) {
  const overpaidCents = Math.max(0, state.paidCents - state.totalCents);
  let status;
  if (state.closed) status = STATUS.FECHADA;
  else if (state.paidCents === 0) status = STATUS.ABERTA;
  else if (state.paidCents < state.totalCents) status = STATUS.PARCIAL;
  else status = STATUS.PAGA;
  return { ...state, status, overpaidCents };
}

/**
 * Reduce a full event log (seq-ordered) to current state. TOTAL: never throws
 * on stored data; inspect state.anomalies (reconciliation alerts on any).
 * @param {Array<{type:string, payload:object, seq?:number}>} events
 */
function reduce(events) {
  if (!Array.isArray(events)) invalid('events must be an array');
  let state = initialState();
  events.forEach((evt, i) => {
    state = applyEvent(state, evt, evt.seq ?? i + 1);
  });
  return state;
}

/** Remaining consumption to collect (never negative). */
function remainingCents(state) {
  if (!state) invalid('no state');
  return Math.max(0, state.totalCents - state.paidCents);
}

/** Late payments (post-close), for reconciliation/refund workflows. */
function lateTxids(state) {
  if (!state) return [];
  return Object.keys(state.payments).filter((t) => state.payments[t].late);
}

module.exports = {
  STATUS, EVENT_TYPES, EventValidationError,
  reduce, applyEvent, validateEvent, remainingCents, lateTxids, initialState,
};
