'use strict';

/**
 * Check state machine — event-sourced, pure.
 *
 * The append-only event log is the source of truth (rows in check_events);
 * this module derives state by folding events in seq order. Nothing here does
 * I/O. Money bugs must be replayable: given the same events, reduce() always
 * returns the same state.
 *
 * Event types (payload shapes validated here):
 *   OPENED             { totalCents }                    — check created (POS read or manual)
 *   ADJUSTED           { totalCents }                    — waiter added/removed items
 *   PAYMENT_CONFIRMED  { txid, amountCents, tipCents, method } — PSP webhook (at-least-once!)
 *   CLOSED             {}                                — table released
 *
 * Rules encoded:
 * - PAYMENT_CONFIRMED is idempotent by txid: replays/duplicate webhooks are
 *   no-ops (at-least-once delivery is assumed from every PSP).
 * - Consumption (amountCents) and tips (tipCents) are tracked SEPARATELY:
 *   tips are employee remuneration (Lei 13.419/2017), never part of the check
 *   total, and the payroll report reads them from here.
 * - Overpayment never throws away money silently: state flags `overpaidCents`
 *   for reconciliation to alert on. It can happen legitimately mid-flight
 *   (ADJUSTED down after a payment was authorized).
 * - Payments after CLOSED are recorded as anomalies (`lateTxids`) — the money
 *   is real and reconciliation must see it; the status does not regress.
 */

const STATUS = Object.freeze({
  ABERTA: 'aberta',
  PARCIAL: 'parcial',
  PAGA: 'paga',
  FECHADA: 'fechada',
});

const EVENT_TYPES = Object.freeze(['OPENED', 'ADJUSTED', 'PAYMENT_CONFIRMED', 'CLOSED']);

function fail(msg) {
  throw new Error(`check-state: ${msg}`);
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) fail(`${name} must be a non-negative integer, got ${v}`);
}

/** Validate a single event before it is appended to the log. */
function validateEvent(evt, prevState) {
  if (!evt || !EVENT_TYPES.includes(evt.type)) fail(`unknown event type: ${evt && evt.type}`);
  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      if (prevState) fail('OPENED must be the first event');
      assertCents(p.totalCents, 'OPENED.totalCents');
      break;
    case 'ADJUSTED':
      if (!prevState) fail('ADJUSTED before OPENED');
      if (prevState.status === STATUS.FECHADA) fail('cannot ADJUST a closed check');
      assertCents(p.totalCents, 'ADJUSTED.totalCents');
      break;
    case 'PAYMENT_CONFIRMED':
      if (!prevState) fail('PAYMENT_CONFIRMED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) fail('PAYMENT_CONFIRMED.txid required');
      assertCents(p.amountCents, 'PAYMENT_CONFIRMED.amountCents');
      assertCents(p.tipCents ?? 0, 'PAYMENT_CONFIRMED.tipCents');
      if (p.amountCents === 0 && (p.tipCents ?? 0) === 0) fail('zero-value payment');
      break;
    case 'CLOSED':
      if (!prevState) fail('CLOSED before OPENED');
      if (prevState.status === STATUS.FECHADA) fail('already closed');
      break;
    default:
      fail(`unhandled type ${evt.type}`);
  }
}

function initialState() {
  return null; // no OPENED yet
}

/** Fold one event into state. Pure; returns a NEW state object. */
function applyEvent(state, evt) {
  validateEvent(evt, state);
  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      return {
        status: STATUS.ABERTA,
        totalCents: p.totalCents,
        paidCents: 0,
        tipCents: 0,
        overpaidCents: 0,
        txids: [],
        lateTxids: [],
      };
    case 'ADJUSTED': {
      const next = { ...state, totalCents: p.totalCents, txids: [...state.txids], lateTxids: [...state.lateTxids] };
      return recomputeStatus(next);
    }
    case 'PAYMENT_CONFIRMED': {
      if (state.txids.includes(p.txid) || state.lateTxids.includes(p.txid)) {
        return state; // idempotent replay — at-least-once webhook delivery
      }
      if (state.status === STATUS.FECHADA) {
        // Money after close: never dropped, never regresses status. Flagged
        // for reconciliation (refund path decided by a human/MED flow).
        return {
          ...state,
          lateTxids: [...state.lateTxids, p.txid],
          paidCents: state.paidCents + p.amountCents,
          tipCents: state.tipCents + (p.tipCents ?? 0),
        };
      }
      const next = {
        ...state,
        txids: [...state.txids, p.txid],
        lateTxids: [...state.lateTxids],
        paidCents: state.paidCents + p.amountCents,
        tipCents: state.tipCents + (p.tipCents ?? 0),
      };
      return recomputeStatus(next);
    }
    case 'CLOSED':
      return { ...state, status: STATUS.FECHADA, txids: [...state.txids], lateTxids: [...state.lateTxids] };
    default:
      fail(`unhandled type ${evt.type}`);
  }
}

/** Derive status + overpaid flag from totals. Never called on FECHADA. */
function recomputeStatus(state) {
  const overpaidCents = Math.max(0, state.paidCents - state.totalCents);
  let status;
  if (state.paidCents === 0) status = STATUS.ABERTA;
  else if (state.paidCents < state.totalCents) status = STATUS.PARCIAL;
  else status = STATUS.PAGA;
  return { ...state, status, overpaidCents };
}

/**
 * Reduce a full event log (seq-ordered) to current state.
 * @param {Array<{type:string, payload:object}>} events
 */
function reduce(events) {
  if (!Array.isArray(events)) fail('events must be an array');
  let state = initialState();
  for (const evt of events) state = applyEvent(state, evt);
  return state;
}

/** Remaining consumption to collect (never negative). */
function remainingCents(state) {
  if (!state) fail('no state');
  return Math.max(0, state.totalCents - state.paidCents);
}

module.exports = { STATUS, EVENT_TYPES, reduce, applyEvent, validateEvent, remainingCents, initialState };
