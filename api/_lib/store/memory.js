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

  const tableById = new Map(); // id → table row (stable id; qrToken rotates)

  // Sync internals — the memory store is synchronous; the public contract is
  // async (matches the Supabase store, so `.rejects` works uniformly).
  function _mkVenue({ name, cnpj = null, city = null, servicoBp = 1000, pspRecipientId = null }) {
    if (!name || !String(name).trim()) throw new Error('venue name required');
    if (!Number.isInteger(servicoBp) || servicoBp < 0 || servicoBp > 3000) {
      throw new Error('servicoBp out of range [0,3000]');
    }
    const id = crypto.randomUUID();
    venues.set(id, { id, name: String(name).trim(), cnpj, city, servicoBp, pspRecipientId, active: true });
    return venues.get(id);
  }
  function _mkTable(venueId, label) {
    if (!venues.has(venueId)) throw new Error('unknown venue');
    if (!label || !String(label).trim()) throw new Error('table label required');
    const trimmed = String(label).trim();
    // Uniqueness scoped to ALL tables in the venue (active OR inactive) — mirrors
    // the DB `unique (venue_id, label)`. Reusing a deactivated table's label is
    // blocked in both stores (reactivate the old one instead).
    for (const t of tableById.values()) {
      if (t.venueId === venueId && t.label === trimmed) {
        throw new Error('duplicate table label');
      }
    }
    const qrToken = crypto.randomUUID().replace(/-/g, '');
    const id = crypto.randomUUID();
    const row = { id, venueId, label: trimmed, qrToken, qrRotatedAt: null, active: true };
    tables.set(qrToken, row);
    tableById.set(id, row);
    return { ...row };
  }

  return {
    // --- onboarding / venue -------------------------------------------------
    async createVenue(args) { return _mkVenue(args); },
    // Demo/test alias (SYNC — existing helpers call it without await).
    seedVenue({ name, servicoBp = 1000, pspRecipientId = 'rcpt_demo' }) {
      return _mkVenue({ name, servicoBp, pspRecipientId });
    },
    async getVenue(venueId) {
      return venues.get(venueId) || null;
    },

    // --- tables / QR --------------------------------------------------------
    async createTable(venueId, label) { return _mkTable(venueId, label); },
    seedTable(venueId, label) { return _mkTable(venueId, label); },
    async listTables(venueId) {
      return [...tableById.values()]
        .filter((t) => t.venueId === venueId)
        .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true }))
        .map((t) => {
          const openCheck = [...checks.values()].find(
            (c) => c.tableId === t.id && reduce(events.get(c.id) || []).status !== 'fechada',
          );
          return {
            id: t.id, label: t.label, qrToken: t.qrToken,
            qrRotatedAt: t.qrRotatedAt, active: t.active,
            hasOpenCheck: !!openCheck,
          };
        });
    },
    /**
     * Rotate a table's QR token. The OLD token stops resolving immediately —
     * a photographed QR must not grant indefinite access to future checks
     * (schema/review security property). The live check (tied to table_id,
     * not the token) stays reachable via the NEW token.
     */
    async rotateTableQr(tableId, nowIso) {
      const t = tableById.get(tableId);
      if (!t) throw new Error('unknown table');
      tables.delete(t.qrToken);
      t.qrToken = crypto.randomUUID().replace(/-/g, '');
      t.qrRotatedAt = nowIso || new Date().toISOString();
      tables.set(t.qrToken, t);
      return { id: t.id, qrToken: t.qrToken, qrRotatedAt: t.qrRotatedAt };
    },
    /**
     * Deactivate/reactivate a table. An inactive table's QR does NOT resolve.
     * Refuses to DEACTIVATE a table with an open check — that would strand a
     * mid-payment diner with no new token to fall back to (review finding).
     */
    async setTableActive(tableId, active) {
      const t = tableById.get(tableId);
      if (!t) throw new Error('unknown table');
      if (!active) {
        const open = [...checks.values()].some(
          (c) => c.tableId === t.id && reduce(events.get(c.id) || []).status !== 'fechada',
        );
        if (open) throw new Error('table has an open check — close it before deactivating');
      }
      t.active = !!active;
      return { id: t.id, active: t.active };
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
      if (!table || !table.active) return null; // inactive/rotated token is dead
      const check = [...checks.values()].find(
        (c) => c.tableId === table.id && reduce(events.get(c.id) || []).status !== 'fechada',
      );
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
