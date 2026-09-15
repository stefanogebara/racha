'use strict';

// A janela é a MESMA da conta da mesa — validade do Pix, 15 minutos — e vem de
// lá, não de um número repetido aqui: duas janelas que deviam ser uma já
// divergiram neste repositório por um acento e por um `\b`.
const { JANELA_VIVA_MS } = require('../pay/create-charge');
const TETO_CARGAS = 10;

/**
 * Há vaga pra mais uma carga de saldo nesta conta?
 *
 * TEM NOME PRÓPRIO, como o `assertChargeSlot`, por dois motivos: a prosa dos
 * dois stores já apontava pra um `assertLoadSlot` que não existia — o defeito
 * que este repositório passou rodadas removendo, cometido no commit que o
 * removia —, e um censo estrutural que procura um SÍMBOLO é mais honesto que
 * um que procura a chamada de contagem.
 *
 * Dez, e não cinco. O `Wallet.tsx` cunha uma cobrança por toque: os atalhos de
 * R$ 50 / 100 / 200 mais um valor digitado já são quatro, e a quinta tentativa
 * de verdade batia no teto. E aqui o remédio "pague uma das abertas" é pior que
 * na mesa: as abertas são todas da própria pessoa, e são valores que ela já
 * descartou. Achado pela revisão de compliance de 2026-09-15 (MEDIUM-2).
 *
 * ANTES da chamada ao PSP, como o gêmeo: o ponto é não falar com o adquirente.
 */
/**
 * E O TETO POR CASA, porque conta de saldo é DE GRAÇA.
 *
 * Um teto por conta num endpoint em que contas são geradas, não obtidas, é um
 * teto sobre nada: o `openAccount` aceita qualquer sequência de 10 a 13
 * dígitos como telefone, sem verificação, e o limite é um balde local de dez
 * por IP e as cinco mil contas por casa. 5000 × 10 = cinquenta mil BR Codes de
 * recarga vivos por casa, cada um até o teto de carga, e cada conta ainda
 * grava um nome e um telefone — é também uma questão de minimização da LGPD,
 * não só de carga. O teto por casa limita o agregado independentemente de
 * quantas contas existam. Achado pela revisão de segurança de 2026-09-15
 * (MEDIUM-3).
 *
 * Duzentos: uma casa movimentada numa noite de promoção vê algumas dezenas de
 * recargas em quinze minutos. O preço, dito: um atacante com vinte contas
 * esgota as recargas da casa por quinze minutos. Recarga não é pagar a conta,
 * e é a troca certa contra cinquenta mil cobranças vivas.
 */
const TETO_CARGAS_POR_CASA = 200;

/** Ver `emVoo` no `create-charge.js`: a mesma reserva, pela mesma razão. */
const cargasEmVoo = new Map();

async function assertLoadSlot(store, account) {
  const [daConta, daCasa] = await Promise.all([
    store.countPendingHouseLoads({ accountId: account.id, windowMs: JANELA_VIVA_MS }),
    store.countPendingHouseLoads({ venueId: account.venueId, windowMs: JANELA_VIVA_MS }),
  ]);
  // Síncrono daqui até a reserva — ver o gêmeo.
  const vooConta = cargasEmVoo.get(`a:${account.id}`) || 0;
  const vooCasa = cargasEmVoo.get(`v:${account.venueId}`) || 0;
  const cheia = daConta + vooConta >= TETO_CARGAS
    ? { limite: TETO_CARGAS, onde: `conta=${account.id}`, n: daConta + vooConta }
    : daCasa + vooCasa >= TETO_CARGAS_POR_CASA
      ? { limite: TETO_CARGAS_POR_CASA, onde: `casa=${account.venueId}`, n: daCasa + vooCasa }
      : null;
  if (cheia) {
    // Ver o gêmeo: guarda que ninguém vê é guarda caracterizado em produção.
    process.stderr.write(`[teto] cargas vivas ${cheia.onde} ocupadas=${cheia.n} teto=${cheia.limite}\n`);
    const err = new Error(`too many live pending loads (${cheia.n})`);
    err.statusCode = 429;
    err.code = 'too_many_pending_loads';
    err.vars = { limit: cheia.limite, windowMinutes: JANELA_VIVA_MS / 60000 };
    throw err;
  }
  const chaves = [`a:${account.id}`, `v:${account.venueId}`];
  for (const k of chaves) cargasEmVoo.set(k, (cargasEmVoo.get(k) || 0) + 1);
  let liberada = false;
  return function liberar() {
    if (liberada) return;
    liberada = true;
    for (const k of chaves) {
      const n = (cargasEmVoo.get(k) || 1) - 1;
      if (n <= 0) cargasEmVoo.delete(k); else cargasEmVoo.set(k, n);
    }
  };
}

