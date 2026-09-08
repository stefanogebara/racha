'use strict';

const { DEFAULT_MARKET, isMarket, publicMarketView, market, showsVenueTaxId } = require('../markets');
const { confirmedMoney } = require('./confirmed-money');
const { disputeCounts } = require('../checks/disputes');

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
const { buildAtivacao } = require('../checks/ativacao');
const { RECIPIENT_TERMINAL } = require('../recipient-status');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`supabase store: missing env ${name}`);
  return v;
}

function throwOn(error, op) {
  if (error) throw new Error(`supabase store ${op}: ${error.message}`);
}

// Postgres errors on a non-uuid string in a uuid column; a malformed id from
// the app just means "not found", not a 500. Guard the id-taking reads.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// One venue shape everywhere (house-account config rides along).
const VENUE_COLS = 'id, name, city, cnpj, servico_basis_points, psp_recipient_id, pos_provider, active, '
  + 'psp_recipient_status, notify_email, notify_whatsapp, stripe_account_id, '
  + 'house_enabled, house_bonus_bp, house_validity_days, house_min_load_cents, house_max_load_cents, is_test, '
  + 'market';
function mapVenue(v) {
  if (!v) return null;
  return {
    id: v.id, name: v.name, city: v.city, cnpj: v.cnpj,
    servicoBp: v.servico_basis_points, pspRecipientId: v.psp_recipient_id,
    market: v.market ?? DEFAULT_MARKET,
    pspRecipientStatus: v.psp_recipient_status ?? null,
    stripeAccountId: v.stripe_account_id ?? null,
    notifyEmail: v.notify_email ?? null, notifyWhatsapp: v.notify_whatsapp ?? null,
    posProvider: v.pos_provider, active: v.active,
    houseEnabled: v.house_enabled, houseBonusBp: v.house_bonus_bp,
    houseValidityDays: v.house_validity_days,
    houseMinLoadCents: v.house_min_load_cents == null ? undefined : Number(v.house_min_load_cents),
    houseMaxLoadCents: v.house_max_load_cents == null ? undefined : Number(v.house_max_load_cents),
    // Marcador durável de venue de teste/demo: o `demo.js` exige isto antes de
    // fechar ou abrir qualquer conta, e o varredor de conciliação a exclui.
    isTest: v.is_test === true,
  };
}
function mapHouseAccount(a) {
  if (!a) return null;
  return {
    id: a.id, venueId: a.venue_id, phone: a.phone, name: a.name,
    accountToken: a.account_token, active: a.active !== false, createdAt: a.created_at,
  };
}

