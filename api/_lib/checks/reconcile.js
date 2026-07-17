'use strict';

/**
 * Reconciliation canary — the money core's final safety net.
 *
 * Racha keeps TWO independent records of the same money, both written by the
 * webhook handler but to different places:
 *   1. the append-only EVENT LOG (check_events) → reduce() → paid/tip per txid
 *   2. the PAYMENTS TABLE (one row per txid, status confirmado/devolvido)
 *
 * A partial write, a dropped append, a divergent replay, or a raced lifecycle
 * event makes these disagree. This module cross-checks them per check and
 * reports drift ≥ 1 centavo — the "alert on drift" promise from the plan.
 * PURE and TOTAL: never throws; a malformed input becomes a finding.
 *
 * Findings are severity-ranked so the canary can page on `critical`/`high`
 * and merely log `info`.
 */

const { reduce } = require('./check-state');

/**
 * @param {object} input
 * @param {string} input.checkId
 * @param {Array} input.events        seq-ordered check_events
 * @param {Array} input.payments      payment rows: { txid, amountCents, tipCents, status }
 * @returns {{ checkId: string, ok: boolean, driftCents: number, findings: Array }}
 */
function reconcileCheck({ checkId, events, payments }) {
  const findings = [];
  const add = (severity, code, msg, extra = {}) =>
    findings.push({ severity, code, message: msg, ...extra });

  let state;
  try {
    state = reduce(events || []);
  } catch (err) {
    // reduce() is total, but guard anyway — a throw here is itself a finding.
    add('critical', 'reduce_threw', `event log could not be reduced: ${err.message}`);
    return { checkId, ok: false, driftCents: 0, findings };
  }

  // 1. Event-log anomalies are reconciliation findings in their own right.
  for (const a of state ? state.anomalies : []) {
    add('high', 'log_anomaly', `event-log anomaly: ${a.reason}`, { seq: a.seq, type: a.type });
  }

  const rows = Array.isArray(payments) ? payments : [];
  const byTxid = new Map();
  for (const r of rows) {
    if (r && typeof r.txid === 'string') byTxid.set(r.txid, r);
  }

  // 2. Every confirmed event-log payment must have a matching confirmed row.
  const logPayments = state ? state.payments : {};
  let logConfirmedCents = 0;
  for (const txid of Object.keys(logPayments)) {
    const pay = logPayments[txid];
    const net = pay.amountCents - pay.refundedAmountCents + pay.tipCents - pay.refundedTipCents;
    logConfirmedCents += net;

    const row = byTxid.get(txid);
    if (!row) {
      add('critical', 'missing_payment_row',
        `txid ${txid} is in the event log but has no payments row (partial write?)`, { txid });
      continue;
    }
    const rowTotal = (row.amountCents || 0) + (row.tipCents || 0);
    const logTotal = pay.amountCents + pay.tipCents;
    if (rowTotal !== logTotal) {
      add('critical', 'amount_mismatch',
        `txid ${txid}: payments row ${rowTotal}¢ vs event log ${logTotal}¢`, { txid });
    }
    const fullyRefunded = pay.refundedAmountCents === pay.amountCents && pay.refundedTipCents === pay.tipCents;
    if (fullyRefunded && row.status !== 'devolvido') {
      add('high', 'status_lag',
        `txid ${txid} fully refunded in log but row status is '${row.status}'`, { txid });
    }
    if (!fullyRefunded && row.status !== 'confirmado') {
      add('high', 'status_lag',
        `txid ${txid} confirmed in log but row status is '${row.status}'`, { txid });
    }
  }

  // 3. Every confirmed payments row must have a matching event-log payment
  //    (a webhook that hit the payments table but never appended = lost money
  //    from the check's derived state).
  let rowConfirmedCents = 0;
  for (const row of rows) {
    if (row.status === 'confirmado') {
      rowConfirmedCents += (row.amountCents || 0) + (row.tipCents || 0);
      if (!logPayments[row.txid]) {
        add('critical', 'missing_log_event',
          `txid ${row.txid} is a confirmed payment row but absent from the event log`, { txid: row.txid });
      }
    }
  }

  // 4. The bottom line: two independent tallies of confirmed money must match.
  const driftCents = rowConfirmedCents - logConfirmedCents;
  if (driftCents !== 0) {
    add('critical', 'ledger_drift',
      `confirmed-money drift: payments table ${rowConfirmedCents}¢ vs event log ${logConfirmedCents}¢ (Δ ${driftCents}¢)`,
      { driftCents });
  }

  return {
    checkId,
    ok: findings.length === 0,
    driftCents,
    findings,
  };
}

/**
 * Reconcile every check of a venue via the store. Returns the venue roll-up
 * plus per-check results that failed. Store must implement
 * listChecksForReconcile(venueId) → [{ checkId, events, payments }].
 */
async function reconcileVenue(store, venueId) {
  const inputs = await store.listChecksForReconcile(venueId);
  const results = inputs.map(reconcileCheck);
  const failed = results.filter((r) => !r.ok);
  const severityRank = { critical: 3, high: 2, info: 1 };
  const worst = failed
    .flatMap((r) => r.findings)
    .reduce((max, f) => Math.max(max, severityRank[f.severity] || 0), 0);
  return {
    venueId,
    checksChecked: results.length,
    checksFailed: failed.length,
    totalDriftCents: results.reduce((s, r) => s + Math.abs(r.driftCents), 0),
    worstSeverity: ['ok', 'info', 'high', 'critical'][worst],
    failed,
  };
}

module.exports = { reconcileCheck, reconcileVenue };