/**
 * House Accounts — saldo da casa. Orchestrates the account ledger, the check
 * ledger, and the PSP. Store + psp injected → runs against both stores.
 *
 * Compliance rules enforced HERE (docs/house-accounts/README.md):
 * - the venue is the ISSUER: load charges settle to the venue's
 *   psp_recipient_id (no platform custody — same gate as check charges);
 * - single venue: an account only redeems at the venue that issued it;
 * - bonus is quoted (bp + validity) AT CHARGE TIME and stored on the load
 *   row — a config change between charge and webhook never changes what the
 *   customer was promised;
 * - redeems carry NO tip (Lei 13.419: tips are remuneration, never credit);
 * - principal is refundable and never expires; only bonus lots expire.
 */

const crypto = require('crypto');
const { remainingCents } = require('../checks/check-state');
const houseState = require('./account-state');
const { marketGate, chargingAllowed } = require('../markets');

function httpError(status, msg, code, vars) {
  const err = new Error(msg);
  err.statusCode = status;
  if (code) err.code = code;
  // Os `vars` do limite (mínimo/máximo em centavos) viajam com o erro: quem
  // formata "5.000,00 €" é o cliente, que sabe a moeda e o idioma. Estavam
  // caindo aqui porque este `badRequest` local não tinha o parâmetro — inerte
  // hoje (o Brasil não tem teto de recarga), vivo no dia em que um mercado com
  // teto ganhar um trilho de recarga. Achado pela revisão de compliance.
  if (vars) err.vars = vars;
  return err;
}
const badRequest = (msg, code, vars) => httpError(400, msg, code, vars);

// --- phone helpers (LGPD: the full number is stored, never displayed) -------
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  return digits;
}
function maskPhone(digits) {
  if (typeof digits !== 'string' || digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

// --- config -----------------------------------------------------------------
const CONFIG_FIELDS = ['enabled', 'bonusBp', 'validityDays', 'minLoadCents', 'maxLoadCents'];

/** Validate a config patch. validityDays ≥ 30 is the CDC-derived legal floor. */
function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object') throw badRequest('config inválida');
  const out = {};
  for (const k of Object.keys(patch)) {
    if (!CONFIG_FIELDS.includes(k)) throw badRequest(`campo desconhecido: ${k}`);
  }
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw badRequest('enabled deve ser booleano');
    out.enabled = patch.enabled;
  }
  if ('bonusBp' in patch) {
    if (!Number.isInteger(patch.bonusBp) || patch.bonusBp < 0 || patch.bonusBp > 5000) {
      throw badRequest('bônus fora do intervalo (0–50%)');
    }
    out.bonusBp = patch.bonusBp;
  }
  if ('validityDays' in patch) {
    if (!Number.isInteger(patch.validityDays) || patch.validityDays < 30 || patch.validityDays > 365) {
      throw badRequest('validade do bônus deve ficar entre 30 e 365 dias (mínimo legal: 30)');
    }
    out.validityDays = patch.validityDays;
  }
  if ('minLoadCents' in patch) {
    if (!Number.isSafeInteger(patch.minLoadCents) || patch.minLoadCents < 100) {
      throw badRequest('recarga mínima deve ser pelo menos R$ 1,00');
    }
    out.minLoadCents = patch.minLoadCents;
  }
  if ('maxLoadCents' in patch) {
    if (!Number.isSafeInteger(patch.maxLoadCents) || patch.maxLoadCents < 100) {
      throw badRequest('recarga máxima inválida');
    }
    out.maxLoadCents = patch.maxLoadCents;
  }
  return out;
}

function venueHouseConfig(venue) {
  return {
    enabled: venue.houseEnabled === true,
    bonusBp: venue.houseBonusBp ?? 1000,
    validityDays: venue.houseValidityDays ?? 90,
    minLoadCents: venue.houseMinLoadCents ?? 2000,
    maxLoadCents: venue.houseMaxLoadCents ?? 50000,
  };
}

