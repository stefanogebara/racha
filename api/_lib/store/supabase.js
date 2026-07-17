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
    async seedVenue({ name, cnpj = '00000000000191', servicoBp = 1000, pspRecipientId }) {
      const { data, error } = await client
        .from('venues')
        .insert({
          name, cnpj,
          servico_basis_points: servicoBp,
          psp_recipient_id: pspRecipientId ?? null,
        })
        .select('id, name, servico_basis_points, psp_recipient_id')
        .single();
      throwOn(error, 'seedVenue');
      return {
        id: data.id, name: data.name,
        servicoBp: data.servico_basis_points,
        pspRecipientId: data.psp_recipient_id,
      };
    },

    async seedTable(venueId, label) {
      const { data, error } = await client
        .from('venue_tables')
        .insert({ venue_id: venueId, label })
        .select('id, venue_id, label, qr_token')
        .single();
      throwOn(error, 'seedTable');
      return { id: data.id, venueId: data.venue_id, label: data.label, qrToken: data.qr_token };
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
        .maybeSingle();
      throwOn(tErr, 'getCheckByQrToken.table');
      if (!table) return null;

      const { data: check, error: cErr } = await client
        .from('checks')
        .select('id, pos_ref')
        .eq('table_id', table.id)
        .neq('status', 'fechada')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      throwOn(cErr, 'getCheckByQrToken.check');
      if (!check) return null;

      let items = [];
      try { items = JSON.parse(check.pos_ref) || []; } catch { items = []; }

      return {
        venue: { name: table.venues.name, servicoBp: table.venues.servico_basis_points },
        table: { label: table.label },
        check: { id: check.id, items },
        state: reduce(await loadEvents(check.id)),
      };
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
