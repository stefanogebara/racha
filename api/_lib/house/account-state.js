'use strict';

/**
 * House-account ledger — event-sourced, pure, and TOTAL (same discipline as
 * checks/check-state.js: strict validation at APPEND time, anomalies instead
 * of throws at REDUCE time; a malformed stored event must never make a
 * customer's money unreadable).
 *
 * Money rules encoded (legal constraints from the 2026-07-19 inKind research,
 * docs/house-accounts/README.md):
 * - PRINCIPAL (saldo pago) never expires and only shrinks via REDEEMED or
 *   PRINCIPAL_REFUNDED. There is no expiry mechanism for it — by design.
 * - BONUS lives in LOTS, each with its own expiresAt. Availability is lazy:
 *   a lot past its expiresAt simply stops counting (no expiry event needed).
 * - Spend order: bonus first (FIFO by earliest expiry), then principal —
 *   planRedeem() is the single source of that ordering.
 * - REDEEMED events carry their full breakdown ({principal, bonus, lots})
 *   plus `at` (the redemption instant), so expiry is validated against the
 *   time the money moved, not the time the log is read.
 * - LOAD_CONFIRMED / REDEEMED are idempotent by txid (at-least-once
 *   webhooks / retried RPCs); a replay with different money is an anomaly,
 *   never absorbed silently.
 *
 * Event types:
 *   OPENED             {}
 *   LOAD_CONFIRMED     { txid, principalCents, bonusCents, bonusExpiresAt }
 *   REDEEMED           { txid, checkId, at, principalCents, bonusCents,
 *                        lots: [{ seq, useCents }] }
 *   REDEEM_REVERSED    { txid, at, reason, by?, reissue? }  — compensation: puts the exact
 *                        breakdown of REDEEMED(txid) back (used when the
 *                        check-side append is refused after the debit)
 *   PRINCIPAL_REFUNDED { amountCents, settlement }
 */

const EVENT_TYPES = Object.freeze([
  'OPENED', 'LOAD_CONFIRMED', 'REDEEMED', 'REDEEM_REVERSED', 'PRINCIPAL_REFUNDED',
]);

const MAX_CENTS = Number.MAX_SAFE_INTEGER;

class HouseEventValidationError extends Error {}

function invalid(msg) {
  throw new HouseEventValidationError(`house-state: ${msg}`);
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) invalid(`${name} must be a non-negative integer, got ${v}`);
}

function assertIso(v, name) {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) invalid(`${name} must be an ISO timestamp`);
}

function initialState() {
  return null; // no OPENED yet
}

/** txid maps use null-prototype objects: txids are external strings. */
function emptyState() {
  return {
    principalCents: 0,
    refundedCents: 0,
    lots: [],                       // { seq, grantedCents, remainingCents, expiresAt }
    loads: Object.create(null),     // txid → { principalCents, bonusCents }
    redeems: Object.create(null),   // txid → { checkId, principalCents, bonusCents }
    anomalies: [],
  };
}

function cloneState(state) {
  const loads = Object.create(null);
  for (const t of Object.keys(state.loads)) loads[t] = { ...state.loads[t] };
  const redeems = Object.create(null);
  for (const t of Object.keys(state.redeems)) redeems[t] = { ...state.redeems[t] };
  return {
    ...state,
    lots: state.lots.map((l) => ({ ...l })),
    loads, redeems,
    anomalies: [...state.anomalies],
  };
}

function withAnomaly(state, seq, type, reason) {
  const next = cloneState(state);
  next.anomalies.push({ seq, type: type || 'UNKNOWN', reason });
  return next;
}

/**
 * Strict validation for the APPEND path. Throws HouseEventValidationError.
 * The reducer reuses it and converts throws into anomalies (totality).
 */