function quoteBonusCents(amountCents, bonusBp) {
  return Math.floor((amountCents * bonusBp) / 10000);
}

// --- ledger → human view ----------------------------------------------------
function ledgerView(events) {
  const rows = [];
  for (const evt of events) {
    const p = evt.payload || {};
    if (evt.type === 'LOAD_CONFIRMED') {
      rows.push({ at: p.at ?? null, type: 'load', label: 'Recarga', amountCents: p.principalCents, bonusCents: p.bonusCents ?? 0 });
    } else if (evt.type === 'REDEEMED') {
      rows.push({ at: p.at ?? null, type: 'redeem', label: 'Pagamento na mesa', amountCents: -((p.principalCents ?? 0) + (p.bonusCents ?? 0)), bonusCents: 0 });
    } else if (evt.type === 'PRINCIPAL_REFUNDED') {
      rows.push({ at: p.at ?? null, type: 'refund', label: 'Reembolso', amountCents: -p.amountCents, bonusCents: 0 });
    }
  }
  return rows.reverse(); // most recent first
}

function createHouseService({ store, psp, now = () => new Date().toISOString() }) {
  if (!store || !psp) throw new Error('createHouseService: missing dependencies');

  /** Public per-table config — what the diner sees before opening a wallet. */
  async function publicConfig(tableQrToken) {
    const hit = await store.getVenueByTableToken(tableQrToken || '');
    if (!hit) throw httpError(404, 'Mesa não encontrada');
    const cfg = venueHouseConfig(hit.venue);
    return {
      enabled: cfg.enabled,
      venueName: hit.venue.name,
      bonusBp: cfg.bonusBp,
      validityDays: cfg.validityDays,
      minLoadCents: cfg.minLoadCents,
      maxLoadCents: cfg.maxLoadCents,
    };
  }

  async function openAccount({ tableQrToken, phone, name }) {
    const hit = await store.getVenueByTableToken(tableQrToken || '');
    if (!hit) throw httpError(404, 'Mesa não encontrada');
    const cfg = venueHouseConfig(hit.venue);
    if (!cfg.enabled) throw badRequest('house balance is off for this venue', 'house_off');
    const digits = normalizePhone(phone);
    if (!digits) throw badRequest('Telefone inválido');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
      throw badRequest('Nome é obrigatório (até 60 caracteres)');
    }
    // Abuse bound: a public endpoint must not allow unbounded row creation
    // (each account also costs the owner panel a ledger read).
    const MAX_ACCOUNTS_PER_VENUE = 5000;
    if (store.countHouseAccounts
        && (await store.countHouseAccounts(hit.venue.id)) >= MAX_ACCOUNTS_PER_VENUE) {
      throw httpError(503, 'Limite de contas deste restaurante atingido — fale com o balcão');
    }
    let account;
    try {
      account = await store.createHouseAccount({
        venueId: hit.venue.id, phone: digits, name: name.trim(),
      });
    } catch (e) {
      if (/duplicate/i.test(e.message)) {
        // NEVER return the existing token — knowing a phone number must not
        // grant access to its balance. Recovery goes through the owner panel.
        throw httpError(409, 'Conta já existe — peça seu link no balcão');
      }
      throw e;
    }
    return { accountToken: account.accountToken, venueName: hit.venue.name };
  }

  async function wallet(accountToken) {
    const account = await store.getHouseAccountByToken(accountToken || '');
    if (!account) throw httpError(404, 'Conta não encontrada');
    const venue = await store.getVenue(account.venueId);
    const events = await store.loadHouseEvents(account.id);
    const state = houseState.reduce(events);
    const nowIso = now();
    const avail = houseState.availableCents(state, nowIso);
    const lots = state
      ? state.lots
          .filter((l) => l.remainingCents > 0 && Date.parse(l.expiresAt) > Date.parse(nowIso))
          .map((l) => ({ remainingCents: l.remainingCents, expiresAt: l.expiresAt }))
      : [];
    const cfg = venue ? venueHouseConfig(venue) : { bonusBp: 0, validityDays: 90 };
    return {
      venue: { name: venue ? venue.name : '?' },
      // The load screen must disclose the bonus validity BEFORE money moves
      // (CDC art. 31 — review finding): the frontend renders these.
      config: { bonusBp: cfg.bonusBp, validityDays: cfg.validityDays },
      account: {
        name: account.name,
        phoneMasked: maskPhone(account.phone),
        principalCents: avail.principalCents,
        bonusCents: avail.bonusCents,
        totalCents: avail.totalCents,
        lots,
        ledger: ledgerView(events),
      },
    };
  }

  async function createLoad({ accountToken, amountCents }) {
    const account = await store.getHouseAccountByToken(accountToken || '');
    if (!account) throw httpError(404, 'Conta não encontrada');
    const venue = await store.getVenue(account.venueId);
    if (!venue) throw httpError(404, 'venue not found', 'venue_not_found');
    const cfg = venueHouseConfig(venue);
    if (!cfg.enabled) throw badRequest('house balance is off for this venue', 'house_off');
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequest('Valor inválido');
    // CÓDIGO + CENTAVOS CRUS, não a frase pronta. Estas duas formatavam
    // dinheiro no servidor (`toFixed(2)`, sem moeda e sem idioma) e mandavam
    // português pra quem quer que estivesse lendo. É a regra do CLAUDE.md, e o
    // `httpError` daqui já tinha o parâmetro `vars` esperando por isto.
    if (amountCents < cfg.minLoadCents) throw badRequest('load below minimum', 'load_below_min', { minCents: cfg.minLoadCents });
    if (amountCents > cfg.maxLoadCents) throw badRequest('load above maximum', 'load_above_max', { maxCents: cfg.maxLoadCents });
    if (!venue.pspRecipientId) {
      // Same custody gate as check charges: without a venue recipient the
      // funds would land on the platform account (BACEN Res. 494 territory).
      throw badRequest('venue has no settlement recipient configured', 'venue_no_recipient');
    }
    // O PORTÃO DE MERCADO, no caminho do dinheiro.
    //
    // Achado por um teste estrutural, não pela revisão: esta função criava uma
    // cobrança PIX sem conferir mercado nenhum. `/api/house/open` era gated e
    // `/api/house/load` não, então uma carteira aberta antes de virar o
    // `market` — ou aberta em qualquer ordem — recarregava com Pix numa casa
    // que cobra em euro. O Pagar.me emitiria uma cobrança em REAL pra uma
    // venue espanhola.
    //
    // A recarga é sempre Pix hoje, e a Espanha não serve Pix, então este
    // portão hoje FECHA a carteira em Espanha — que é a resposta certa: a
    // carteira coleta nome e telefone, o dado mais pessoal do produto, e é
    // exatamente o que a pendência de residência de dado do GDPR trava.
    // Quando a Espanha ganhar um trilho de recarga, muda o `rail` aqui.
    const gate = marketGate(venue.market, { rail: 'pix', amountCents, tipCents: 0 });
    if (gate) throw badRequest(`mercado ${venue.market}: ${gate.code}`, gate.code, gate.vars);

    const liberarCarga = await assertLoadSlot(store, account);
    try {
    const bonusCents = quoteBonusCents(amountCents, cfg.bonusBp);
    const charge = await psp.createPixCharge({
      // Random nonce: two identical loads are DIFFERENT charges (the mock PSP
      // derives txid from chargeRef; a deterministic ref would collide).
      chargeRef: `hload:${account.id}:${crypto.randomUUID()}`,
      amountCents,
      tipCents: 0,
      recipientId: venue.pspRecipientId, // venue is the issuer — funds go direct
      description: `Saldo ${venue.name}`.slice(0, 40),
    });
    await store.registerHouseLoad({
      accountId: account.id,
      txid: charge.txid,
      amountCents,
      bonusCents,                       // quoted NOW; webhook applies this, not live config
      validityDays: cfg.validityDays,   // snapshot too
    });
    return {
      txid: charge.txid, copiaECola: charge.copiaECola, expiresAt: charge.expiresAt,
      amountCents, bonusCents,
    };
    } finally {
      liberarCarga();
    }
  }

  /**
   * Webhook fallback: a confirmed txid that isn't a check charge may be a
   * house load. Returns null when the txid is no load of ours (caller keeps
   * its rejected path); returns a webhook-result object otherwise.
   */
  async function confirmLoadFromWebhook(parsed) {
    const load = await store.findHouseLoadByTxid(parsed.txid);
    if (!load) return null;
    if (parsed.kind === 'refund') {
      // Pix devolução of a load is a manual-ops path in v1 (the balance may
      // already be partially spent). Reject loudly; never auto-debit.
      return { status: 'rejected', reason: `load ${parsed.txid}: devolução requer tratamento manual` };
    }
    if (parsed.amountCents !== load.amountCents || parsed.tipCents !== 0) {
      return { status: 'rejected', reason: `load ${parsed.txid}: valores divergem da cobrança` };
    }
    const r = await store.confirmHouseLoad({ txid: parsed.txid, confirmedAt: now() });
    return {
      status: r.duplicate ? 'duplicate' : 'load_applied',
      accountId: r.accountId,
      seq: r.seq,
    };
  }

  async function redeem({ accountToken, tableQrToken, amountCents, idempotencyKey = null }) {
    const account = await store.getHouseAccountByToken(accountToken || '');
    if (!account) throw httpError(404, 'Conta não encontrada');
    const view = await store.getCheckByQrToken(tableQrToken || '');
    if (!view) throw httpError(404, 'Mesa sem conta aberta');
    const venue = await store.getVenueForCheck(view.check.id);
    if (!venue) throw httpError(404, 'venue not found', 'venue_not_found');
    const cfg = venueHouseConfig(venue);
    if (!cfg.enabled) throw badRequest('house balance is off for this venue', 'house_off');
    if (account.venueId !== venue.id) {
      // Single-venue rule (âmbito limitado): credit NEVER crosses venues.
      throw httpError(409, 'house balance belongs to another venue', 'house_wrong_venue');
    }
    // GASTAR também é um portão de mercado, não só CARREGAR.
    //
    // O `createLoad` ganhou o portão e o `redeem` não, e o comentário lá dizia
    // que a carteira estava fechada em Espanha. Fechava o carregamento, não o
    // gasto. Achado pela revisão de segurança, e a mesma coisa pela de
    // compliance por outro caminho.
    //
    // O caminho concreto: venue 'br', cliente abre carteira e carrega R$200 —
    // as duas coisas permitidas. Alguém vira `venues.market` pra 'es' no banco
    // (o caminho provável de um piloto às pressas, escrito no `markets.js`).
    // Todas as outras portas passam a recusar; esta ainda aceita, e 20000
    // centavos de crédito em REAL quitam 200,00 € de conta, 1:1. Pior: o razão
    // grava 20000 dos dois lados, então a conciliação compara 20000 com 20000
    // e reporta 0,00 de divergência — o inegociável #8 derrotado em silêncio,
    // que é a mesma falha que a correção de moeda existiu pra impedir.
    //
    // Aqui não há trilho (não se cobra nada de ninguém: é saldo já pago sendo
    // consumido), então o portão é o interruptor direto, como em
    // `/api/house/open`. O `marketGate` pediria um `rail` inventado.
    const live = chargingAllowed(venue.market);
    if (live) throw badRequest(`mercado ${venue.market}: ${live.code}`, live.code);

    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequest('Valor inválido');
    const remaining = remainingCents(view.state);
    if (amountCents > remaining) {
      throw badRequest(`Valor excede o que falta pagar (${remaining} centavos)`);
    }

    // Retry-safe txid: the same client attempt (idempotencyKey) always maps
    // to the same txid, so a lost-response retry dedups instead of debiting
    // twice (review finding). No key → per-call random.
    const txid = idempotencyKey && typeof idempotencyKey === 'string' && idempotencyKey.length >= 8
      ? `ha_${crypto.createHash('sha256').update(`${account.id}:${idempotencyKey}`).digest('hex').slice(0, 24)}`
      : `ha_${crypto.randomBytes(12).toString('hex')}`;
    const nowIso = now();

    // 1. Debit the account (atomic in the store: memory is synchronous;
    //    supabase validates + consumes lots inside the locked house_redeem
    //    RPC). Insufficient balance → 409 before anything touches the check.
    const debit = await store.redeemHouse({
      accountId: account.id, checkId: view.check.id, txid, amountCents, nowIso,
    });

    // 2. Confirm the payment on the check ledger — GUARDED: validated inside
    //    the per-check lock so two concurrent redeems can never overpay the
    //    check with credit (review finding). Idempotent by txid, so on a
    //    duplicate debit the replayed append is a no-op returning the seq.
    //    (Tips NEVER ride a credit redemption.)
    try {
      await store.appendHousePaymentGuarded(view.check.id, txid, amountCents);
    } catch (e) {
      if (e.statusCode === 409 && !debit.duplicate) {
        // The check refused the payment (raced full / closed). Compensate:
        // put the exact breakdown back and tell the diner nothing was spent.
        await store.reverseHouseRedeem({ accountId: account.id, txid, nowIso: now() });
        throw httpError(409, 'Outra pessoa pagou essa parte agora há pouco — seu saldo não foi debitado');
      }
      throw e; // unknown failure: debit stands, reconciliation flags the pair
    }

    // 3. Payments row → panel totals + reconciliation see it like any
    //    payment. Idempotent by txid, and ALWAYS attempted: a retried call
    //    (same idempotencyKey) that crashed mid-way last time heals the
    //    missing row here instead of leaving it to reconciliation.
    await store.recordHousePaymentRow({
      checkId: view.check.id, venueId: venue.id, txid, amountCents, confirmedAt: nowIso,
    });

    const fresh = await store.getCheckByQrToken(tableQrToken);
    return {
      txid,
      checkId: view.check.id, // for the POS write-back
      principalUsedCents: debit.principalUsedCents,
      bonusUsedCents: debit.bonusUsedCents,
      check: fresh, // null when this payment closed out the visible check
    };
  }

  // --- owner surface --------------------------------------------------------
  async function adminView(venueId) {
    const venue = await store.getVenue(venueId);
    if (!venue) throw httpError(404, 'venue not found', 'venue_not_found');
    const rows = await store.listHouseAccounts(venueId);
    const nowIso = now();
    let principalCents = 0;
    let bonusCents = 0;
    const accounts = [];
    for (const acc of rows) {
      const state = houseState.reduce(await store.loadHouseEvents(acc.id));
      const avail = houseState.availableCents(state, nowIso);
      principalCents += avail.principalCents;
      bonusCents += avail.bonusCents;
      accounts.push({
        id: acc.id,
        name: acc.name,
        phoneMasked: maskPhone(acc.phone),
        principalCents: avail.principalCents,
        bonusCents: avail.bonusCents,
        createdAt: acc.createdAt,
      });
    }
    return {
      config: venueHouseConfig(venue),
      liability: { principalCents, bonusCents, accountCount: accounts.length },
      accounts,
    };
  }

  async function updateConfig(venueId, patch) {
    const clean = validateConfigPatch(patch);
    if (Object.keys(clean).length === 0) throw badRequest('nada para atualizar');
    if ('minLoadCents' in clean || 'maxLoadCents' in clean) {
      const venue = await store.getVenue(venueId);
      if (!venue) throw httpError(404, 'venue not found', 'venue_not_found');
      const cfg = venueHouseConfig(venue);
      const min = clean.minLoadCents ?? cfg.minLoadCents;
      const max = clean.maxLoadCents ?? cfg.maxLoadCents;
      if (min > max) throw badRequest('recarga mínima maior que a máxima');
    }
    const venue = await store.setHouseConfig(venueId, clean);
    return { config: venueHouseConfig(venue) };
  }

  async function rotateToken(accountId) {
    const r = await store.rotateHouseAccountToken(accountId);
    if (!r) throw httpError(404, 'Conta não encontrada');
    return { accountToken: r.accountToken };
  }

  async function refundPrincipal({ accountId, amountCents }) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequest('Valor inválido');
    const r = await store.refundHousePrincipal({ accountId, amountCents, nowIso: now() });
    // Surface the still-active bonus so the owner sees what a refunded
    // account can still spend (decision: bonus is NOT auto-revoked on
    // refund — recorded in docs/house-accounts/README.md; the UI warns).
    const state = houseState.reduce(await store.loadHouseEvents(accountId));
    const avail = houseState.availableCents(state, now());
    return { principalCents: r.principalCents, bonusCents: avail.bonusCents };
  }

  /** venueId for an account token — the router's ownership guard for admin ops. */
  async function venueIdForAccount(accountId) {
    const acc = await store.getHouseAccountById(accountId);
    return acc ? acc.venueId : null;
  }

  return {
    publicConfig, openAccount, wallet, createLoad, confirmLoadFromWebhook,
    redeem, adminView, updateConfig, rotateToken, refundPrincipal,
    venueIdForAccount,
    // exported for tests
    quoteBonusCents, normalizePhone, maskPhone, validateConfigPatch, venueHouseConfig,
  };
}

module.exports = { createHouseService, normalizePhone, maskPhone, quoteBonusCents };
