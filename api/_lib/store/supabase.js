'use strict';

const { DEFAULT_MARKET, isMarket, publicMarketView, market, showsVenueTaxId } = require('../markets');
const { documentoPublicavelDaCasa } = require('../br/documento.js');
const { confirmedMoney } = require('./confirmed-money');
/**
 * Erro 400 local — os dois stores precisam do mesmo, e o `http-error.js` só
 * exporta o mapa de status. Mesma forma do `create-charge.js:25`.
 */
function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

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
const { buildAtivacao, spDay } = require('../checks/ativacao');
const { RECIPIENT_TERMINAL } = require('../recipient-status');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`supabase store: missing env ${name}`);
  return v;
}

/**
 * O CÓDIGO DO POSTGRES SOBREVIVE AO `throw`.
 *
 * O erro do postgrest-js carrega um discriminador que estava sendo jogado fora:
 * uma falha de TRANSPORTE vira `{ code: '' | 'UND_ERR_*' }`, enquanto um erro
 * do SERVIDOR carrega um SQLSTATE. E SQLSTATE quer dizer que o servidor
 * produziu uma resposta completa — ou seja, a transação deu ROLLBACK e nada foi
 * escrito. Provável de esperar: `42883` (assinatura mudou — a 0030 acabou de
 * fazer um `create or replace`), `42703` (o código do incidente do Seatable),
 * `42501` (grant revogado), `23514`.
 *
 * Sem isso, o reparo tratava todo lance como "pode ter escrito" e reportava um
 * movimento na base da folha que provadamente não aconteceu — com valor em
 * centavos e mês, até 200 linhas por casa por noite, sob uma causa sistemática.
 * Achado pela revisão de segurança de 2026-09-09 (MEDIUM-1).
 */
/** SQLSTATE tem exatamente cinco caracteres; o PostgREST usa `PGRSTnnn`. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const PGRST_RE = /^PGRST\d+$/;

function throwOn(error, op) {
  if (!error) return;
  const e = new Error(`supabase store ${op}: ${error.message}`);
  /**
   * SÓ FORMA DE CÓDIGO — quem decide o que ele PROVA é quem lê.
   *
   * Medido no `@supabase/postgrest-js` 2.110.7 (o que está no lock): na rejeição
   * de fetch o `code` nasce `''` e nunca é atribuído — os ramos de `AbortError`
   * e `UND_ERR_HEADERS_OVERFLOW` até o reatribuem pra `''` de propósito. Então
   * o teste `/^UND_ERR/` que eu tinha escrito era CÓDIGO MORTO, e pior: a
   * condição real era "qualquer `code` verdadeiro", o que deixava passar um
   * corpo JSON de gateway com `code: 504` — número, que vira `'504'` na
   * coerção do regex e escapa. Um 504 de gateway é justamente o caso em que a
   * escrita PODE ter acontecido.
   *
   * Aqui só se afirma a FORMA. Quem decide se aquilo prova rollback é
   * `reconcile.js`, com lista de permissão — porque a resposta depende da
   * CLASSE do SQLSTATE, e classe é assunto de quem está julgando dinheiro.
   */
  if (typeof error.code === 'string' && (SQLSTATE_RE.test(error.code) || PGRST_RE.test(error.code))) {
    e.pgCode = error.code;
  }
  throw e;
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

/**
 * @param {object} [opts]
 * @param {object} [opts.client] cliente pronto — a costura pra teste de
 *   CONTRATO. Sem ela, o mapeamento coluna→campo não era verificável de fato:
 *   dava pra conferir que o nome aparece no `select` e que o campo aparece no
 *   objeto, e uma TROCA entre duas colunas satisfazia as duas conferências.
 *   Foi assim que a guarda de versão do reparo (0023) ficou inerte sem ninguém
 *   ver. Achado pela revisão de segurança de 2026-09-08.
 */