function validateEvent(evt, prevState) {
  if (!evt || !EVENT_TYPES.includes(evt.type)) invalid(`unknown event type: ${evt && evt.type}`);
  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      if (prevState) invalid('OPENED must be the first event');
      break;
    case 'LOAD_CONFIRMED':
      if (!prevState) invalid('LOAD_CONFIRMED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('LOAD_CONFIRMED.txid required');
      assertIso(p.at, 'LOAD_CONFIRMED.at');
      assertCents(p.principalCents, 'LOAD_CONFIRMED.principalCents');
      if (p.principalCents === 0) invalid('LOAD_CONFIRMED.principalCents must be positive');
      assertCents(p.bonusCents ?? 0, 'LOAD_CONFIRMED.bonusCents');
      if ((p.bonusCents ?? 0) > 0) assertIso(p.bonusExpiresAt, 'LOAD_CONFIRMED.bonusExpiresAt');
      if (prevState.principalCents + p.principalCents > MAX_CENTS) invalid('principal exceeds safe range');
      break;
    case 'REDEEMED': {
      if (!prevState) invalid('REDEEMED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('REDEEMED.txid required');
      if (typeof p.checkId !== 'string' || p.checkId.length < 1) invalid('REDEEMED.checkId required');
      assertIso(p.at, 'REDEEMED.at');
      assertCents(p.principalCents ?? 0, 'REDEEMED.principalCents');
      assertCents(p.bonusCents ?? 0, 'REDEEMED.bonusCents');
      const principal = p.principalCents ?? 0;
      const bonus = p.bonusCents ?? 0;
      if (principal + bonus === 0) invalid('zero-value redeem');
      if (principal > prevState.principalCents) {
        invalid(`redeem principal ${principal} exceeds balance ${prevState.principalCents}`);
      }
      // A truthy non-array (jsonb object, string) must fail HERE, not blow up
      // the reducer later (totality — review finding).
      if (p.lots != null && !Array.isArray(p.lots)) invalid('REDEEMED.lots must be an array');
      const lots = Array.isArray(p.lots) ? p.lots : [];
      let lotSum = 0;
      // Per-seq consumption tracker: duplicate seqs in one event must not
      // each validate against the untouched prevState (review finding — a
      // lot could be driven negative through the strict gate).
      const claimed = new Map();
      for (const use of lots) {
        if (!use || !Number.isSafeInteger(use.seq)) invalid('REDEEMED.lots[].seq required');
        assertCents(use.useCents, 'REDEEMED.lots[].useCents');
        if (use.useCents === 0) invalid('REDEEMED.lots[].useCents must be positive');
        const lot = prevState.lots.find((l) => l.seq === use.seq);
        if (!lot) invalid(`REDEEMED references unknown bonus lot seq ${use.seq}`);
        const prior = claimed.get(use.seq) || 0;
        if (lot.remainingCents - prior < use.useCents) {
          invalid(`REDEEMED overdraws bonus lot seq ${use.seq} (${prior + use.useCents} > ${lot.remainingCents})`);
        }
        claimed.set(use.seq, prior + use.useCents);
        // Expiry is judged at the redemption instant (p.at), never at read time.
        if (Date.parse(lot.expiresAt) <= Date.parse(p.at)) {
          invalid(`REDEEMED spends expired bonus lot seq ${use.seq}`);
        }
        lotSum += use.useCents;
      }
      if (lotSum !== bonus) invalid(`REDEEMED lot breakdown (${lotSum}) != bonusCents (${bonus})`);
      break;
    }
    case 'REDEEM_REVERSED': {
      if (!prevState) invalid('REDEEM_REVERSED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('REDEEM_REVERSED.txid required');
      assertIso(p.at, 'REDEEM_REVERSED.at');
      const orig = prevState.redeems[p.txid];
      if (!orig) invalid(`REDEEM_REVERSED for unknown redeem txid ${p.txid}`);
      if (orig.reversed) invalid(`redeem txid ${p.txid} already reversed`);
      // 0044: o bônus de lote vencido volta como lote NOVO. Os lotes de onde
      // ele sai têm que ser lotes que ESTE débito usou.
      if (p.reissue !== undefined) {
        const r = p.reissue;
        if (!r || typeof r !== 'object') invalid('REDEEM_REVERSED.reissue must be an object');
        assertCents(r.bonusCents, 'REDEEM_REVERSED.reissue.bonusCents');
        if (r.bonusCents <= 0) invalid('REDEEM_REVERSED.reissue.bonusCents must be > 0');
        assertIso(r.expiresAt, 'REDEEM_REVERSED.reissue.expiresAt');
        if (!Array.isArray(r.fromLots)) invalid('REDEEM_REVERSED.reissue.fromLots must be an array');
        const usados = new Map((orig.lots || []).map((u) => [u.seq, u.useCents]));
        let soma = 0;
        for (const s of r.fromLots) {
          if (!usados.has(s)) invalid(`REDEEM_REVERSED.reissue.fromLots: lot ${s} not used by redeem ${p.txid}`);
          soma += usados.get(s);
        }
        if (soma !== r.bonusCents) invalid(`REDEEM_REVERSED.reissue: ${r.bonusCents} != lots used ${soma}`);
      }
      break;
    }
    case 'PRINCIPAL_REFUNDED':
      if (!prevState) invalid('PRINCIPAL_REFUNDED before OPENED');
      assertIso(p.at, 'PRINCIPAL_REFUNDED.at');
      assertCents(p.amountCents, 'PRINCIPAL_REFUNDED.amountCents');
      if (p.amountCents === 0) invalid('zero-value refund');
      if (p.amountCents > prevState.principalCents) {
        invalid(`refund ${p.amountCents} exceeds principal ${prevState.principalCents}`);
      }
      break;
    default:
      invalid(`unhandled type ${evt.type}`);
  }
}

/**
 * Fold one event — TOTAL. Duplicate LOAD_CONFIRMED/REDEEMED txids with the
 * same money are clean no-ops; with different money they are anomalies.
 */
function applyEvent(state, evt, seq = null) {
  if (state && evt) {
    const p = evt.payload || {};
    if (evt.type === 'LOAD_CONFIRMED' && typeof p.txid === 'string' && state.loads[p.txid]) {
      const ex = state.loads[p.txid];
      if (ex.principalCents === p.principalCents && ex.bonusCents === (p.bonusCents ?? 0)) return state;
      return withAnomaly(state, seq, 'divergent_load_txid', `load txid ${p.txid} replayed with different amounts`);
    }
    if (evt.type === 'REDEEMED' && typeof p.txid === 'string' && state.redeems[p.txid]) {
      const ex = state.redeems[p.txid];
      if (ex.principalCents === (p.principalCents ?? 0) && ex.bonusCents === (p.bonusCents ?? 0)) return state;
      return withAnomaly(state, seq, 'divergent_redeem_txid', `redeem txid ${p.txid} replayed with different amounts`);
    }
    if (evt.type === 'REDEEM_REVERSED' && typeof p.txid === 'string'
        && state.redeems[p.txid] && state.redeems[p.txid].reversed) {
      return state; // clean at-least-once replay of the reversal
    }
  }

  try {
    validateEvent(evt, state);
  } catch (err) {
    if (err instanceof HouseEventValidationError) {
      if (state === null) {
        const next = emptyState();
        next.anomalies.push({ seq, type: evt && evt.type, reason: err.message });
        return next;
      }
      return withAnomaly(state, seq, evt && evt.type, err.message);
    }
    throw err; // programmer errors stay loud
  }

  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      return emptyState();
    case 'LOAD_CONFIRMED': {
      const next = cloneState(state);
      next.principalCents += p.principalCents;
      const bonus = p.bonusCents ?? 0;
      if (bonus > 0) {
        next.lots.push({ seq, grantedCents: bonus, remainingCents: bonus, expiresAt: p.bonusExpiresAt });
      }
      next.loads[p.txid] = { principalCents: p.principalCents, bonusCents: bonus };
      return next;
    }
    case 'REDEEMED': {
      const next = cloneState(state);
      next.principalCents -= p.principalCents ?? 0;
      for (const use of (Array.isArray(p.lots) ? p.lots : [])) {
        const lot = next.lots.find((l) => l.seq === use.seq);
        lot.remainingCents -= use.useCents;
      }
      next.redeems[p.txid] = {
        checkId: p.checkId,
        principalCents: p.principalCents ?? 0,
        bonusCents: p.bonusCents ?? 0,
        // The exact lot breakdown is kept so a reversal can restore it.
        lots: (Array.isArray(p.lots) ? p.lots : []).map((u) => ({ seq: u.seq, useCents: u.useCents })),
        reversed: false,
      };
      return next;
    }
    case 'REDEEM_REVERSED': {
      const next = cloneState(state);
      const orig = next.redeems[p.txid];
      next.principalCents += orig.principalCents;
      // 0044: lote vencido no estorno NÃO recebe o bônus de volta — ele vira um
      // lote novo (`reissue`), com validade nova. Evento antigo, sem `reissue`,
      // devolve tudo aos lotes de origem, como sempre.
      const reemitidos = new Set(p.reissue ? p.reissue.fromLots : []);
      for (const use of orig.lots || []) {
        if (reemitidos.has(use.seq)) continue;
        const lot = next.lots.find((l) => l.seq === use.seq);
        if (lot) lot.remainingCents += use.useCents;
      }
      if (p.reissue) {
        next.lots.push({
          seq, grantedCents: p.reissue.bonusCents, remainingCents: p.reissue.bonusCents, expiresAt: p.reissue.expiresAt,
        });
      }
      orig.reversed = true;
      return next;
    }
    case 'PRINCIPAL_REFUNDED': {
      const next = cloneState(state);
      next.principalCents -= p.amountCents;
      next.refundedCents += p.amountCents;
      return next;
    }
    default:
      return withAnomaly(state, seq, evt.type, 'unhandled type');
  }
}

/** Reduce a full seq-ordered log. TOTAL — never throws on stored data. */
function reduce(events) {
  if (!Array.isArray(events)) invalid('events must be an array');
  let state = initialState();
  events.forEach((evt, i) => {
    state = applyEvent(state, evt, (evt && evt.seq) ?? i + 1); // null rows must not crash the fold
  });
  return state;
}

/** Available (spendable) money at `nowIso` — expired lots stop counting. */
function availableCents(state, nowIso) {
  if (!state) return { principalCents: 0, bonusCents: 0, totalCents: 0 };
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) invalid('availableCents: nowIso must be an ISO timestamp');
  // Clamp per lot: a corrupt stored event must never let a negative lot eat
  // into other lots' bonus or the customer's never-expiring principal.
  const bonusCents = state.lots
    .filter((l) => Date.parse(l.expiresAt) > now)
    .reduce((s, l) => s + Math.max(0, l.remainingCents), 0);
  return {
    principalCents: state.principalCents,
    bonusCents,
    totalCents: state.principalCents + bonusCents,
  };
}

