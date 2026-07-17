'use strict';

/**
 * In-memory store — powers the local demo and integration tests.
 *
 * Implements the same interface as the Supabase store (store/supabase.js,
 * v1): venues/tables/checks/events/payments. Seq assignment mirrors the
 * append_check_event RPC semantics (serialized per check — trivially true
 * single-threaded here). NOT for production use.
 */

const crypto = require('crypto');
const { reduce } = require('../checks/check-state');

function createMemoryStore() {
  const venues = new Map();
  const tables = new Map();   // qrToken → { id, venueId, label, qrToken }
  const checks = new Map();   // checkId → { id, venueId, tableId, items: [] }
  const events = new Map();   // checkId → [{seq, type, payload}]
  const payments = new Map(); // txid → payment row
  const txidToCheck = new Map();

  return {
    // --- seeding (demo) -----------------------------------------------------
    seedVenue({ name, servicoBp = 1000, pspRecipientId = 'rcpt_demo' }) {
      const id = crypto.randomUUID();
      venues.set(id, { id, name, servicoBp, pspRecipientId });
      return venues.get(id);
    },
    seedTable(venueId, label) {
      const qrToken = crypto.randomUUID();
      const id = crypto.randomUUID();
      tables.set(qrToken, { id, venueId, label, qrToken });
      return tables.get(qrToken);
    },
    async openCheck(tableQrToken, items) {
      const table = tables.get(tableQrToken);
      if (!table) throw new Error('unknown table');
      const id = crypto.randomUUID();
      const totalCents = items.reduce((s, i) => s + i.priceCents, 0);
      checks.set(id, { id, venueId: table.venueId, tableId: table.id, items });
      events.set(id, []);
      await this.appendEvent(id, 'OPENED', { totalCents });
      return checks.get(id);
    },

    // --- reads ---------------------------------------------------------------
    async getCheckByQrToken(qrToken) {
      const table = tables.get(qrToken);
      if (!table) return null;
      const check = [...checks.values()].find((c) => c.tableId === table.id);
      if (!check) return null;
      const venue = venues.get(table.venueId);
      const log = events.get(check.id) || [];
      return {
        venue: { name: venue.name, servicoBp: venue.servicoBp },
        table: { label: table.label },
        check: { id: check.id, items: check.items },
        state: reduce(log),
      };
    },
    async loadEvents(checkId) {
      return [...(events.get(checkId) || [])];
    },
    async findCheckByTxid(txid) {
      const checkId = txidToCheck.get(txid);
      return checkId ? { id: checkId } : null;
    },
    async getVenueForCheck(checkId) {
      const check = checks.get(checkId);
      return check ? venues.get(check.venueId) : null;
    },
    async getPayment(txid) {
      return payments.get(txid) || null;
    },
    /** Reconciliation inputs: each check's event log + its payment rows. */
    async listChecksForReconcile(venueId) {
      return [...checks.values()]
        .filter((c) => c.venueId === venueId)
        .map((c) => ({
          checkId: c.id,
          events: [...(events.get(c.id) || [])],
          payments: [...payments.values()]
            .filter((p) => p.checkId === c.id)
            .map((p) => ({ txid: p.txid, amountCents: p.amountCents, tipCents: p.tipCents, status: p.status })),
        }));
    },
    /**
     * Restaurant panel view: every check of the venue with derived state,
     * plus day totals. Tips are reported from CONFIRMED payments only and
     * keyed by confirmed_at (Lei 13.419 payroll competência).
     */
    async getPanelView(venueId) {
      const venue = venues.get(venueId);
      if (!venue) return null;
      const rows = [...checks.values()]
        .filter((c) => c.venueId === venueId)
        .map((c) => {
          const table = [...tables.values()].find((t) => t.id === c.tableId);
          const state = reduce(events.get(c.id) || []);
          return {
            checkId: c.id,
            tableLabel: table ? table.label : '?',
            state: {
              status: state.status,
              totalCents: state.totalCents,
              paidCents: state.paidCents,
              tipCents: state.tipCents,
              anomalies: state.anomalies.length,
            },
          };
        });
      const confirmed = [...payments.values()].filter((p) => p.status === 'confirmado');
      return {
        venue: { name: venue.name },
        checks: rows,
        today: {
          confirmedCents: confirmed.reduce((s, p) => s + p.amountCents, 0),
          tipsCents: confirmed.reduce((s, p) => s + p.tipCents, 0),
          paymentsCount: confirmed.length,
          anomalies: rows.reduce((s, r) => s + r.state.anomalies, 0),
        },
      };
    },

    // --- writes --------------------------------------------------------------
    async appendEvent(checkId, type, payload) {
      if (!events.has(checkId)) throw new Error('unknown check');
      const log = events.get(checkId);
      const seq = log.length + 1;
      log.push({ seq, type, payload });
      return seq;
    },
    async registerCharge({ checkId, txid, amountCents, tipCents, payerLabel }) {
      txidToCheck.set(txid, checkId);
      payments.set(txid, {
        txid, checkId, amountCents, tipCents,
        payerLabel: payerLabel || null,
        status: 'pendente', createdAt: new Date().toISOString(),
      });
    },
    async recordPayment({ txid, kind, pspPayloadMasked, confirmedAt }) {
      const p = payments.get(txid);
      if (!p) return;
      payments.set(txid, {
        ...p,
        status: kind === 'refund' ? 'devolvido' : 'confirmado',
        pspPayloadMasked, confirmedAt,
      });
    },
  };
}

module.exports = { createMemoryStore };