function createSupabaseStore({ url, serviceRoleKey, client: injected } = {}) {
  const client = injected || createClient(
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
            // O VALOR também decide, não só o mercado: onze dígitos nesta coluna
            // numa casa brasileira é CPF de alguém, e `/api/check` não tem
            // autenticação. Linhas antigas foram escritas antes do portão do
            // `createVenue` existir. Ver `documentoPublicavelDaCasa`.
            taxId: documentoPublicavelDaCasa(table.venues.market, table.venues.cnpj, showsVenueTaxId(table.venues.market)),
            // `cnpj` vai junto: sem documento de empresa provado a casa não pode
            // cobrar serviço, e o que não pode ser cobrado não é oferecido.
            ...publicMarketView(table.venues.market, { servicoBp: table.venues.servico_basis_points, cnpj: table.venues.cnpj }),
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
        // Os ACUMULADOS ESTORNADOS entram aqui porque a guarda de versão do
        // reparo (migração 0023) compara justamente eles. Sem as colunas, o
        // `repairRowFromLedger` mandava `0` sempre — e a guarda passava só na
        // linha virgem, ficando INERTE em toda linha que já teve estorno, que é
        // exatamente a família que ela existe pra proteger. Achado pela
        // revisão de segurança de 2026-09-08.
        // `venue_id`, `currency` e `created_at` entram porque o store de MEMÓRIA
        // os devolve, e um dublê que oferece campo que a produção não tem é uma
        // armadilha esperando o próximo leitor: ele usa, passa no teste, e em
        // produção recebe `undefined`. Nenhum código lê estes três hoje — é
        // justamente por isso que dá pra igualar agora, de graça. Ver
        // `store-shape.test.js`.
        .select('txid, check_id, venue_id, amount_cents, tip_cents, currency, confirmed_amount_cents, confirmed_tip_cents, payer_label, status, method, psp_payload_masked, confirmed_at, created_at, refunded_amount_cents, refunded_tip_cents')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'getPayment');
      if (!data) return null;
      return {
        txid: data.txid, checkId: data.check_id,
        amountCents: data.amount_cents, tipCents: data.tip_cents,
        payerLabel: data.payer_label, status: data.status, method: data.method,
        pspPayloadMasked: data.psp_payload_masked, confirmedAt: data.confirmed_at,
        refundedAmountCents: data.refunded_amount_cents || 0,
        refundedTipCents: data.refunded_tip_cents || 0,
        venueId: data.venue_id, currency: data.currency, createdAt: data.created_at,
        // Os CONFIRMADOS: as colunas que viram faturamento e gorjeta. O store
        // de memória as devolvia e este não — mesma armadilha dos três acima.
        confirmedAmountCents: data.confirmed_amount_cents,
        confirmedTipCents: data.confirmed_tip_cents,
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

    /**
     * Evento de dinheiro que não achou conta (migração 0024). Reentrega não
     * duplica: `psp_event_id` é único, e o conflito é sucesso — a linha já
     * está lá.
     * @returns {Promise<boolean>} true = registrado (ou já estava).
     */
    async recordOrphanMoneyEvent(e) {
      const { error } = await client.from('orphan_money_events').insert({
        kind: e.kind, psp: e.psp || null, event_type: e.eventType || null,
        txid: e.txid || null, psp_event_id: e.pspEventId || null,
        amount_cents: e.amountCents ?? null, payload: e.payload || null,
      });
      if (error && error.code === '23505') return true; // já registrado
      throwOn(error, 'recordOrphanMoneyEvent');
      return true;
    },

    /**
     * Registra que alguém ABRIU a conta na mesa (migração 0028).
     *
     * Idempotente por (conta, sessão): o app consulta a conta a cada 4
     * segundos, e contar leitura seria contar polling em vez de gente. O
     * conflito é sucesso — a pessoa já estava contada.
     */
    async recordCheckView({ checkId, venueId, tableId, sessionHash }) {
      const { error } = await client.from('check_views').insert({
        check_id: checkId, venue_id: venueId, table_id: tableId || null,
        session_hash: sessionHash,
      });
      if (error && error.code === '23505') return false;   // já contada
      throwOn(error, 'recordCheckView');
      return true;
    },

    /**
     * O FUNIL de adoção por casa: abriram → pagaram. É o que o portão do
     * CLAUDE.md pede e o banco não sabia responder.
     */
    async getAdoptionFunnel(venueId, { sinceIso } = {}) {
      const desde = sinceIso || new Date(Date.now() - 30 * 86400000).toISOString();
      const [views, checks, pagos] = await Promise.all([
        client.from('check_views').select('check_id').eq('venue_id', venueId).gte('at', desde),
        client.from('checks').select('id').eq('venue_id', venueId).gte('opened_at', desde),
        client.from('payments').select('check_id').eq('venue_id', venueId)
          .eq('status', 'confirmado').gte('confirmed_at', desde),
      ]);
      throwOn(views.error || checks.error || pagos.error, 'getAdoptionFunnel');
      const abertas = new Set((views.data || []).map((r) => r.check_id));
      const pagas = new Set((pagos.data || []).map((r) => r.check_id));
      return {
        contasCriadas: (checks.data || []).length,
        contasAbertasNaMesa: abertas.size,
        contasPagas: pagas.size,
        // A leitura do portão: das contas que alguém ABRIU, quantas fecharam
        // pelo Racha. Sem o denominador certo, 25% não quer dizer nada.
        conversao: abertas.size > 0 ? pagas.size / abertas.size : null,
      };
    },

    /** Órfãos ainda ABERTOS — o que a conciliação diária tem que gritar. */
    async listOpenOrphanMoneyEvents(limit = 50) {
      const { data, error } = await client
        .from('orphan_money_events')
        .select('id, at, kind, psp, event_type, txid, amount_cents')
        .is('resolved_at', null)
        .order('at', { ascending: false })
        .limit(limit);
      throwOn(error, 'listOpenOrphanMoneyEvents');
      return (data || []).map((o) => ({
        id: o.id, at: o.at, kind: o.kind, psp: o.psp,
        eventType: o.event_type, txid: o.txid, amountCents: o.amount_cents,
      }));
    },

    /**
     * Reprojeta a linha a partir do razão SÓ se ela ainda estiver como foi
     * lida (migração 0023). Claim condicional → RPC com o erro conferido
     * (inegociável #7): a reparação roda justamente quando há duas entregas em
     * voo, e um UPDATE cego perdia a escrita da outra.
     * @returns {Promise<boolean>} true = reparou; false = a linha mudou.
     */
    async repairPaymentRow(p) {
      const { data, error } = await client.rpc('repair_payment_row', {
        p_txid: p.txid,
        p_expected_status: p.expectedStatus,
        p_expected_refunded_amount: p.expectedRefundedAmountCents,
        p_expected_refunded_tip: p.expectedRefundedTipCents,
        p_status: p.status,
        p_confirmed_amount: p.confirmedAmountCents,
        p_confirmed_tip: p.confirmedTipCents,
        p_refunded_amount: p.refundedAmountCents,
        p_refunded_tip: p.refundedTipCents,
        p_confirmed_at: p.confirmedAt || null,
        // QUEM pediu (migração 0029). O log gravava "reentrega de webhook" pros
        // três chamadores, e a varredura noturna — que roda sem ninguém
        // presente e escreve a base da folha — era um deles. Registro que
        // descreve a operação errada é prova pior que nenhuma (LGPD art. 37).
        p_source: p.source || null,
      });
      throwOn(error, 'repairPaymentRow'); // claim com erro NUNCA é "pulou"
      return data === true;
    },

    /**
     * Expira uma cobrança SÓ enquanto ela ainda está `pendente` (migração
     * 0020). Claim condicional → RPC com o erro conferido (inegociável #7):
     * um UPDATE cego aqui apagava um pagamento confirmado quando o
     * `payment_failed` chegava depois do `succeeded`.
     * @returns {Promise<boolean>} true = expirou agora.
     */
    async expirePaymentIfPending(txid) {
      const { data, error } = await client.rpc('expire_payment_if_pending', { p_txid: txid });
      throwOn(error, 'expirePaymentIfPending'); // claim com erro NUNCA é "pulou"
      return data === true;
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
      // O RÓTULO DO PAGADOR É CONFERIDO AQUI, no único ponto por onde TODA
      // cobrança passa. A regra existia só no `create-charge`, e o
      // `/api/pay/stripe-intent` — pública, token de mesa, sem sessão — chama
      // o `registerCharge` DIRETO: um `payerLabel` de 900 KB, ou um objeto no
      // lugar de uma string, chegava intacto à coluna que o painel do dono lê
      // de volta. É a forma "chamador esquecido" que este repositório já
      // nomeia três vezes, e o conserto é o mesmo das outras: a regra desce
      // pro sítio que não dá pra contornar, em vez de virar mais um item num
      // censo de chamadores. Achado pela revisão de segurança de 2026-09-15.
      if (payerLabel !== null && payerLabel !== undefined
        && (typeof payerLabel !== 'string' || payerLabel.length > 60)) {
        throw badRequest('payerLabel must be a string of at most 60 chars');
      }
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
          // `undefined` e NAO MEXER — explicito, e nao por acidente do
          // serializador. Era o `JSON.stringify` do supabase-js dropando a
          // chave que fazia isto funcionar, e o store de memoria, que nao tem
          // serializador, apagava a data. Ver `recordPayment` la.
          ...(pspPayloadMasked !== undefined ? { psp_payload_masked: pspPayloadMasked } : {}),
          ...(confirmedAt !== undefined ? { confirmed_at: confirmedAt } : {}),
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

    /**
     * Cobranças CONFIRMADAS recentes de um restaurante — pra conferir o destino
     * do dinheiro nos recebíveis do adquirente (a terceira perna).
     *
     * Limitada por janela e por quantidade porque cada uma custa uma chamada de
     * API: a varredura diária não pode virar mil requisições.
     */
    /**
     * Quantas cobranças a casa JÁ confirmou — sem janela.
     *
     * `listRecentConfirmedCharges` tem recorte de data porque alimenta a perna
     * por cobrança, que é I/O externo. O guarda de recebedor inutilizável faz
     * uma pergunta diferente: "esta casa já recebeu dinheiro alguma vez?" — uma
     * propriedade PERMANENTE. Perguntá-la pela janela de 24h fazia o achado se
     * calar no dia seguinte. `head: true` não traz linha nenhuma, só o total.
     */
    async contarCobrancasConfirmadas(venueId) {
      if (!isUuid(venueId)) return 0;
      const { count, error } = await client
        .from('payments')
        .select('txid', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('status', 'confirmado')
        .not('confirmed_at', 'is', null)
        // `house_account` não passa por adquirente: não tem recebível, e por
        // isso não conta como "dinheiro que precisa de destino conferível".
        .neq('method', 'house_account');
      throwOn(error, 'contarCobrancasConfirmadas');
      return count || 0;
    },

    async listRecentConfirmedCharges(venueId, { sinceIso, limit = 50 } = {}) {
      let q = client
        .from('payments')
        .select('txid, check_id, amount_cents, tip_cents, confirmed_amount_cents, confirmed_tip_cents, method, confirmed_at')
        .eq('venue_id', venueId)
        .eq('status', 'confirmado')
        .not('confirmed_at', 'is', null)
        .order('confirmed_at', { ascending: false })
        .limit(limit);
      if (sinceIso) q = q.gte('confirmed_at', sinceIso);
      const { data, error } = await q;
      throwOn(error, 'listRecentConfirmedCharges');
      return (data || [])
        // `house_account` não passa por adquirente: não tem recebível.
        .filter((p) => p.method !== 'house_account')
        .map((p) => ({
          txid: p.txid, checkId: p.check_id, method: p.method, confirmedAt: p.confirmed_at,
          // O CAPTURADO, que é contra o que os recebíveis são conferidos.
          paidAmountCents: Number.isFinite(p.confirmed_amount_cents)
            ? (p.confirmed_amount_cents || 0) + (p.confirmed_tip_cents || 0)
            : (p.amount_cents || 0) + (p.tip_cents || 0),
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
          // Os CONFIRMADOS entram na leitura da conciliação: são as colunas
          // que o painel soma em faturamento e em GORJETA (base da folha, Lei
          // 13.419), e até aqui elas eram conferidas contra NADA. Ver
          // `reconcileCheck`.
          .select('txid, amount_cents, tip_cents, confirmed_amount_cents, confirmed_tip_cents, refunded_amount_cents, refunded_tip_cents, status, method, currency, confirmed_at')
          .eq('check_id', c.id);
        throwOn(pErr, 'listChecksForReconcile.payments');
        out.push({
          checkId: c.id,
          events: await loadEvents(c.id),
          payments: (pays || []).map((p) => ({
            txid: p.txid, amountCents: p.amount_cents, tipCents: p.tip_cents,
            status: p.status, method: p.method, currency: p.currency,
            // Nulo é histórico (linha anterior à migração 0015): o
            // `confirmedMoney` cai no registrado, e a conciliação faz o mesmo.
            confirmedAmountCents: p.confirmed_amount_cents,
            confirmedTipCents: p.confirmed_tip_cents,
            // A DATA: é ela que faz a dívida de restituição envelhecer.
            confirmedAt: p.confirmed_at,
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
      // O documento da casa, quando ela ainda não tinha: ver o comentário na
      // rota. Comprovante e liquidação passam a ser o mesmo documento.
      if (opts.cnpj !== undefined) patch.cnpj = opts.cnpj;
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
    /**
     * Retenção (migração 0031). Anonimiza o que passou do prazo e devolve a
     * CONTAGEM por categoria — zero muitos dias seguidos é sinal de que parou
     * de rodar, não de que não havia o que apagar. Ver docs/compliance/retencao.md.
     */
    async purgeExpiredPersonalData(prazos = {}) {
      const { data, error } = await client.rpc('purge_expired_personal_data', {
        p_label_days: prazos.labelDays ?? 90,
        p_wallet_days: prazos.walletDays ?? 90,
        p_views_days: prazos.viewsDays ?? 90,
      });
      throwOn(error, 'purgeExpiredPersonalData');
      return {
        payerLabels: Number(data?.payer_labels ?? 0),
        payerHints: Number(data?.payer_hints ?? 0),
        houseAccounts: Number(data?.house_accounts ?? 0),
        checkViews: Number(data?.check_views ?? 0),
      };
    },

    /**
     * A ÚLTIMA execução da retenção — e é isto que torna "a ausência é o
     * alarme" verdadeiro. Sem este registro, cron parado e cron sem nada pra
     * apagar reportam a mesma coisa (zero), e a diferença só existia na cabeça
     * de quem lembrasse de conferir. Ver migração 0032.
     */
    async lastRetentionRun() {
      const { data, error } = await client
        .from('retention_runs')
        // Sem `kind` no select: o filtro já o fixa em 'purge' e nada lê de
        // volta — selecionar campo que ninguém usa é o que fez os dois stores
        // divergirem em forma sem ninguém notar.
        .select('at, payer_labels, payer_hints, house_accounts, check_views')
        .eq('kind', 'purge')
        .order('at', { ascending: false })
        .limit(1);
      throwOn(error, 'lastRetentionRun');
      const r = (data || [])[0];
      if (!r) return null;
      return {
        at: r.at,
        payerLabels: Number(r.payer_labels ?? 0),
        payerHints: Number(r.payer_hints ?? 0),
        houseAccounts: Number(r.house_accounts ?? 0),
        checkViews: Number(r.check_views ?? 0),
      };
    },

    /**
     * Pedido do titular (art. 18 IV): o nome livre de UM pagamento sai AGORA,
     * não no dia 90. Instrumento limitado no lugar de SQL ad-hoc com a service
     * role — ver migração 0031.
     */
    async erasePaymentLabel(txid) {
      const { data, error } = await client.rpc('erase_payment_label', { p_txid: txid });
      throwOn(error, 'erasePaymentLabel');
      return Number(data ?? 0);
    },

    async listVenueActivation() {
      const { data, error } = await client.rpc('venue_activation_stats');
      throwOn(error, 'listVenueActivation');
      const ms = (v) => (v ? Date.parse(v) : null);
      return (data || []).map((r) => ({
        id: r.id,
        name: r.name,
        isTest: r.is_test === true,
        recebedorOk: r.recebedor_ok === true,
        /**
         * O ID do recebedor, não só o booleano `recebedor_ok`.
         *
         * A terceira perna da conciliação compara os recebíveis do adquirente
         * contra ELE. Só o booleano chegava, então a perna rodava com
         * `undefined`: `payables_no_recipient` ALTO pra toda casa com cobrança
         * nas últimas 24h, toda noite, e `custody_leak` — o achado que responde
         * a pergunta de custódia do inegociável #4 — inalcançável. Uma chamada
         * de API por cobrança, paga pra não conferir nada.
         *
         * Meu teste inventava o campo num store escrito à mão, e o censo de
         * encanamento conferia os três parâmetros de que eu tinha lembrado.
         * Ver a migração 0027 e `store-shape.test.js`.
         * Achado pelas duas revisões de 2026-09-08.
         */
        pspRecipientId: r.psp_recipient_id || null,
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
    /** Ver o gêmeo em `memory.js` e `assertLoadSlot`. */
    async countPendingHouseLoads({ accountId, windowMs = null } = {}) {
      let q = client
        .from('house_loads')
        .select('txid', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('status', 'pendente');
      if (windowMs != null && Number.isFinite(windowMs)) {
        q = q.gte('created_at', new Date(Date.now() - windowMs).toISOString());
      }
      const { count, error } = await q;
      throwOn(error, 'countPendingHouseLoads');
      return count || 0;
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
    async getPanelView(venueId, nowIso = new Date().toISOString()) {
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
      /**
       * txid → quanto daquele pagamento entrou a MAIS e ainda falta restituir.
       *
       * Sai daqui porque é aqui que os eventos são reduzidos: o excedente vive
       * no RAZÃO, e `payments` não tem coluna pra ele. Serve pra série semanal
       * não contar dívida como receita (CC art. 876) — o widget do dia já
       * descontava, e a série ao lado dele não.
       */
      const sobraPorTxid = new Map();
      for (const c of checks || []) {
        const state = reduce(await loadEvents(c.id));
        for (const [txid, pg] of Object.entries(state.payments || {})) {
          const falta = Math.max(0, (pg.excessCents || 0) - (pg.refundedAmountCents || 0));
          if (falta > 0) sobraPorTxid.set(txid, falta);
        }
        rows.push({
          checkId: c.id,
          tableLabel: c.venue_tables ? c.venue_tables.label : '?',
          state: {
            status: state.status,
            totalCents: state.totalCents,
            paidCents: state.paidCents,
            tipCents: state.tipCents,
            anomalies: state.anomalies.length,
            // A SOBRA a devolver, por conta. O redutor já a calculava e o
            // número morria ali: nenhum painel, nenhuma tela. Ver
            // `overpaid_pending_restitution` na conciliação.
            overpaidCents: state.overpaidCents,
            /**
             * QUAL cobrança devolver — o painel não podia dizer.
             *
             * O dono lia "R$ 90,00 a devolver a clientes" e tinha que adivinhar
             * qual cobrança abrir no painel do adquirente. Uma obrigação que a
             * tela anuncia e não sabe endereçar não é acionável (CC art. 876:
             * a restituição não espera o cliente pedir). O txid é do LADO DO
             * DONO, atrás de auth — a leitura pública segue com ordinal.
             */
            /**
             * QUAL cobrança devolver, e QUANTO.
             *
             * A primeira versão filtrava "tem consumo devolvível" e reportava
             * o saldo devolvível INTEIRO — então numa conta rachada listava as
             * cobranças de quem pagou exato, com o valor cheio do pagamento. O
             * runbook manda o operador devolver "o valor que o painel indica":
             * seguido à letra, ele estornava o pagador errado, ou estornava um
             * pagamento inteiro e reabria uma conta quitada (a mesa cobrada de
             * novo, CDC art. 42). Achado pela revisão de compliance de
             * 2026-09-08.
             *
             * Agora: só quem TEM excedente, e o valor é o que falta restituir
             * daquele pagamento. Fica do lado do dono, atrás de auth — a
             * leitura pública segue com ordinal.
             */
            ...(state.overpaidCents > 0 ? {
              overpaidTxids: Object.entries(state.payments)
                .map(([txid, pg]) => ({
                  txid,
                  restituteCents: Math.max(0, (pg.excessCents || 0) - (pg.refundedAmountCents || 0)),
                }))
                .filter((x) => x.restituteCents > 0),
            } : {}),
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

      /**
       * A janela de 7 DIAS, e o `today` recortado do dia de verdade.
       *
       * A consulta não tinha predicado de data nenhum, e o resultado saía sob
       * o rótulo "recebido hoje" e "serviço da equipe (folha)". Um dono que
       * leia aquela linha como a gorjeta do dia e distribua está distribuindo o
       * acumulado da VIDA da casa — base de folha (Lei 13.419) lida de um
       * agregado com rótulo errado. Achado pela revisão de compliance de
       * 2026-09-08.
       *
       * A série semanal precisa de 7 dias, então a consulta busca 8 (folga de
       * fuso) e o `today` filtra o dia em São Paulo — o mesmo corte do
       * `buildAtivacao`, pra as duas linhas do painel nunca discordarem.
       */
      const desde = new Date(Date.parse(nowIso) - 8 * 86400000).toISOString();
      const { data: confirmedRaw, error: pErr } = await client
        .from('payments')
        // `txid` é a CHAVE do mapa de sobras que o `buildAtivacao` usa. Sem
        // ele, `sobraDe()` devolvia 0 pra toda linha e a série semanal seguia
        // contando dívida (CC art. 876) como receita — a correção existia e não
        // rodava. É a mesma armadilha documentada 120 linhas acima, onde eu
        // acrescentei `currency` ao mapeador e não ao select.
        .select('txid, amount_cents, tip_cents, confirmed_amount_cents, confirmed_tip_cents, refunded_amount_cents, refunded_tip_cents, check_id, confirmed_at, method')
        .eq('venue_id', venueId)
        .eq('status', 'confirmado')
        .gte('confirmed_at', desde);
      throwOn(pErr, 'getPanelView.payments');
      const confirmed = (confirmedRaw || [])
        .filter((p) => !trainingChecks.has(p.check_id))
        .map((p) => ({
          txid: p.txid,
          amountCents: p.amount_cents, tipCents: p.tip_cents,
          confirmedAmountCents: p.confirmed_amount_cents,
          confirmedTipCents: p.confirmed_tip_cents,
          refundedAmountCents: p.refunded_amount_cents || 0,
          refundedTipCents: p.refunded_tip_cents || 0,
          checkId: p.check_id, confirmedAt: p.confirmed_at, method: p.method,
        }));

      /**
       * A sobra a devolver, EXCLUINDO mesas de treino.
       *
       * `rows` é toda conta da casa; `confirmed` já filtra treino. Somar a
       * sobra sem o mesmo filtro descontava do faturamento um excedente de uma
       * mesa de treino cujo pagamento nunca foi contado — subnotificando a
       * receita (e qualquer margem calculada sobre ela). Workshop pré-turno não
       * é movimento da casa, nos dois sentidos.
       */
      /**
       * HOJE, no fuso de São Paulo — o mesmo corte da série semanal.
       *
       * `confirmed` cobre a janela inteira porque o `buildAtivacao` precisa
       * dela; o `today` é o recorte do dia. Sem isto a linha rotulada
       * "recebido hoje" somava tudo o que a casa já recebeu, e é dessa linha
       * que sai o número da gorjeta que vai pra folha.
       */
      // O INSTANTE vem de fora, com padrão de agora.
      //
      // Uma função que agrupa por dia tem que receber o dia: com o relógio
      // lido de dentro, um teste de relógio fixo não conseguia ver o próprio
      // pagamento — e o mesmo vale pra qualquer reprocessamento de um dia
      // passado. O `buildAtivacao` já era assim.
      const hoje = spDay(nowIso);
      const doDia = confirmed.filter((p) => p.confirmedAt && spDay(p.confirmedAt) === hoje);
      /**
       * A sobra do DIA, não a da vida da casa.
       *
       * `overpaidTotal` não tinha limite de data e era subtraída do
       * faturamento de HOJE: uma dívida de 90,00 de três semanas atrás baixava
       * a receita todo dia, e num dia fraco levava o número pra negativo. A
       * dívida acumulada continua aparecendo na conciliação, que é onde ela
       * pertence — o widget do dia fala do dia.
       */
      const contasDoDia = new Set(doDia.map((p) => p.checkId));
      const overpaidTotal = rows
        .filter((r) => contasDoDia.has(r.checkId))
        .filter((r) => !trainingChecks.has(r.checkId))
        .reduce((s, r) => s + (r.state.overpaidCents || 0), 0);

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
          //
          // MENOS a sobra a devolver: dinheiro que o cliente pagou a mais é
          // dívida da casa (CC art. 876), não receita dela. Estava indo
          // direto pro faturamento — e, no dia em que houver margem sobre
          // volume, a gente cobraria margem em cima da dívida também.
          confirmedCents: doDia.reduce((s, p) => s + confirmedMoney(p).amountCents, 0)
            - overpaidTotal,
          /** A dívida, na sua própria linha — visível, não subtraída em silêncio. */
          overpaidCents: overpaidTotal,
          tipsCents: doDia.reduce((s, p) => s + confirmedMoney(p).tipCents, 0),
          /**
           * Serviço COBRADO vs ARRECADADO — o contrapeso da regra de imputação.
           *
           * Num Pix pago a menor o serviço é o resíduo (ver
           * `allocateUnderpayment`): quem digita menos está recusando a linha
           * opcional, não devendo comida. Essa regra favorece sistematicamente
           * a casa na linha da gorjeta, então a diferença tem que ser VISÍVEL —
           * uma diferença que aparece é um fato do negócio; a mesma diferença
           * escondida é uma reclamação trabalhista.
           */
          /**
           * Cobrado vs ARRECADADO — e o estorno de fora dos dois.
           *
           * `tipsCents` é líquido de estorno (via `confirmedMoney`), e
           * `tipsChargedCents` era o bruto pedido: depois de qualquer estorno
           * parcial o painel dizia "R$ 5,50 de R$ 10,00 cobrados" quando a
           * diferença era um ESTORNO, não um cliente arredondando pra baixo.
           * Dois fatos do negócio diferentes debaixo da mesma legenda.
           *
           * Agora `tipsChargedCents` também é líquido do estornado: a diferença
           * que sobra é só a arrecadação a menor, que é o que a regra de
           * imputação produz e o que a folha precisa ver.
           */
          /**
           * O serviço COBRADO (bruto), o ARRECADADO (`tipsCents`, líquido) e o
           * ESTORNADO, em três linhas.
           *
           * Tentei resolver a confusão "estorno parecendo arrecadação a menor"
           * descontando o estorno também do cobrado — e aí os dois lados caíam
           * junto e a diferença DESAPARECIA. Ou seja: uma restituição que
           * raspasse a gorjeta ficava invisível justo no contrapeso que existe
           * pra mostrar isso. Três números não se confundem; dois com o mesmo
           * desconto se anulam. Achado pela revisão de compliance de
           * 2026-09-08.
           */
          tipsChargedCents: doDia.reduce((s, p) => s + (p.tipCents || 0), 0),
          tipsRefundedCents: doDia.reduce((s, p) => s + (p.refundedTipCents || 0), 0),
          paymentsCount: doDia.length,
          anomalies: rows.reduce((s, r) => s + r.state.anomalies, 0),
        },
        ativacao: buildAtivacao(confirmed, nowIso, sobraPorTxid),
      };
    },
  };
}

module.exports = { createSupabaseStore };