function createSupabaseStore({ url, serviceRoleKey } = {}) {
  const client = createClient(
    url || required('SUPABASE_URL'),
    serviceRoleKey || required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  async function loadEvents(checkId) {
    if (!isUuid(checkId)) return []; // malformed id → empty log → "not found"
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
    // cnpj default NULL de propósito: a migração 0002 tornou a coluna nulável
    // justamente porque CNPJ falso em recibo real é inaceitável — e o default
    // antigo ('00000000000191') é o CNPJ REAL do Banco do Brasil, que ia parar
    // no `tax_id` da conta conectada do Stripe (achado da revisão de compliance).
    async createVenue({ name, cnpj = null, city = null, servicoBp = 1000, pspRecipientId = null, isTest = false, market = DEFAULT_MARKET }) {
      if (!name || !String(name).trim()) throw new Error('venue name required');
      if (!Number.isInteger(servicoBp) || servicoBp < 0 || servicoBp > 3000) {
        throw new Error('servicoBp out of range [0,3000]');
      }
      // Escrita recusa mercado desconhecido (o CHECK do banco também recusaria,
      // mas com uma mensagem de Postgres em vez de uma nossa).
      if (!isMarket(market)) throw new Error(`unknown market: ${market}`);
      const { data, error } = await client
        .from('venues')
        .insert({
          name: String(name).trim(), cnpj, city,
          servico_basis_points: servicoBp,
          psp_recipient_id: pspRecipientId ?? null,
          is_test: isTest === true,
          market,
        })
        .select('id, name, city, servico_basis_points, psp_recipient_id, market')
        .single();
      throwOn(error, 'createVenue');
      return {
        id: data.id, name: data.name, city: data.city,
        servicoBp: data.servico_basis_points,
        pspRecipientId: data.psp_recipient_id,
        market: data.market ?? DEFAULT_MARKET,
      };
    },
    seedVenue(args) {
      return this.createVenue({ pspRecipientId: 'rcpt_demo', ...args });
    },
    async getVenue(venueId) {
      if (!isUuid(venueId)) return null;
      const { data, error } = await client
        .from('venues')
        .select(VENUE_COLS)
        .eq('id', venueId)
        .maybeSingle();
      throwOn(error, 'getVenue');
      return mapVenue(data);
    },
    async getTable(tableId) {
      if (!isUuid(tableId)) return null;
      const { data, error } = await client
        .from('venue_tables')
        .select('id, venue_id, label, qr_token, qr_rotated_at, active')
        .eq('id', tableId)
        .maybeSingle();
      throwOn(error, 'getTable');
      if (!data) return null;
      return {
        id: data.id, venueId: data.venue_id, label: data.label,
        qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at, active: data.active,
      };
    },
    async setCheckItems(checkId, items) {
      const { error } = await client
        .from('checks')
        .update({ pos_ref: JSON.stringify(items) }) // full JSON; count bounded upstream
        .eq('id', checkId);
      throwOn(error, 'setCheckItems');
    },

    // --- ownership / membership ---------------------------------------------
    async addVenueMember(venueId, userId, role = 'owner') {
      if (!userId) throw new Error('userId required');
      // ignoreDuplicates: an existing (venue,user) row is left UNTOUCHED — a
      // re-add never silently changes a member's role (matches the memory
      // store's short-circuit; review finding). Role changes are an explicit
      // future operation, not a side effect of re-adding.
      const { error } = await client
        .from('venue_members')
        .upsert({ venue_id: venueId, user_id: userId, role }, { onConflict: 'venue_id,user_id', ignoreDuplicates: true });
      throwOn(error, 'addVenueMember');
      return { venueId, userId, role };
    },
    async userOwnsVenue(userId, venueId) {
      if (!isUuid(userId) || !isUuid(venueId)) return false; // malformed → not an owner
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
        .select('venues(id, name, city, servico_basis_points, psp_recipient_id, market)')
        .eq('user_id', userId);
      throwOn(error, 'listVenuesForOwner');
      return (data || []).map((r) => r.venues).filter(Boolean).map((v) => ({
        id: v.id, name: v.name, city: v.city,
        servicoBp: v.servico_basis_points, pspRecipientId: v.psp_recipient_id,
        market: v.market ?? DEFAULT_MARKET,
      }));
    },
    async venueIdForTable(tableId) {
      if (!isUuid(tableId)) return null;
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
    async seedTable(venueId, label, fixedToken) {
      if (!fixedToken) return this.createTable(venueId, label);
      // Token fixo é affordance SÓ de seed (a mesa pública da demo). Mesas de
      // produção sempre nascem com token aleatório do default da coluna.
      const { data, error } = await client
        .from('venue_tables')
        .insert({ venue_id: venueId, label: String(label).trim(), qr_token: fixedToken })
        .select('id, venue_id, label, qr_token, qr_rotated_at, active')
        .single();
      throwOn(error, 'seedTable');
      return {
        id: data.id, venueId: data.venue_id, label: data.label,
        qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at, active: data.active,
      };
    },
    async listTables(venueId) {
      const { data: tabs, error } = await client
        .from('venue_tables')
        .select('id, label, qr_token, qr_rotated_at, active, training')
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
          qrRotatedAt: t.qr_rotated_at, active: t.active, training: t.training === true,
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
    /** Mesa de treino: paga normal, mas fica FORA das métricas do painel. */
    async setTableTraining(tableId, training) {
      const { data, error } = await client
        .from('venue_tables')
        .update({ training: !!training })
        .eq('id', tableId)
        .select('id, training')
        .single();
      throwOn(error, 'setTableTraining');
      return { id: data.id, training: data.training };
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
          // Full JSON — item count is bounded upstream (normalizeItems), so the
          // old 2000-char slice (which sliced mid-JSON → parse fail → the diner
          // saw an EMPTY item list on big checks) is gone (review finding).
          pos_ref: JSON.stringify(items),
        })
        .select('id')
        .single();
      // The partial unique index (checks_one_open_per_table) is the DB backstop
      // for one-open-check-per-table: a racing double-open loses here and gets a
      // friendly 409, not a 500.
      if (cErr && /checks_one_open_per_table|duplicate key/i.test(cErr.message)) {
        const e = new Error('mesa já tem uma conta aberta'); e.statusCode = 409; throw e;
      }
      throwOn(cErr, 'openCheck.insert');
      await this.appendEvent(check.id, 'OPENED', { totalCents });
      return { id: check.id, venueId: table.venue_id, tableId: table.id, items };
    },

    // --- reads -------------------------------------------------------------
    async getCheckByQrToken(qrToken) {
      const { data: table, error: tErr } = await client
        .from('venue_tables')
        // `market` no SELECT: sem ele a coluna chega undefined e a conta cai no
        // default brasileiro — uma mesa de Madrid cobrando em real, em silêncio.
        .select('id, label, venue_id, venues(name, cnpj, servico_basis_points, market)')
        .eq('qr_token', qrToken)
        .eq('active', true) // inactive/rotated token is dead (security property)
        .maybeSingle();
      throwOn(tErr, 'getCheckByQrToken.table');
      if (!table) return null;

      // Since migration 0004 the ONE cache transition that matters
      // (status → 'fechada' on CLOSED) is maintained inside the locked append
      // RPC and was backfilled, so filtering closed checks out HERE is safe —
      // and necessary: the old unfiltered `.limit(10)` oldest-first scan went
      // blind once a table accumulated 10 closed checks, killing the whole
      // pay flow for that table (review finding, HIGH). The derived-state
      // skip below stays as the authority (belt and suspenders).
      const { data: cands, error: cErr } = await client
        .from('checks')
        .select('id, pos_ref')
        .eq('table_id', table.id)
        .neq('status', 'fechada')
        .order('opened_at', { ascending: true })
        .limit(10);
      throwOn(cErr, 'getCheckByQrToken.check');

      for (const cand of cands || []) {
        const state = reduce(await loadEvents(cand.id));
        if (state.status === 'fechada') continue;
        let items = [];
        try { items = JSON.parse(cand.pos_ref) || []; } catch { items = []; }
        return {
          venue: {
            name: table.venues.name,
            taxId: showsVenueTaxId(table.venues.market) ? (table.venues.cnpj || null) : null,
            ...publicMarketView(table.venues.market, { servicoBp: table.venues.servico_basis_points }),
          },
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
      if (!isUuid(checkId)) return null;
      const { data, error } = await client
        .from('checks')
        .select(`venues(${VENUE_COLS})`)
        .eq('id', checkId)
        .maybeSingle();
      throwOn(error, 'getVenueForCheck');
      if (!data || !data.venues) return null;
      return mapVenue(data.venues);
    },

    async getPayment(txid) {
      const { data, error } = await client
        .from('payments')
        .select('txid, check_id, amount_cents, tip_cents, payer_label, status, method, psp_payload_masked, confirmed_at')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'getPayment');
      if (!data) return null;
      return {
        txid: data.txid, checkId: data.check_id,
        amountCents: data.amount_cents, tipCents: data.tip_cents,
        payerLabel: data.payer_label, status: data.status, method: data.method,
        pspPayloadMasked: data.psp_payload_masked, confirmedAt: data.confirmed_at,
      };
    },

    // --- writes ------------------------------------------------------------
    /**
     * @param {string} [pspEventId] id do evento do PSP. O RPC confere DENTRO do
     *   lock e devolve `seq` negativo quando já aplicou (migração 0018) — é o
     *   que fecha a corrida entre duas entregas simultâneas do mesmo evento.
     */
    async appendEvent(checkId, type, payload, pspEventId = null) {
      const { data, error } = await client.rpc('append_check_event', {
        p_check_id: checkId, p_type: type, p_payload: payload, p_psp_event_id: pspEventId,
      });
      throwOn(error, 'appendEvent'); // NEVER treat an errored claim as "skipped"
      return data;
    },

    /** Ver `seenPspEvent` no store de memória: resposta honesta, não garantia. */
    async seenPspEvent(pspEventId) {
      if (pspEventId == null) return false;
      const { data, error } = await client
        .from('check_events').select('seq').eq('psp_event_id', pspEventId).limit(1);
      throwOn(error, 'seenPspEvent');
      return Boolean(data && data.length);
    },
    async registerCharge({ checkId, txid, amountCents, tipCents, payerLabel, method = 'pix' }) {
      const { data: check, error: cErr } = await client
        .from('checks').select('venue_id, venues(market)').eq('id', checkId).single();
      throwOn(cErr, 'registerCharge.check');
      const { error } = await client.from('payments').insert({
        check_id: checkId, venue_id: check.venue_id, txid,
        method, amount_cents: amountCents, tip_cents: tipCents,
        payer_label: payerLabel || null,
        // A MOEDA na linha. Nunca deduzida na leitura a partir de
        // `venues.market`: o market pode mudar e o pagamento não — e a
        // conciliação compararia 20000 com 20000 atravessando uma troca de
        // moeda, reportando 0,00 de divergência. Ver 0014_payment_currency.sql.
        currency: market(check.venues && check.venues.market).currency,
      });
      throwOn(error, 'registerCharge');
    },

    async recordPayment({
      txid, kind, status, pspPayloadMasked, confirmedAt,
      confirmedAmountCents = null, confirmedTipCents = null,
      refundedAmountCents = null, refundedTipCents = null,
    }) {
      const { error } = await client
        .from('payments')
        .update({
          // Os valores CONFIRMADOS entram ao lado dos registrados, nunca em
          // cima (migração 0015). Sobrescrever seria a correção óbvia e
          // destruiria o detector: é comparar pedido contra log que produz o
          // `amount_mismatch`.
          ...(confirmedAmountCents !== null ? { confirmed_amount_cents: confirmedAmountCents } : {}),
          ...(confirmedTipCents !== null ? { confirmed_tip_cents: confirmedTipCents } : {}),
          // Acumulado ESTORNADO na linha (migração 0016) — ver `confirmedMoney`.
          ...(refundedAmountCents !== null ? { refunded_amount_cents: refundedAmountCents } : {}),
          ...(refundedTipCents !== null ? { refunded_tip_cents: refundedTipCents } : {}),
          // O status vem resolvido do módulo de dinheiro (ver
          // ROW_STATUS_FOR_KIND). Era `kind === 'refund' ? … : 'confirmado'` aqui,
          // e com a família da disputa lida de verdade esse `else` fazia uma
          // disputa PERDIDA virar `confirmado` com o dinheiro já ido.
          status: status || (kind === 'refund' ? 'devolvido' : 'confirmado'),
          psp_payload_masked: pspPayloadMasked,
          confirmed_at: confirmedAt,
        })
        .eq('txid', txid);
      throwOn(error, 'recordPayment');
    },

    // --- reconciliation -----------------------------------------------------
    /**
     * Pending PIX/card charges to actively reconcile against the PSP. A pure
     * READ (no PostgREST claim — rule 7 is about UPDATE+filter). Bounded by a
     * time window: created before now-graceMs (webhook got first crack) and
     * after now-windowMs (past-expiry charges drop out without any write).
     */
    async listPendingCharges({ checkId = null, graceMs = 0, windowMs = null, limit = 100 } = {}) {
      const now = Date.now();
      let q = client
        .from('payments')
        .select('txid, check_id, amount_cents, tip_cents, method, currency, created_at')
        .eq('status', 'pendente')
        // Exclusão, não inclusão — ver INLINE_METHODS no store de memória: uma
        // lista de inclusão deixava todo trilho novo (Bizum) fora da
        // reconciliação ativa, em silêncio.
        .not('method', 'in', '("house_account")')
        .lt('created_at', new Date(now - graceMs).toISOString())
        .order('created_at', { ascending: true })
        .limit(limit);
      if (windowMs != null && Number.isFinite(windowMs)) {
        q = q.gte('created_at', new Date(now - windowMs).toISOString());
      }
      if (checkId) q = q.eq('check_id', checkId);
      const { data, error } = await q;
      throwOn(error, 'listPendingCharges');
      return (data || []).map((r) => ({
        checkId: r.check_id, txid: r.txid,
        amountCents: r.amount_cents, tipCents: r.tip_cents, method: r.method,
        // `currency` viaja com a linha porque é a CONCILIAÇÃO que precisa dela:
        // comparar centavos por venue sem saber a moeda é o jeito de atravessar
        // uma troca de moeda reportando 0,00 de divergência.
        currency: r.currency,
        // `createdAt` pro julgamento de ABANDONO — ver `reconcile-charges.js`.
        createdAt: r.created_at,
      }));
    },

    async listChecksForReconcile(venueId) {
      const { data: checks, error } = await client
        .from('checks').select('id').eq('venue_id', venueId);
      throwOn(error, 'listChecksForReconcile.checks');
      const out = [];
      for (const c of checks || []) {
        const { data: pays, error: pErr } = await client
          .from('payments')
          .select('txid, amount_cents, tip_cents, refunded_amount_cents, refunded_tip_cents, status, method, currency')
          .eq('check_id', c.id);
        throwOn(pErr, 'listChecksForReconcile.payments');
        out.push({
          checkId: c.id,
          events: await loadEvents(c.id),
          payments: (pays || []).map((p) => ({
            txid: p.txid, amountCents: p.amount_cents, tipCents: p.tip_cents,
            status: p.status, method: p.method, currency: p.currency,
            // Acumulados estornados: a conciliação soma LÍQUIDO dos dois lados.
            refundedAmountCents: p.refunded_amount_cents || 0,
            refundedTipCents: p.refunded_tip_cents || 0,
          })),
        });
      }
      return out;
    },

    // --- house accounts (saldo da casa) -------------------------------------
    // Operational balances (principal_cents + house_bonus_lots) are written
    // ONLY by the house_* RPCs (locked per account, salt 43); reads here
    // derive from the ledger exactly like the memory store, so both stores
    // present identical views. listHouseAccountsForReconcile exposes the
    // stored columns for the cross-check.
    /**
     * A mesa por token IGNORANDO `active` — só pra decidir se ela já existe.
     * `getVenueByTableToken` filtra por ativa (propriedade de segurança: token
     * girado/desativado é token morto), e semear com base nesse null cria uma
     * venue órfã por request quando a mesa existe mas está desativada.
     */
    async findTableAnyState(qrToken) {
      if (!qrToken) return null;
      const { data, error } = await client
        .from('venue_tables')
        .select('id, venue_id, label, qr_token, active')
        .eq('qr_token', qrToken)
        .maybeSingle();
      throwOn(error, 'findTableAnyState');
      return data ? { id: data.id, venueId: data.venue_id, label: data.label, qrToken: data.qr_token, active: data.active } : null;
    },
    async getVenueByTableToken(qrToken) {
      if (!qrToken) return null;
      const { data, error } = await client
        .from('venue_tables')
        .select(`id, label, active, venues(${VENUE_COLS})`)
        .eq('qr_token', qrToken)
        .eq('active', true)
        .maybeSingle();
      throwOn(error, 'getVenueByTableToken');
      if (!data || !data.venues) return null;
      return { venue: mapVenue(data.venues), table: { id: data.id, label: data.label } };
    },
    /**
     * Grava o recebedor (re_) criado no PSP — a partir daí o split roteia. opts
     * carrega o status inicial (ex.: 'registration') e os contatos do dono pro
     * aviso de KYC (e-mail + WhatsApp), capturados no mesmo form.
     */
    async setVenueRecipient(venueId, recipientId, opts = {}) {
      const patch = { psp_recipient_id: recipientId };
      if (opts.status !== undefined) patch.psp_recipient_status = opts.status;
      if (opts.notifyEmail !== undefined) patch.notify_email = opts.notifyEmail;
      if (opts.notifyWhatsapp !== undefined) patch.notify_whatsapp = opts.notifyWhatsapp;
      const { data, error } = await client
        .from('venues')
        .update(patch)
        .eq('id', venueId)
        .select('id, psp_recipient_id')
        .single();
      throwOn(error, 'setVenueRecipient');
      return { id: data.id, pspRecipientId: data.psp_recipient_id };
    },
    /** Grava a conta conectada Stripe (acct_) do venue — rail de cartão/Apple Pay. */
    async setVenueStripeAccount(venueId, accountId) {
      const { data, error } = await client
        .from('venues')
        .update({ stripe_account_id: accountId })
        .eq('id', venueId)
        .select('id, stripe_account_id')
        .single();
      throwOn(error, 'setVenueStripeAccount');
      return { id: data.id, stripeAccountId: data.stripe_account_id };
    },
    /** Atualiza só o status do recebedor (o cron, ao detectar a transição KYC). */
    async setVenueRecipientStatus(venueId, status) {
      const { data, error } = await client
        .from('venues')
        .update({ psp_recipient_status: status })
        .eq('id', venueId)
        .select('id, psp_recipient_status')
        .single();
      throwOn(error, 'setVenueRecipientStatus');
      return { id: data.id, pspRecipientStatus: data.psp_recipient_status };
    },
    /**
     * Venues com recebedor ainda NÃO-terminal (segue no KYC) — o cron refetcha e
     * avisa na virada. Inclui registration, affiliation e afins; para de listar
     * só quando chega num terminal (active/refused/…), pra o dono ser avisado uma
     * vez e o venue sair da varredura.
     */
    async listVenuesPendingRecipient() {
      const { data, error } = await client
        .from('venues')
        .select(VENUE_COLS)
        .not('psp_recipient_status', 'is', null)
        .not('psp_recipient_status', 'in', `(${RECIPIENT_TERMINAL.join(',')})`);
      throwOn(error, 'listVenuesPendingRecipient');
      return (data || []).map(mapVenue);
    },
    /**
     * Números do funil de ativação, um registro por restaurante (RPC
     * venue_activation_stats — migração 0011). Datas viram epoch ms aqui, na
     * borda, porque o classificador (activation/radar.js) é puro e só fala
     * número: quem converte formato é o store, não a regra.
     */
    async listVenueActivation() {
      const { data, error } = await client.rpc('venue_activation_stats');
      throwOn(error, 'listVenueActivation');
      const ms = (v) => (v ? Date.parse(v) : null);
      return (data || []).map((r) => ({
        id: r.id,
        name: r.name,
        isTest: r.is_test === true,
        recebedorOk: r.recebedor_ok === true,
        recipientStatus: r.psp_recipient_status || null,
        mesasReais: Number(r.mesas_reais) || 0,
        mesasTotal: Number(r.mesas_total) || 0,
        contas: Number(r.contas) || 0,
        pagosConfirmados: Number(r.pagos_confirmados) || 0,
        valorCents: Number(r.valor_cents) || 0,
        ultimoPagamentoMs: ms(r.ultimo_pagamento),
        criadoMs: ms(r.created_at),
      }));
    },
    async setHouseConfig(venueId, clean) {
      const patch = {};
      if ('enabled' in clean) patch.house_enabled = clean.enabled;
      if ('bonusBp' in clean) patch.house_bonus_bp = clean.bonusBp;
      if ('validityDays' in clean) patch.house_validity_days = clean.validityDays;
      if ('minLoadCents' in clean) patch.house_min_load_cents = clean.minLoadCents;
      if ('maxLoadCents' in clean) patch.house_max_load_cents = clean.maxLoadCents;
      const { data, error } = await client
        .from('venues')
        .update(patch)
        .eq('id', venueId)
        .select(VENUE_COLS)
        .single();
      throwOn(error, 'setHouseConfig');
      return mapVenue(data);
    },
    async createHouseAccount({ venueId, phone, name }) {
      const { data, error } = await client.rpc('house_open_account', {
        p_venue_id: venueId, p_phone: phone, p_name: name,
      });
      if (error && /duplicate|unique/i.test(error.message)) throw new Error('duplicate house account');
      throwOn(error, 'createHouseAccount');
      return {
        id: data.id, venueId: data.venueId, phone: data.phone,
        name: data.name, accountToken: data.accountToken, createdAt: data.createdAt,
      };
    },
    async getHouseAccountByToken(token) {
      if (!token || typeof token !== 'string') return null;
      const { data, error } = await client
        .from('house_accounts')
        .select('id, venue_id, phone, name, account_token, created_at')
        .eq('account_token', token)
        .eq('active', true)
        .maybeSingle();
      throwOn(error, 'getHouseAccountByToken');
      return mapHouseAccount(data);
    },
    async getHouseAccountById(accountId) {
      if (!isUuid(accountId)) return null;
      const { data, error } = await client
        .from('house_accounts')
        .select('id, venue_id, phone, name, account_token, active, created_at')
        .eq('id', accountId)
        .maybeSingle();
      throwOn(error, 'getHouseAccountById');
      return mapHouseAccount(data);
    },
    async countHouseAccounts(venueId) {
      if (!isUuid(venueId)) return 0;
      const { count, error } = await client
        .from('house_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId);
      throwOn(error, 'countHouseAccounts');
      return count || 0;
    },
    async setHouseAccountActive(accountId, active) {
      if (!isUuid(accountId)) { const e = new Error('Conta não encontrada'); e.statusCode = 404; throw e; }
      const { data, error } = await client
        .from('house_accounts')
        .update({ active: !!active })
        .eq('id', accountId)
        .select('id, active')
        .maybeSingle();
      throwOn(error, 'setHouseAccountActive');
      if (!data) { const e = new Error('Conta não encontrada'); e.statusCode = 404; throw e; }
      return { id: data.id, active: data.active };
    },
    async loadHouseEvents(accountId) {
      if (!isUuid(accountId)) return [];
      const { data, error } = await client
        .from('house_account_events')
        .select('seq, type, payload')
        .eq('account_id', accountId)
        .order('seq', { ascending: true });
      throwOn(error, 'loadHouseEvents');
      return data || [];
    },
    async rotateHouseAccountToken(accountId) {
      if (!isUuid(accountId)) return null;
      const newToken = require('crypto').randomUUID().replace(/-/g, '');
      const { data, error } = await client
        .from('house_accounts')
        .update({ account_token: newToken })
        .eq('id', accountId)
        .select('id, account_token')
        .maybeSingle();
      throwOn(error, 'rotateHouseAccountToken');
      return data ? { id: data.id, accountToken: data.account_token } : null;
    },
    async listHouseAccounts(venueId) {
      if (!isUuid(venueId)) return [];
      const { data, error } = await client
        .from('house_accounts')
        .select('id, venue_id, phone, name, account_token, created_at')
        .eq('venue_id', venueId)
        .order('created_at', { ascending: true });
      throwOn(error, 'listHouseAccounts');
      return (data || []).map(mapHouseAccount);
    },
    async registerHouseLoad({ accountId, txid, amountCents, bonusCents, validityDays }) {
      const { error } = await client.from('house_loads').insert({
        txid, account_id: accountId, amount_cents: amountCents,
        bonus_cents: bonusCents, validity_days: validityDays,
      });
      throwOn(error, 'registerHouseLoad');
    },
    async findHouseLoadByTxid(txid) {
      if (!txid) return null;
      const { data, error } = await client
        .from('house_loads')
        .select('txid, account_id, amount_cents, bonus_cents, validity_days, status')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'findHouseLoadByTxid');
      if (!data) return null;
      return {
        txid: data.txid, accountId: data.account_id,
        amountCents: Number(data.amount_cents), bonusCents: Number(data.bonus_cents),
        validityDays: data.validity_days, status: data.status,
      };
    },
    async confirmHouseLoad({ txid, confirmedAt }) {
      const { data, error } = await client.rpc('house_confirm_load', {
        p_txid: txid, p_confirmed_at: confirmedAt,
      });
      throwOn(error, 'confirmHouseLoad');
      return { accountId: data.accountId, seq: data.seq, duplicate: data.duplicate === true };
    },
    async redeemHouse({ accountId, checkId, txid, amountCents, nowIso }) {
      const { data, error } = await client.rpc('house_redeem', {
        p_account_id: accountId, p_check_id: checkId, p_txid: txid,
        p_amount_cents: amountCents, p_now: nowIso,
      });
      if (error && /saldo insuficiente/i.test(error.message)) {
        const e = new Error('saldo insuficiente'); e.statusCode = 409; throw e;
      }
      if (error && /invalid amount/i.test(error.message)) {
        const e = new Error('invalid amount'); e.statusCode = 400; throw e;
      }
      if (error && /unknown house account/i.test(error.message)) {
        const e = new Error('Conta não encontrada'); e.statusCode = 404; throw e;
      }
      throwOn(error, 'redeemHouse');
      return {
        seq: data.seq, duplicate: data.duplicate === true,
        principalUsedCents: Number(data.principalUsedCents),
        bonusUsedCents: Number(data.bonusUsedCents),
      };
    },
    async reverseHouseRedeem({ accountId, txid, nowIso }) {
      const { data, error } = await client.rpc('house_redeem_reverse', {
        p_account_id: accountId, p_txid: txid, p_now: nowIso,
      });
      throwOn(error, 'reverseHouseRedeem');
      return { duplicate: data.duplicate === true, seq: data.seq };
    },
    async appendHousePaymentGuarded(checkId, txid, amountCents) {
      const { data, error } = await client.rpc('append_house_payment_guarded', {
        p_check_id: checkId, p_txid: txid, p_amount_cents: amountCents,
      });
      if (error && /excede o que falta|conta fechada/i.test(error.message)) {
        const e = new Error(error.message.replace(/^.*?(excede o que falta pagar|conta fechada).*$/i, '$1'));
        e.statusCode = 409; throw e;
      }
      throwOn(error, 'appendHousePaymentGuarded');
      return data;
    },
    async refundHousePrincipal({ accountId, amountCents, nowIso }) {
      const { data, error } = await client.rpc('house_refund_principal', {
        p_account_id: accountId, p_amount_cents: amountCents, p_now: nowIso,
      });
      if (error && /saldo insuficiente/i.test(error.message)) {
        const e = new Error('saldo insuficiente'); e.statusCode = 409; throw e;
      }
      if (error && /unknown house account/i.test(error.message)) {
        const e = new Error('Conta não encontrada'); e.statusCode = 404; throw e;
      }
      throwOn(error, 'refundHousePrincipal');
      return { seq: data.seq, principalCents: Number(data.principalCents) };
    },
    async recordHousePaymentRow({ checkId, venueId, txid, amountCents, confirmedAt }) {
      // Idempotent by txid: a healed retry re-attempts this write; an
      // existing row is left untouched (never silently rewritten).
      const { error } = await client.from('payments').upsert({
        check_id: checkId, venue_id: venueId, txid,
        method: 'house_account', amount_cents: amountCents, tip_cents: 0,
        status: 'confirmado', confirmed_at: confirmedAt,
      }, { onConflict: 'txid', ignoreDuplicates: true });
      throwOn(error, 'recordHousePaymentRow');
    },
    async listHouseAccountsForReconcile(venueId) {
      const { data: accounts, error } = await client
        .from('house_accounts')
        .select('id, principal_cents')
        .eq('venue_id', venueId);
      throwOn(error, 'listHouseAccountsForReconcile');
      const out = [];
      for (const a of accounts || []) {
        const { data: lots, error: lErr } = await client
          .from('house_bonus_lots')
          .select('event_seq, remaining_cents, expires_at')
          .eq('account_id', a.id);
        throwOn(lErr, 'listHouseAccountsForReconcile.lots');
        out.push({
          accountId: a.id,
          events: await this.loadHouseEvents(a.id),
          stored: {
            principalCents: Number(a.principal_cents),
            lots: (lots || []).map((l) => ({
              seq: l.event_seq,
              remainingCents: Number(l.remaining_cents),
              expiresAt: l.expires_at,
            })),
          },
        });
      }
      return out;
    },

    // --- panel --------------------------------------------------------------
    async getPanelView(venueId) {
      // `market` no SELECT, e não só no objeto de saída.
      //
      // A correção da moeda do painel foi metade da correção: eu acrescentei
      // `currency: market(venue.market).currency` na saída e NÃO acrescentei
      // `market` no select. Em memória o objeto tem o campo, então `npx jest`
      // ficou verde; em produção `venue.market` chega `undefined`, `market()`
      // cai no Brasil, e o painel de uma casa espanhola volta a dizer "R$" —
      // exatamente o bug que o commit dizia fechar, inclusive na linha de
      // GORJETA, que é o número que o dono leva pra folha.
      //
      // É a MESMA armadilha anotada duzentas linhas acima neste arquivo, na
      // leitura da conta: "sem ele a coluna chega undefined e a conta cai no
      // default brasileiro". Achado pela revisão de segurança.
      const { data: venue, error: vErr } = await client
        .from('venues').select('id, name, market').eq('id', venueId).maybeSingle();
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
            // Disputas por CONTAGEM: é a taxa de chargeback que o
            // adquirente julga, e o dono não tinha como ver a dele.
            disputes: disputeCounts(state),
          },
        });
      }

      // Mesas de TREINO ficam fora de todos os números (workshop pré-turno
      // não é movimento da casa) — espelha o memory store.
      const { data: trainingTables, error: ttErr } = await client
        .from('venue_tables')
        .select('id')
        .eq('venue_id', venueId)
        .eq('training', true);
      throwOn(ttErr, 'getPanelView.trainingTables');
      const trainingChecks = new Set();
      if ((trainingTables || []).length > 0) {
        const { data: tChecks, error: tcErr } = await client
          .from('checks')
          .select('id')
          .eq('venue_id', venueId)
          .in('table_id', trainingTables.map((t) => t.id));
        throwOn(tcErr, 'getPanelView.trainingChecks');
        for (const c of tChecks || []) trainingChecks.add(c.id);
      }

      const { data: confirmedRaw, error: pErr } = await client
        .from('payments')
        .select('amount_cents, tip_cents, confirmed_amount_cents, confirmed_tip_cents, refunded_amount_cents, refunded_tip_cents, check_id, confirmed_at, method')
        .eq('venue_id', venueId)
        .eq('status', 'confirmado');
      throwOn(pErr, 'getPanelView.payments');
      const confirmed = (confirmedRaw || [])
        .filter((p) => !trainingChecks.has(p.check_id))
        .map((p) => ({
          amountCents: p.amount_cents, tipCents: p.tip_cents,
          confirmedAmountCents: p.confirmed_amount_cents,
          confirmedTipCents: p.confirmed_tip_cents,
          refundedAmountCents: p.refunded_amount_cents || 0,
          refundedTipCents: p.refunded_tip_cents || 0,
          checkId: p.check_id, confirmedAt: p.confirmed_at, method: p.method,
        }));

      return {
        // A MOEDA vai no payload do painel porque o painel imprime dinheiro, e
        // o cliente não deve adivinhar. Sem ela, `brl()` caía no padrão BRL e o
        // dono de uma casa espanhola lia "R$" no faturamento do dia e na linha
        // de GORJETA — que é o número que ele leva pra folha. Achado da revisão
        // de compliance de 2026-09-07.
        venue: { name: venue.name, currency: market(venue.market).currency },
        checks: rows,
        today: {
          // O CONFIRMADO, com o registrado como reserva pra histórico anterior
          // à coluna. Somava o PEDIDO, então numa divergência o dono lia
          // faturamento e GORJETA errados — e a gorjeta é a base da folha
          // (Lei 13.419). Ver `confirmed-money.js` e a migração 0015.
          confirmedCents: confirmed.reduce((s, p) => s + confirmedMoney(p).amountCents, 0),
          tipsCents: confirmed.reduce((s, p) => s + confirmedMoney(p).tipCents, 0),
          paymentsCount: confirmed.length,
          anomalies: rows.reduce((s, r) => s + r.state.anomalies, 0),
        },
        ativacao: buildAtivacao(confirmed),
      };
    },
  };
}

module.exports = { createSupabaseStore };