/** Unexpired lots at `nowIso`, spend-ordered (earliest expiry first). */
function liveLots(state, nowIso) {
  const now = Date.parse(nowIso);
  return state.lots
    .filter((l) => l.remainingCents > 0 && Date.parse(l.expiresAt) > now)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.seq - b.seq);
}

/**
 * Plan a redemption of `amountCents` at `nowIso`: bonus first (FIFO by
 * earliest expiry), then principal. Throws HouseEventValidationError when the
 * available balance can't cover it. Returns the exact REDEEMED payload
 * breakdown — the ONE place spend order is decided.
 */
function planRedeem(state, amountCents, nowIso) {
  assertCents(amountCents, 'planRedeem.amountCents');
  if (amountCents === 0) invalid('zero-value redeem');
  const avail = availableCents(state, nowIso);
  if (amountCents > avail.totalCents) {
    invalid(`insufficient balance: ${amountCents} > ${avail.totalCents}`);
  }
  let remaining = amountCents;
  const lots = [];
  for (const lot of liveLots(state, nowIso)) {
    if (remaining === 0) break;
    const use = Math.min(lot.remainingCents, remaining);
    lots.push({ seq: lot.seq, useCents: use });
    remaining -= use;
  }
  const bonusCents = amountCents - remaining;
  const principalCents = remaining;
  return { principalCents, bonusCents, lots, at: nowIso };
}

module.exports = {
  EVENT_TYPES, HouseEventValidationError,
  initialState, reduce, applyEvent, validateEvent,
  availableCents, planRedeem,
};
