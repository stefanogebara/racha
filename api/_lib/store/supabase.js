'use strict';

/**
 * Supabase store — the production implementation of the store contract
 * defined by store/memory.js (same method surface, same shapes; the contract
 * suite in __tests__/store-contract.test.js runs against BOTH).
 *
 * Rules carried from hard lessons:
 * - Event appends go through the append_check_event RPC (advisory-locked,
 *   serialized per check). NEVER PostgREST update+or filters (2026-07-14:
 *   this PostgREST construct 42703s deterministically).
 * - EVERY PostgREST error is checked and thrown — no silent {data:null}
 *   swallows. Money paths fail loud.
 * - State is derived by reduce(events) on read. The checks-table cache
 *   columns are NOT maintained in v0 (a half-maintained cache caused a
 *   review finding; we derive until a transactional cache lands).
 * - psp_payload_masked receives ONLY the masked subset built upstream.
 */

const { createClient } = require('@supabase/supabase-js');
const { reduce } = require('../checks/check-state');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`supabase store: missing env ${name}`);
  return v;
}

function throwOn(error, op) {
  if (error) throw new Error(`supabase store ${op}: ${error.message}`);
}

function createSupabaseStore({ url, serviceRoleKey } = {}) {
  const client = createClient(
    url || required('SUPABASE_URL'),
    serviceRoleKey || required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  async function loadEvents(checkId) {
    const { data, error } = await client
      .from('check_events')
      .select('seq, type, payload')
      .eq('check_id', checkId)
      .order('seq', { ascending: true });
    throwOn(error, 'loadEvents');
    return data || [];
  }

  return {
    client, // exposed for tests/cleanup only

    // --- seeding / onboarding ---------------------------------------------
    async createVenue({ name, cnpj = '00000000000191', city = null, servicoBp = 1000, pspRecipientId = null }) {
      if (!name || !String(name).trim()) throw new Error('venue name required');
      if (!Number.isInteger(servicoBp) || servicoBp < 0 || servicoBp > 3000) {
        throw new Error('servicoBp out of range [0,3000]');
      }
      const { data, error } = await client
        .from('venues')
        .insert({
          name: String(name).trim(), cnpj, city,
          servico_basis_points: servicoBp,
          psp_recipient_id: pspRecipientId ?? null,
        })
        .select('id, name, city, servico_basis_points, psp_recipient_id')
        .single();
      throwOn(error, 'createVenue');
      return {
        id: data.id, name: data.name, city: data.city,
        servicoBp: data.servico_basis_points,
        pspRecipientId: data.psp_recipient_id,
      };
    },
    seedVenue(args) {
      return this.createVenue({ pspRecipientId: 'rcpt_demo', ...args });
    },
    async getVenue(venueId) {
      const { data, error } = await client
        .from('venues')
        .select('id, name, city, cnpj, servico_basis_points, psp_recipient_id, active')
        .eq('id', venueId)
        .maybeSingle();
      throwOn(error, 'getVenue');
      if (!data) return null;
      return {
        id: data.id, name: data.name, city: data.city, cnpj: data.cnpj,
        servicoBp: data.servico_basis_points, pspRecipientId: data.psp_recipient_id,
        active: data.active,
      };
    },

    // --- ownership / membership ---------------------------------------------
    async addVenueMember(venueId, userId, role = 'owner') {
      if (!userId) throw new Error('userId required');
      const { error } = await client
        .from('venue_members')
        .upsert({ venue_id: venueId, user_id: userId, role }, { onConflict: 'venue_id,user_id' });
      throwOn(error, 'addVenueMember');
      return { venueId, userId, role };
    },
    async userOwnsVenue(userId, venueId) {
      if (!userId || !venueId) return false;
      const { data, error } = await client
        .from('venue_members')
        .select('id')
        .eq('user_id', userId)
        .eq('venue_id', venueId)
        .maybeSingle();
      throwOn(error, 'userOwnsVenue');
      return !!data;
    },
    async listVenuesForOwner(userId) {
      const { data, error } = await client
        .from('venue_members')
        .select('venues(id, name, city, servico_basis_points, psp_recipient_id)')
        .eq('user_id', userId);
      throwOn(error, 'listVenuesForOwner');
      return (data || []).map((r) => r.venues).filter(Boolean).map((v) => ({
        id: v.id, name: v.name, city: v.city,
        servicoBp: v.servico_basis_points, pspRecipientId: v.psp_recipient_id,
      }));
    },
    async venueIdForTable(tableId) {
      if (!tableId) return null;
      const { data, error } = await client
        .from('venue_tables').select('venue_id').eq('id', tableId).maybeSingle();
      throwOn(error, 'venueIdForTable');
      return data ? data.venue_id : null;
    },

    async createTable(venueId, label) {
      if (!label || !String(label).trim()) throw new Error('table label required');
      const { data, error } = await client
        .from('venue_tables')
        .insert({ venue_id: venueId, label: String(label).trim() })
        .select('id, venue_id, label, qr_token, qr_rotated_at, active')
        .single();
      // unique_violation on (venue_id, label) surfaces as a clear message.
      if (error && /duplicate|unique/i.test(error.message)) throw new Error('duplicate table label');
      throwOn(error, 'createTable');
      return {
        id: data.id, venueId: data.venue_id, label: data.label,
        qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at, active: data.active,
      };
    },
    seedTable(venueId, label) {
      return this.createTable(venueId, label);
    },
    async listTables(venueId) {
      const { data: tabs, error } = await client
        .from('venue_tables')
        .select('id, label, qr_token, qr_rotated_at, active')
        .eq('venue_id', venueId);
      throwOn(error, 'listTables');
      // hasOpenCheck by DERIVED state (the checks.status cache is unmaintained
      // in v0 — reading it left the badge stuck TRUE forever; review finding).
      const { data: allChecks, error: cErr } = await client
        .from('checks')
        .select('id, table_id')
        .eq('venue_id', venueId);
      throwOn(cErr, 'listTables.checks');
      const openByTable = new Set();
      for (const c of allChecks || []) {
        if (openByTable.has(c.table_id)) continue;
        const state = reduce(await loadEvents(c.id));
        if (state.status !== 'fechada') openByTable.add(c.table_id);
      }
      return (tabs || [])
        .map((t) => ({
          id: t.id, label: t.label, qrToken: t.qr_token,
          qrRotatedAt: t.qr_rotated_at, active: t.active,
          hasOpenCheck: openByTable.has(t.id),
        }))
        // Same locale-numeric sort as the memory store (Mesa 2 < Mesa 10).
        .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true }));
    },
    /**
     * Rotate a table's QR token — the OLD token stops resolving immediately
     * (security property). Plain UPDATE by id (no or= filter → no PostgREST
     * 42703). Token generated app-side to mirror the column default.
     */
    async rotateTableQr(tableId, nowIso) {
      const newToken = require('crypto').randomUUID().replace(/-/g, '');
      const { data, error } = await client
        .from('venue_tables')
        .update({ qr_token: newToken, qr_rotated_at: nowIso || new Date().toISOString() })
        .eq('id', tableId)
        .select('id, qr_token, qr_rotated_at')
        .single();
      throwOn(error, 'rotateTableQr');
      return { id: data.id, qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at };
    },
    async setTableActive(tableId, active) {
      // Refuse to deactivate a table with an open check — no new token to fall
      // back to, so a mid-payment diner would be stranded (review finding).
      if (!active) {
        const { data: checkRows, error: cErr } = await client
          .from('checks').select('id').eq('table_id', tableId);
        throwOn(cErr, 'setTableActive.checks');
        for (const c of checkRows || []) {
          if (reduce(await loadEvents(c.id)).status !== 'fechada') {
            throw new Error('table has an open check — close it before deactivating');
          }
        }
      }
      const { data, error } = await client
        .from('venue_tables')
        .update({ active: !!active })
        .eq('id', tableId)
        .select('id, active')
        .single();
      throwOn(error, 'setTableActive');
      return { id: data.id, active: data.active };
    },

    async openCheck(tableQrToken, items) {
      const { data: table, error: tErr } = await client
        .from('venue_tables')
        .select('id, venue_id')
        .eq('qr_token', tableQrToken)
        .maybeSingle();
      throwOn(tErr, 'openCheck.table');
      if (!table) throw new Error('unknown table');

      const totalCents = items.reduce((s, i) => s + i.priceCents, 0);
      const { data: check, error: cErr } = await client
        .from('checks')
        .insert({
          venue_id: table.venue_id,
          table_id: table.id,
          total_cents: totalCents,
          pos_ref: JSON.stringify(items).slice(0, 2000),
        })
        .select('id')
        .single();
      throwOn(cErr, 'openCheck.insert');
      await this.appendEvent(check.id, 'OPENED', { totalCents });
      return { id: check.id, venueId: table.venue_id, tableId: table.id, items };
    },

    // --- reads -------------------------------------------------------------
    async getCheckByQrToken(qrToken) {
      const { data: table, error: tErr } = await client
        .from('venue_tables')
        .select('id, label, venue_id, venues(name, servico_basis_points)')
        .eq('qr_token', qrToken)
        .eq('active', true) // inactive/rotated token is dead (security property)
        .maybeSingle();
      throwOn(tErr, 'getCheckByQrToken.table');
      if (!table) return null;

      // Select the open check by DERIVED state, not the checks.status cache
      // (that column is intentionally unmaintained in v0 — filtering on it
      // would return a CLOSED check and leak the previous party's bill to the
      // next diner on a not-yet-rotated QR; review finding). Fetch the recent
      // candidates and pick the first whose reduced state isn't fechada.
      const { data: cands, error: cErr } = await client
        .from('checks')
        .select('id, pos_ref')
        .eq('table_id', table.id)
        .order('opened_at', { ascending: false })
        .limit(10);
      throwOn(cErr, 'getCheckByQrToken.check');

      for (const cand of cands || []) {
        const state = reduce(await loadEvents(cand.id));
        if (state.status === 'fechada') continue;
        let items = [];
        try { items = JSON.parse(cand.pos_ref) || []; } catch { items = []; }
        return {
          venue: { name: table.venues.name, servicoBp: table.venues.servico_basis_points },
          table: { label: table.label },
          check: { id: cand.id, items },
          state,
        };
      }
      return null;
    },

    loadEvents,

    async findCheckByTxid(txid) {
      const { data, error } = await client
        .from('payments')
        .select('check_id')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'findCheckByTxid');
      return data ? { id: data.check_id } : null;
    },

    async getVenueForCheck(checkId) {
      const { data, error } = await client
        .from('checks')
        .select('venues(id, name, servico_basis_points, psp_recipient_id)')
        .eq('id', checkId)
        .maybeSingle();
      throwOn(error, 'getVenueForCheck');
      if (!data || !data.venues) return null;
      return {
        id: data.venues.id, name: data.venues.name,
        servicoBp: data.venues.servico_basis_points,
        pspRecipientId: data.venues.psp_recipient_id,
      };
    },

    async getPayment(txid) {
      const { data, error } = await client
        .from('payments')
        .select('txid, check_id, amount_cents, tip_cents, payer_label, status, psp_payload_masked, confirmed_at')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'getPayment');
      if (!data) return null;
      return {
        txid: data.txid, checkId: data.check_id,
        amountCents: data.amount_cents, tipCents: data.tip_cents,
        payerLabel: data.payer_label, status: data.status,
        pspPayloadMasked: data.psp_payload_masked, confirmedAt: data.confirmed_at,
      };
    },

    // --- writes ------------------------------------------------------------
    async appendEvent(checkId, type, payload) {
      const { data, error } = await client.rpc('append_check_event', {
        p_check_id: checkId, p_type: type, p_payload: payload,
      });
      throwOn(error, 'appendEvent'); // NEVER treat an errored claim as "skipped"
      return data;
    },

    async registerCharge({ checkId, txid, amountCents, tipCents, payerLabel }) {
      const { data: check, error: cErr } = await client
        .from('checks').select('venue_id').eq('id', checkId).single();
      throwOn(cErr, 'registerCharge.check');
      const { error } = await client.from('payments').insert({
        check_id: checkId, venue_id: check.venue_id, txid,
        method: 'pix', amount_cents: amountCents, tip_cents: tipCents,
        payer_label: payerLabel || null,
      });
      throwOn(error, 'registerCharge');
    },

    async recordPayment({ txid, kind, pspPayloadMasked, confirmedAt }) {
      const { error } = await client
        .from('payments')
        .update({
          status: kind === 'refund' ? 'devolvido' : 'confirmado',
          psp_payload_masked: pspPayloadMasked,
          confirmed_at: confirmedAt,
        })
        .eq('txid', txid);
      throwOn(error, 'recordPayment');
    },

    // --- reconciliation -----------------------------------------------------
    async listChecksForReconcile(venueId) {
      const { data: checks, error } = await client
        .from('checks').select('id').eq('venue_id', venueId);
      throwOn(error, 'listChecksForReconcile.checks');
      const out = [];
      for (const c of checks || []) {
        const { data: pays, error: pErr } = await client
          .from('payments')
          .select('txid, amount_cents, tip_cents, status')
          .eq('check_id', c.id);
        throwOn(pErr, 'listChecksForReconcile.payments');
        out.push({
          checkId: c.id,
          events: await loadEvents(c.id),
          payments: (pays || []).map((p) => ({
            txid: p.txid, amountCents: p.amount_cents, tipCents: p.tip_cents, status: p.status,
          })),
        });
      }
      return out;
    },

    // --- panel --------------------------------------------------------------
    async getPanelView(venueId) {
      const { data: venue, error: vErr } = await client
        .from('venues').select('id, name').eq('id', venueId).maybeSingle();
      throwOn(vErr, 'getPanelView.venue');
      if (!venue) return null;

      const { data: checks, error: cErr } = await client
        .from('checks')
        .select('id, table_id, venue_tables(label)')
        .eq('venue_id', venueId)
        .order('opened_at', { ascending: true });
      throwOn(cErr, 'getPanelView.checks');

      const rows = [];
      for (const c of checks || []) {
        const state = reduce(await loadEvents(c.id));
        rows.push({
          checkId: c.id,
          tableLabel: c.venue_tables ? c.venue_tables.label : '?',
          state: {
            status: state.status,
            totalCents: state.totalCents,
            paidCents: state.paidCents,
            tipCents: state.tipCents,
            anomalies: state.anomalies.length,
          },
        });
      }

      const { data: confirmed, error: pErr } = await client
        .from('payments')
        .select('amount_cents, tip_cents')
        .eq('venue_id', venueId)
        .eq('status', 'confirmado');
      throwOn(pErr, 'getPanelView.payments');

      return {
        venue: { name: venue.name },
        checks: rows,
        today: {
          confirmedCents: (confirmed || []).reduce((s, p) => s + p.amount_cents, 0),
          tipsCents: (confirmed || []).reduce((s, p) => s + p.tip_cents, 0),
          paymentsCount: (confirmed || []).length,
          anomalies: rows.reduce((s, r) => s + r.state.anomalies, 0),
        },
      };
    },
  };
}

module.exports = { createSupabaseStore };
