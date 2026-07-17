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
