'use strict';

const { DEFAULT_MARKET, isMarket, publicMarketView } = require('../markets');

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
const { buildAtivacao } = require('../checks/ativacao');
const houseState = require('../house/account-state');
const { isTerminalRecipientStatus } = require('../recipient-status');

function createMemoryStore() {
  const venues = new Map();
  const tables = new Map();   // qrToken → { id, venueId, label, qrToken }
  const checks = new Map();   // checkId → { id, venueId, tableId, items: [] }
  const events = new Map();   // checkId → [{seq, type, payload}]
  const payments = new Map(); // txid → payment row
  const txidToCheck = new Map();

  const tableById = new Map(); // id → table row (stable id; qrToken rotates)
  const members = [];          // { venueId, userId, role }

  // House accounts (saldo da casa). Balances are DERIVED (reduce over the
  // ledger) — single-threaded sync writes make the validate→append pair
  // atomic here; the supabase store gets the same atomicity from the locked
  // house RPCs.
  const houseAccounts = new Map(); // id → { id, venueId, phone, name, accountToken, createdAt }
  const houseByToken = new Map();  // accountToken → accountId
  const houseEvents = new Map();   // accountId → [{seq, type, payload}]
  const houseLoads = new Map();    // txid → { txid, accountId, amountCents, bonusCents, validityDays, status }

  function _houseAppend(accountId, type, payload) {
    const log = houseEvents.get(accountId);
    if (!log) throw new Error('unknown house account');
    const state = houseState.reduce(log);
    houseState.validateEvent({ type, payload }, state); // strict append gate
    const seq = log.length + 1;
    log.push({ seq, type, payload });
    return seq;
  }

  // Last valid instant = 23:59:59.999 América/São_Paulo on (confirm date +
  // validity days) — the displayed "expira em DD/MM" is then exactly right.
  // BRT is UTC-3 year-round (no DST since 2019). Mirrors house_confirm_load v2.
  function _spEndOfDay(fromIso, plusDays) {
    const sp = new Date(Date.parse(fromIso) - 3 * 3600 * 1000); // SP wall clock
    const end = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + plusDays, 23, 59, 59, 999);
    return new Date(end + 3 * 3600 * 1000).toISOString(); // back to a UTC instant
  }

  // Sync internals — the memory store is synchronous; the public contract is
  // async (matches the Supabase store, so `.rejects` works uniformly).
  function _mkVenue({ name, cnpj = null, city = null, servicoBp = 1000, pspRecipientId = null, posProvider = 'manual', isTest = false, market = DEFAULT_MARKET }) {
    if (!name || !String(name).trim()) throw new Error('venue name required');
    if (!Number.isInteger(servicoBp) || servicoBp < 0 || servicoBp > 3000) {
      throw new Error('servicoBp out of range [0,3000]');
    }
    // Mercado desconhecido é ERRO, não um default silencioso: aqui é escrita, e
    // gravar 'fr' como se fosse Brasil produziria uma casa cobrando em real por
    // engano. Na LEITURA o default existe (venues antigas não têm o campo).
    if (!isMarket(market)) throw new Error(`unknown market: ${market}`);
    const id = crypto.randomUUID();
    venues.set(id, {
      id, name: String(name).trim(), cnpj, city, servicoBp, pspRecipientId, posProvider, active: true,
      market,
      isTest: isTest === true,
      pspRecipientStatus: null, notifyEmail: null, notifyWhatsapp: null, stripeAccountId: null,
      // Saldo da casa — off until the owner enables it. validityDays ≥ 30 is
      // the CDC-derived legal floor (docs/house-accounts/README.md).
      houseEnabled: false, houseBonusBp: 1000, houseValidityDays: 90,
      houseMinLoadCents: 2000, houseMaxLoadCents: 50000,
    });
    return venues.get(id);
  }
  function _mkTable(venueId, label, fixedToken) {
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
    // A fixed token is a SEED-ONLY affordance: prod tables always rotate
    // random tokens. The landing's live phone points at `demoracha`, which the
    // Supabase store has and the memory store otherwise would not.
    const qrToken = fixedToken || crypto.randomUUID().replace(/-/g, '');
    // Espelha o `unique` de venue_tables.qr_token: sem isto um segundo seed com
    // o mesmo token fixo re-aponta o token pra OUTRA venue em silêncio.
    if (tables.has(qrToken)) throw new Error('duplicate table token');
    const id = crypto.randomUUID();
    const row = { id, venueId, label: trimmed, qrToken, qrRotatedAt: null, active: true, training: false };
    tables.set(qrToken, row);
    tableById.set(id, row);
    return { ...row };
  }

  return {
    // --- onboarding / venue -------------------------------------------------
    async createVenue(args) { return _mkVenue(args); },
    // Demo/test alias (SYNC — existing helpers call it without await).
    seedVenue({ name, servicoBp = 1000, pspRecipientId = 'rcpt_demo', isTest = false, market = DEFAULT_MARKET }) {
      return _mkVenue({ name, servicoBp, pspRecipientId, isTest, market });
    },
    async getVenue(venueId) {
      return venues.get(venueId) || null;
    },

    // --- ownership / membership ---------------------------------------------
    async addVenueMember(venueId, userId, role = 'owner') {
      if (!venues.has(venueId)) throw new Error('unknown venue');
      if (!userId) throw new Error('userId required');
      if (members.some((m) => m.venueId === venueId && m.userId === userId)) {
        return { venueId, userId, role }; // idempotent
      }
      members.push({ venueId, userId, role });
      return { venueId, userId, role };
    },
    async userOwnsVenue(userId, venueId) {
      return members.some((m) => m.userId === userId && m.venueId === venueId);
    },
    async listVenuesForOwner(userId) {
      return members
        .filter((m) => m.userId === userId)
        .map((m) => venues.get(m.venueId))
        .filter(Boolean);
    },
    async venueIdForTable(tableId) {
      const t = tableById.get(tableId);
      return t ? t.venueId : null;
    },
    async getTable(tableId) {
      const t = tableById.get(tableId);
      return t ? { ...t } : null;
    },
    /** Replace the itemized snapshot the diner sees (manual ADJUSTED). */
    async setCheckItems(checkId, items) {
      const c = checks.get(checkId);
      if (!c) throw new Error('unknown check');
      checks.set(checkId, { ...c, items });
    },

    // --- tables / QR --------------------------------------------------------
    async createTable(venueId, label) { return _mkTable(venueId, label); },
    seedTable(venueId, label, fixedToken) { return _mkTable(venueId, label, fixedToken); },
    async findTableAnyState(qrToken) {
      const t = qrToken ? tables.get(qrToken) : null;
      return t ? { id: t.id, venueId: t.venueId, label: t.label, qrToken: t.qrToken, active: t.active } : null;
    },
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
            qrRotatedAt: t.qrRotatedAt, active: t.active, training: t.training === true,
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
    /** Mesa de treino: paga normal, mas fica FORA das métricas do painel. */
    async setTableTraining(tableId, training) {
      const t = tableById.get(tableId);
      if (!t) throw new Error('unknown table');
      t.training = !!training;
      return { id: t.id, training: t.training };
    },
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
      // One open check per table — enforced synchronously here (no await
      // between the check and the insert), the memory analog of the supabase
      // partial unique index (checks_one_open_per_table).
      const alreadyOpen = [...checks.values()].some((c) => {
        if (c.tableId !== table.id) return false;
        const st = reduce(events.get(c.id) || []);
        return !!st && st.status !== 'fechada';
      });
      if (alreadyOpen) { const e = new Error('mesa já tem uma conta aberta'); e.statusCode = 409; throw e; }
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
        // O mercado viaja PRONTO: moeda, trilhos, se há linha de serviço e se o
        // pagador precisa dar documento. O cliente desenha, não decide — a UI
        // inferindo uma regra de dinheiro foi o CRÍTICO #1 da revisão #37.
        venue: {
          name: venue.name,
          servicoBp: venue.servicoBp,
          ...publicMarketView(venue.market, { servicoBp: venue.servicoBp }),
        },
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
    /**
     * Pending PIX/card charges to actively reconcile against the PSP. Bounded
     * by a time WINDOW (not a status flag): older than `graceMs` (so the
     * webhook gets first crack) and younger than `windowMs` (charges past Pix
     * expiry stop being polled without any write). house_account rows are
     * excluded — they confirm inline, never via the gateway.
     */
    async listPendingCharges({ checkId = null, graceMs = 0, windowMs = Infinity, limit = 100 } = {}) {
      const now = Date.now();
      return [...payments.values()]
        .filter((p) => {
          if (p.status !== 'pendente') return false;
          if (p.method !== 'pix' && p.method !== 'card') return false;
          if (checkId && p.checkId !== checkId) return false;
          const age = now - Date.parse(p.createdAt);
          return age >= graceMs && age <= windowMs;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map((p) => ({ checkId: p.checkId, txid: p.txid, amountCents: p.amountCents, tipCents: p.tipCents, method: p.method }));
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
            .map((p) => ({ txid: p.txid, amountCents: p.amountCents, tipCents: p.tipCents, status: p.status, method: p.method || 'pix' })),
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
      // Venue-scoped like the supabase store — a shared demo instance must
      // never leak one venue's totals into another's panel (review finding).
      // Mesas de TREINO ficam fora de todos os números (workshop pré-turno
      // não é movimento da casa).
      const trainingChecks = new Set(
        [...checks.values()]
          .filter((c) => c.venueId === venueId && (tableById.get(c.tableId) || {}).training)
          .map((c) => c.id),
      );
      const confirmed = [...payments.values()].filter((p) =>
        p.status === 'confirmado'
        && (p.venueId ?? (checks.get(p.checkId) || {}).venueId) === venueId
        && !trainingChecks.has(p.checkId));
      return {
        venue: { name: venue.name },
        checks: rows,
        today: {
          confirmedCents: confirmed.reduce((s, p) => s + p.amountCents, 0),
          tipsCents: confirmed.reduce((s, p) => s + p.tipCents, 0),
          paymentsCount: confirmed.length,
          anomalies: rows.reduce((s, r) => s + r.state.anomalies, 0),
        },
        ativacao: buildAtivacao(confirmed),
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
    async registerCharge({ checkId, txid, amountCents, tipCents, payerLabel, method = 'pix' }) {
      txidToCheck.set(txid, checkId);
      const check = checks.get(checkId);
      payments.set(txid, {
        txid, checkId, venueId: check ? check.venueId : null, // panel scoping
        amountCents, tipCents,
        payerLabel: payerLabel || null, method,
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

    // --- house accounts (saldo da casa) -------------------------------------
    async getVenueByTableToken(qrToken) {
      const table = tables.get(qrToken);
      if (!table || !table.active) return null;
      return { venue: venues.get(table.venueId), table: { id: table.id, label: table.label } };
    },
    /** Grava o recebedor + status inicial + contatos do dono (aviso de KYC). */
    async setVenueRecipient(venueId, recipientId, opts = {}) {
      const venue = venues.get(venueId);
      if (!venue) throw new Error('unknown venue');
      venue.pspRecipientId = recipientId;
      if (opts.status !== undefined) venue.pspRecipientStatus = opts.status;
      if (opts.notifyEmail !== undefined) venue.notifyEmail = opts.notifyEmail;
      if (opts.notifyWhatsapp !== undefined) venue.notifyWhatsapp = opts.notifyWhatsapp;
      return { id: venue.id, pspRecipientId: recipientId };
    },
    async setVenueStripeAccount(venueId, accountId) {
      const venue = venues.get(venueId);
      if (!venue) throw new Error('unknown venue');
      venue.stripeAccountId = accountId;
      return { id: venue.id, stripeAccountId: accountId };
    },
    async setVenueRecipientStatus(venueId, status) {
      const venue = venues.get(venueId);
      if (!venue) throw new Error('unknown venue');
      venue.pspRecipientStatus = status;
      return { id: venue.id, pspRecipientStatus: status };
    },
    async listVenuesPendingRecipient() {
      return Array.from(venues.values()).filter(
        (v) => v.pspRecipientStatus && !isTerminalRecipientStatus(v.pspRecipientStatus),
      );
    },
    /**
     * Espelho em memória do RPC venue_activation_stats — mesmas definições:
     * mesa real = ativa e não-treino; pagamento = 'confirmado'; recebedor ok =
     * recipient r*_ fora de um terminal ruim. Manter os dois lados iguais é o
     * que faz o teste de contrato valer alguma coisa.
     */
    async listVenueActivation() {
      const RUINS = ['refused', 'suspended', 'blocked'];
      return Array.from(venues.values()).map((v) => {
        const mesas = [...tableById.values()].filter((t) => t.venueId === v.id);
        const contasDoVenue = [...checks.values()].filter((c) => c.venueId === v.id);
        const idsContas = new Set(contasDoVenue.map((c) => c.id));
        const pagos = [...payments.values()].filter(
          (p) => p.status === 'confirmado' && idsContas.has(p.checkId),
        );
        const ultimoMs = pagos.reduce((max, p) => {
          const t = Date.parse(p.confirmedAt || p.createdAt);
          return Number.isFinite(t) && t > max ? t : max;
        }, 0);
        return {
          id: v.id,
          name: v.name,
          isTest: v.isTest === true,
          recebedorOk: /^r[ep]_/.test(v.pspRecipientId || '')
            && !RUINS.includes(v.pspRecipientStatus || ''),
          recipientStatus: v.pspRecipientStatus || null,
          mesasReais: mesas.filter((t) => t.active && t.training !== true).length,
          mesasTotal: mesas.length,
          contas: contasDoVenue.length,
          pagosConfirmados: pagos.length,
          valorCents: pagos.reduce((s, p) => s + (p.amountCents || 0), 0),
          ultimoPagamentoMs: ultimoMs || null,
          criadoMs: v.createdAt ? Date.parse(v.createdAt) : null,
        };
      });
    },
    async setHouseConfig(venueId, clean) {
      const venue = venues.get(venueId);
      if (!venue) throw new Error('unknown venue');
      if ('enabled' in clean) venue.houseEnabled = clean.enabled;
      if ('bonusBp' in clean) venue.houseBonusBp = clean.bonusBp;
      if ('validityDays' in clean) venue.houseValidityDays = clean.validityDays;
      if ('minLoadCents' in clean) venue.houseMinLoadCents = clean.minLoadCents;
      if ('maxLoadCents' in clean) venue.houseMaxLoadCents = clean.maxLoadCents;
      return venue;
    },
    async createHouseAccount({ venueId, phone, name }) {
      if (!venues.has(venueId)) throw new Error('unknown venue');
      for (const a of houseAccounts.values()) {
        if (a.venueId === venueId && a.phone === phone) throw new Error('duplicate house account');
      }
      const id = crypto.randomUUID();
      const accountToken = crypto.randomUUID().replace(/-/g, '');
      const row = { id, venueId, phone, name, accountToken, active: true, createdAt: new Date().toISOString() };
      houseAccounts.set(id, row);
      houseByToken.set(accountToken, id);
      houseEvents.set(id, []);
      _houseAppend(id, 'OPENED', {});
      return { ...row };
    },
    async getHouseAccountByToken(token) {
      const id = houseByToken.get(token);
      const a = id ? houseAccounts.get(id) : null;
      return a && a.active ? { ...a } : null; // frozen account = dead token (parity w/ supabase)
    },
    async countHouseAccounts(venueId) {
      let n = 0;
      for (const a of houseAccounts.values()) if (a.venueId === venueId) n += 1;
      return n;
    },
    async setHouseAccountActive(accountId, active) {
      const a = houseAccounts.get(accountId);
      if (!a) { const e = new Error('Conta não encontrada'); e.statusCode = 404; throw e; }
      a.active = !!active;
      return { id: a.id, active: a.active };
    },
    async getHouseAccountById(accountId) {
      const a = houseAccounts.get(accountId);
      return a ? { ...a } : null;
    },
    async loadHouseEvents(accountId) {
      return [...(houseEvents.get(accountId) || [])];
    },
    async rotateHouseAccountToken(accountId) {
      const a = houseAccounts.get(accountId);
      if (!a) return null;
      houseByToken.delete(a.accountToken);
      a.accountToken = crypto.randomUUID().replace(/-/g, '');
      houseByToken.set(a.accountToken, a.id);
      return { id: a.id, accountToken: a.accountToken };
    },
    async listHouseAccounts(venueId) {
      return [...houseAccounts.values()]
        .filter((a) => a.venueId === venueId)
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
        .map((a) => ({ ...a }));
    },
    async registerHouseLoad({ accountId, txid, amountCents, bonusCents, validityDays }) {
      if (!houseAccounts.has(accountId)) throw new Error('unknown house account');
      // Mirrors the supabase PK: a txid re-register must fail loudly, never
      // silently replace money amounts (review finding).
      if (houseLoads.has(txid)) throw new Error('duplicate house load txid');
      houseLoads.set(txid, { txid, accountId, amountCents, bonusCents, validityDays, status: 'pendente' });
    },
    async findHouseLoadByTxid(txid) {
      const l = houseLoads.get(txid);
      return l ? { ...l } : null;
    },
    async confirmHouseLoad({ txid, confirmedAt }) {
      const load = houseLoads.get(txid);
      if (!load) throw new Error('unknown house load');
      const state = houseState.reduce(houseEvents.get(load.accountId) || []);
      if (state && state.loads[txid]) {
        return { accountId: load.accountId, seq: null, duplicate: true };
      }
      const bonusExpiresAt = _spEndOfDay(confirmedAt, load.validityDays);
      const seq = _houseAppend(load.accountId, 'LOAD_CONFIRMED', {
        txid, at: confirmedAt,
        principalCents: load.amountCents,
        bonusCents: load.bonusCents,
        ...(load.bonusCents > 0 ? { bonusExpiresAt } : {}),
      });
      houseLoads.set(txid, { ...load, status: 'confirmado' });
      return { accountId: load.accountId, seq, duplicate: false };
    },
    async redeemHouse({ accountId, checkId, txid, amountCents, nowIso }) {
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new Error('invalid amount'); // parity with the RPC's raise
      }
      const log = houseEvents.get(accountId);
      if (!log) throw new Error('unknown house account');
      const account = houseAccounts.get(accountId);
      if (!account || !account.active) throw new Error(`unknown house account ${accountId}`);
      const state = houseState.reduce(log);
      // idempotency: a retried redeem with the same txid returns the prior debit
      if (state && state.redeems[txid]) {
        const prior = state.redeems[txid];
        return {
          seq: null, duplicate: true,
          principalUsedCents: prior.principalCents, bonusUsedCents: prior.bonusCents,
        };
      }
      let plan;
      try {
        plan = houseState.planRedeem(state, amountCents, nowIso);
      } catch (e) {
        if (e instanceof houseState.HouseEventValidationError) {
          const err = new Error('saldo insuficiente'); err.statusCode = 409; throw err;
        }
        throw e;
      }
      const seq = _houseAppend(accountId, 'REDEEMED', {
        txid, checkId, at: nowIso,
        principalCents: plan.principalCents,
        bonusCents: plan.bonusCents,
        lots: plan.lots,
      });
      return { seq, duplicate: false, principalUsedCents: plan.principalCents, bonusUsedCents: plan.bonusCents };
    },
    /** Compensation: put the exact REDEEMED breakdown back (idempotent by txid). */
    async reverseHouseRedeem({ accountId, txid, nowIso }) {
      const log = houseEvents.get(accountId);
      if (!log) throw new Error('unknown house account');
      const state = houseState.reduce(log);
      const orig = state ? state.redeems[txid] : null;
      if (!orig) throw new Error(`unknown redeem txid ${txid}`);
      if (orig.reversed) return { duplicate: true };
      const seq = _houseAppend(accountId, 'REDEEM_REVERSED', {
        txid, at: nowIso, reason: 'check_append_refused',
      });
      return { duplicate: false, seq };
    },
    /**
     * Check-side append for credit redeems, validated ATOMICALLY (no await
     * between read and push — single-threaded sync = the memory analog of the
     * append_house_payment_guarded RPC). Credit must never overpay a check.
     */
    async appendHousePaymentGuarded(checkId, txid, amountCents) {
      const log = events.get(checkId);
      if (!log) throw new Error('unknown check');
      const state = reduce(log);
      if (state && state.payments[txid]) {
        return log.find((e) => e.type === 'PAYMENT_CONFIRMED' && e.payload.txid === txid).seq;
      }
      if (!state || state.status === 'fechada') {
        const e = new Error('conta fechada'); e.statusCode = 409; throw e;
      }
      if (state.paidCents + amountCents > state.totalCents) {
        const e = new Error('excede o que falta pagar'); e.statusCode = 409; throw e;
      }
      const seq = log.length + 1;
      log.push({ seq, type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents, tipCents: 0, method: 'house_account' } });
      return seq;
    },
    async refundHousePrincipal({ accountId, amountCents, nowIso }) {
      const log = houseEvents.get(accountId);
      if (!log) { const e = new Error('Conta não encontrada'); e.statusCode = 404; throw e; }
      const state = houseState.reduce(log);
      if (!state || amountCents > state.principalCents) {
        const e = new Error('saldo insuficiente'); e.statusCode = 409; throw e;
      }
      const seq = _houseAppend(accountId, 'PRINCIPAL_REFUNDED', {
        amountCents, at: nowIso, settlement: 'manual',
      });
      return { seq, principalCents: state.principalCents - amountCents };
    },
    async recordHousePaymentRow({ checkId, venueId, txid, amountCents, confirmedAt }) {
      if (payments.has(txid)) return; // idempotent — an existing row stands (supabase parity)
      payments.set(txid, {
        txid, checkId, venueId, amountCents, tipCents: 0,
        payerLabel: null, method: 'house_account',
        status: 'confirmado', confirmedAt, createdAt: new Date().toISOString(),
      });
    },
    async listHouseAccountsForReconcile(venueId) {
      return [...houseAccounts.values()]
        .filter((a) => a.venueId === venueId)
        .map((a) => ({
          accountId: a.id,
          events: [...(houseEvents.get(a.id) || [])],
          stored: null, // memory derives balances; nothing independent to cross-check
        }));
    },
  };
}

module.exports = { createMemoryStore };
