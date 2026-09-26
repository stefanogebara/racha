'use strict';

const { nomeDaRestricao, mensagemDeUnicidade } = require('./pg-erro');

/**
 * Métodos que confirmam INLINE, sem webhook de gateway — e por isso ficam fora
 * da reconciliação ativa. Todo o resto entra, inclusive trilhos que ainda não
 * existem: é o default certo, porque o erro custa dinheiro só num dos lados.
 */
const INLINE_METHODS = new Set(['house_account']);

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
 * In-memory store — powers the local demo and integration tests.
 *
 * Implements the same interface as the Supabase store (store/supabase.js,
 * v1): venues/tables/checks/events/payments. Seq assignment mirrors the
 * append_check_event RPC semantics (serialized per check — trivially true
 * single-threaded here). NOT for production use.
 */

const crypto = require('crypto');
const { reduce, paidAfterClose, itensDoRazao } = require('../checks/check-state');
const { idadeSemOpened, linhaDeAlarme } = require('../checks/conta-sem-opened');

/**
 * A conta OCUPA a mesa? — a regra do índice `checks_one_open_per_table` do
 * Postgres, que é sobre a COLUNA `status <> 'fechada'`, não sobre o razão. Uma
 * conta sem `OPENED` (a órfã) ocupa: lá ela tranca a mesa com 409. Este store
 * deixava abrir outra por cima — o teste de "mesa trancada" passava verde aqui
 * e era falso em produção (segurança, quarta rodada, M-2).
 */
function ocupaAMesa(evs) {
  const st = reduce(evs || []);
  return !st || st.status !== 'fechada';
}
const { linhasDeSobra, acumularSobra } = require('../checks/sobra-do-painel');
const { buildAtivacao, spDay } = require('../checks/ativacao');
const houseState = require('../house/account-state');
const { PAPEL_DE_DONO } = require('./papeis');
const { rotuloDoPagador } = require('../texto-da-casa');
const { isTerminalRecipientStatus } = require('../recipient-status');

/**
 * A CHAVE do índice único parcial da 0034 — a mesma normalização do SQL
 * (`lower(btrim(...))`): "PIX E2E123" e "pix e2e123 " são o mesmo comprovante.
 */
function chaveDaDevolucaoForaDoTrilho(type, payload) {
  if (type !== 'PAYMENT_REFUNDED' || !payload || payload.offRail !== true) return null;
  // `btrim` do Postgres tira SÓ o espaço ASCII — e o dublê usava `trim()` do
  // JS, que tira tabulação, quebra de linha e NBSP também. Dublê mais restritivo
  // que o banco esconde o furo em vez de mostrá-lo (segurança LOW-1 de
  // d7f2683). Aqui ele imita o `btrim`; quem tira o resto é a rota, na entrada.
  const ref = String(payload.reference == null ? '' : payload.reference)
    .replace(/^ +| +$/g, '').toLowerCase();
  return `${payload.txid}\u0000${ref}`;
}

function createMemoryStore() {
  const venues = new Map();
  const tables = new Map();   // qrToken → { id, venueId, label, qrToken }
  const checks = new Map();   // checkId → { id, venueId, tableId, items: [] }
  const events = new Map();   // checkId → [{seq, type, payload}]
  const payments = new Map();   // txid → payment row
  const orphanEvents = [];      // eventos de dinheiro sem conta (migração 0024)
  const checkViews = new Map();  // `${checkId}:${sessionHash}` → abertura (0028)
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
  const vagas = [];               // teto de cobranças vivas — ver `claimSlots`
  const houseLoads = new Map();    // txid → { txid, accountId, amountCents, bonusCents, validityDays, status }
  // O registro de execução da retenção (migração 0032). Aqui é lista; no
  // Postgres é tabela com prazo próprio de 5 anos.
  const retentionRuns = [];

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
        // Com CÓDIGO, igual ao de produção: é o código que a rota lê, e um
        // dublê que só tem a frase faz o teste da rota passar sobre um contrato
        // que o store de verdade não cumpre.
        throw Object.assign(new Error('duplicate table label'), { code: 'table_label_duplicate' });
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
    seedVenue({ name, cnpj, servicoBp = 1000, pspRecipientId = 'rcpt_demo', isTest = false, market = DEFAULT_MARKET }) {
      // `cnpj` estava faltando aqui, então a semente passava o documento e ele
      // se perdia entre a chamada e a venue — a `_mkVenue` sempre aceitou.
      // Uma lista de campos escrita à mão, de novo: o mesmo jeito que o
      // localStorage esqueceu o espanhol.
      //
      // E o PADRÃO deixou de ser `null`. Uma casa semeada é uma casa
      // CONFIGURADA — é o que a semente existe pra representar — e desde que o
      // serviço só corre onde há documento de empresa provado
      // (`create-charge.js`, portão `venue_no_tip_document`), semear sem
      // documento é semear uma casa que não pode cobrar serviço. Oito suítes
      // ficaram vermelhas quando o portão entrou, e estavam certas: elas
      // cobravam 10% de casas sem CNPJ, que é exatamente o estado que o
      // portão passou a recusar. Quem quiser esse estado pede por ele,
      // passando `cnpj: null` — e há teste que faz isso.
      const padrao = market === 'es' ? 'B12345678' : '11444777000161';
      return _mkVenue({ name, cnpj: cnpj === undefined ? padrao : cnpj, servicoBp, pspRecipientId, isTest, market });
    },
    async getVenue(venueId) {
      return venues.get(venueId) || null;
    },

    // --- ownership / membership ---------------------------------------------
    async addVenueMember(venueId, userId, role = PAPEL_DE_DONO) {
      if (!venues.has(venueId)) throw new Error('unknown venue');
      if (!userId) throw new Error('userId required');
      if (members.some((m) => m.venueId === venueId && m.userId === userId)) {
        return { venueId, userId, role }; // idempotent
      }
      members.push({ venueId, userId, role });
      return { venueId, userId, role };
    },
    // Ver o comentário longo em `store/supabase.js`: o papel É conferido, nos
    // dois stores, e o contrato entre eles é o que impede a divergência.
    async userOwnsVenue(userId, venueId) {
      return members.some((m) => m.userId === userId && m.venueId === venueId && m.role === PAPEL_DE_DONO);
    },
    async listVenuesForOwner(userId) {
      return members
        .filter((m) => m.userId === userId && m.role === PAPEL_DE_DONO)
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
    /** Paridade com a `adjust_check` (0038): confere, grava evento e itens juntos. */
    async adjustCheck(checkId, expectedSeq, totalCents, items) {
      const c = checks.get(checkId);
      if (!c) throw Object.assign(new Error('memory store adjustCheck: conta desconhecida'), { pgCode: '22023' });
      if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
        throw Object.assign(new Error('memory store adjustCheck: total inválido'), { pgCode: '22023' });
      }
      // As MESMAS regras da 0038: objeto, `name` texto, `priceCents` inteiro >= 0,
      // no máximo 200 itens, conta não fechada.
      if (!Array.isArray(items) || items.length === 0 || items.length > 200
          || items.some((i) => !i || typeof i !== 'object' || Array.isArray(i) || typeof i.name !== 'string'
            || !Number.isSafeInteger(i.priceCents) || i.priceCents < 0)) {
        throw Object.assign(new Error('memory store adjustCheck: itens inválidos'), { pgCode: '22023' });
      }
      if ((events.get(checkId) || []).some((e) => e.type === 'CLOSED')) {
        throw Object.assign(new Error('memory store adjustCheck: conta fechada'), { pgCode: '22023' });
      }
      const soma = items.reduce((s, i) => s + i.priceCents, 0);
      if (soma !== totalCents) {
        throw Object.assign(new Error(`memory store adjustCheck: os itens somam ${soma} e o total é ${totalCents}`), { pgCode: '22023' });
      }
      // Os itens SÓ depois de o evento ter entrado de verdade — um append que
      // recusa (40001, ou um dublê que recusa) não deixa item nenhum. A
      // continuação logo após o `await` roda antes de qualquer outro ajuste
      // completar o seu append E os seus itens, então no dublê de uma thread só
      // o par fica junto, como a trava do banco garante na produção.
      // Cópia, não a referência do chamador (imutabilidade; compliance L-3).
      const copia = items.map((i) => ({ ...i }));
      const seq = await this.appendEventIfUnchanged(checkId, 'ADJUSTED', { totalCents, items: copia }, null, expectedSeq);
      checks.set(checkId, { ...checks.get(checkId), items: copia.map((i) => ({ ...i })) });
      return seq;
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
            (c) => c.tableId === t.id && ocupaAMesa(events.get(c.id)),
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
    /** Mesa de treino: não cobra (`mesa-de-treino.js`); o painel não a esconde. */
    async setTableTraining(tableId, training) {
      const t = tableById.get(tableId);
      if (!t) throw new Error('unknown table');
      // Marcar com conta aberta: recusado, como no store do Supabase.
      if (training && [...checks.values()].some((c) => c.tableId === t.id && ocupaAMesa(events.get(c.id)))) {
        const e = new Error('table has an open check — close it before marking it as training');
        e.statusCode = 409; e.code = 'table_has_open_check'; throw e;
      }
      t.training = !!training;
      return { id: t.id, training: t.training };
    },
    async setTableActive(tableId, active) {
      const t = tableById.get(tableId);
      if (!t) throw new Error('unknown table');
      if (!active) {
        const open = [...checks.values()].some(
          (c) => c.tableId === t.id && ocupaAMesa(events.get(c.id)),
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
      const alreadyOpen = [...checks.values()].some(
        (c) => c.tableId === table.id && ocupaAMesa(events.get(c.id)),
      );
      if (alreadyOpen) { const e = new Error('mesa já tem uma conta aberta'); e.statusCode = 409; e.code = 'check_already_open'; throw e; }
      const id = crypto.randomUUID();
      const totalCents = items.reduce((s, i) => s + i.priceCents, 0);
      // `openedAt` porque o do Supabase tem `opened_at` e este não tinha
      // NENHUM horário — mais uma divergência de forma da mesma família que o
      // `store-shape.test.js` existe pra fechar. Sem ele, qualquer janela de
      // tempo sobre contas (o funil de adoção, por exemplo) media zero no
      // dublê e o número certo em produção.
      checks.set(id, {
        id, venueId: table.venueId, tableId: table.id, items,
        openedAt: new Date().toISOString(),
      });
      events.set(id, []);
      // A MESMA TRANSAÇÃO do `open_check` do Postgres (migração 0037): se o
      // `OPENED` não entra, a linha sai. Sem isto o dublê seguia fabricando a
      // conta órfã que produção não fabrica mais.
      try {
        // Os itens vão no `OPENED`, como a `open_check` da 0039.
        await this.appendEvent(id, 'OPENED', { totalCents, items: items.map((i) => ({ ...i })) });
      } catch (e) {
        checks.delete(id);
        events.delete(id);
        throw e;
      }
      return checks.get(id);
    },

    /**
     * SÓ PRA TESTE: uma conta com a linha e SEM `OPENED` — a órfã que o
     * `openCheck` em duas idas deixava antes da 0037. As defesas contra ela
     * (o alarme `[conta-sem-opened]`, o achado `critical`, o painel que não
     * cai) continuam valendo pra linhas antigas, e é assim que se as testa.
     */
    seedContaSemOpened(tableQrToken, { openedAt = new Date().toISOString() } = {}) {
      const table = tables.get(tableQrToken);
      if (!table) throw new Error('unknown table');
      const id = crypto.randomUUID();
      checks.set(id, { id, venueId: table.venueId, tableId: table.id, items: [], openedAt });
      events.set(id, []);
      return { id, openedAt };
    },

    // --- reads ---------------------------------------------------------------
    async getCheckByQrToken(qrToken) {
      const table = tables.get(qrToken);
      if (!table || !table.active) return null; // inactive/rotated token is dead
      const check = [...checks.values()].find((c) => {
        if (c.tableId !== table.id) return false;
        // Sem `OPENED` a conta ainda não está aberta — o mesmo que o store do
        // Supabase faz. Ver o comentário lá: era `TypeError` → 500. E pular
        // não é calar: fora da janela, o alarme.
        const st = reduce(events.get(c.id) || []);
        if (!st) {
          const { idadeMs, orfa } = idadeSemOpened(c.openedAt, Date.now());
          if (orfa) process.stderr.write(linhaDeAlarme(c.id, idadeMs, 'getCheckByQrToken'));
          return false;
        }
        return st.status !== 'fechada';
      });
      if (!check) return null;
      const venue = venues.get(table.venueId);
      const log = events.get(check.id) || [];
      return {
        // O mercado viaja PRONTO: moeda, trilhos, se há linha de serviço e se o
        // pagador precisa dar documento. O cliente desenha, não decide — a UI
        // inferindo uma regra de dinheiro foi o CRÍTICO #1 da revisão #37.
        venue: {
          name: venue.name,
          // O documento da CASA — CNPJ no Brasil, NIF em Espanha. A coluna
          // existe desde a primeira migração, com o comentário "receipts must
          // show it", e a tela de pago nunca mostrou. É identificação de
          // empresa, não dado pessoal: está na porta e em toda nota.
          //
          // Nomeado `taxId` e não `cnpj` porque o campo é o mesmo nos dois
          // mercados e a tela é uma só. Nulo é normal (migração 0002: um CNPJ
          // de mentira num recibo real é pior que a ausência dele).
          // O VALOR também decide, não só o mercado: onze dígitos nesta coluna
            // numa casa brasileira é CPF de alguém, e `/api/check` não tem
            // autenticação. Linhas antigas foram escritas antes do portão do
            // `createVenue` existir. Ver `documentoPublicavelDaCasa`.
            taxId: documentoPublicavelDaCasa(venue.market, venue.cnpj, showsVenueTaxId(venue.market)),
          // `cnpj` vai junto — ver supabase.js.
          ...publicMarketView(venue.market, { servicoBp: venue.servicoBp, cnpj: venue.cnpj }),
        },
        table: { label: table.label, training: table.training === true },
        // Do RAZÃO, como no Supabase (ver `itensDoRazao`); `check.items` só pra
        // conta semeada sem itens no evento.
        check: { id: check.id, items: itensDoRazao(log) || check.items },
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
    /**
     * O TETO DE COBRANÇAS VIVAS, gêmeo em memória do `claim_slots` (0033).
     *
     * Conta e reserva numa passada SÍNCRONA — em JS nada intercala dentro de
     * uma função sem `await`, e é essa a trava da memória. A janela é
     * deslizante: cada vaga carrega o próprio instante. Mesma ordem de
     * decisão do SQL: para na primeira chave cheia e devolve o índice dela.
     */
    async claimSlots({ keys, limits, windowMs } = {}) {
      // AS MESMAS RECUSAS DO SQL. O gêmeo aceitava limite nulo (e o tratava como
      // cheio, ao contrário do SQL, que o tratava como infinito) e janela de um
      // segundo, que o SQL recusa. Revisão de segurança de 2026-09-15 (LOW-1).
      if (!Array.isArray(keys) || !keys.length || !Array.isArray(limits)
        || keys.length !== limits.length
        || !limits.every((n) => Number.isSafeInteger(n) && n > 0)
        || !Number.isFinite(windowMs) || windowMs < 60_000 || windowMs > 86_400_000) {
        throw new Error('claimSlots: argumentos inválidos');
      }
      if (new Set(keys).size !== keys.length) throw new Error('claimSlots: chave repetida');
      const now = Date.now();
      for (let i = vagas.length - 1; i >= 0; i -= 1) {
        const v = vagas[i];
        if (now - v.createdAt > 86_400_000 || (keys.includes(v.key) && now - v.createdAt > windowMs)) {
          vagas.splice(i, 1);
        }
      }
      const counts = [];
      for (let i = 0; i < keys.length; i += 1) {
        const n = vagas.filter((v) => v.key === keys[i] && now - v.createdAt <= windowMs).length;
        counts.push(n);
        if (n >= limits[i]) return { claimId: null, fullIndex: i, counts };
      }
      const claimId = require('node:crypto').randomUUID();
      for (const key of keys) vagas.push({ claimId, key, createdAt: now });
      return { claimId, fullIndex: null, counts };
    },
    /** Devolve as vagas de uma cobrança que o PSP NUNCA criou. Ver 0033. */
    async releaseSlots(claimId) {
      const antes = vagas.length;
      for (let i = vagas.length - 1; i >= 0; i -= 1) if (vagas[i].claimId === claimId) vagas.splice(i, 1);
      return antes - vagas.length;
    },
    /**
     * O gêmeo não tem migração que envelheça: o "esquema" dele é este arquivo.
     * Devolve a impressão esperada, e o cron compara igual nos dois stores.
     */
    async slotsFingerprint() {
      return require('./impressao-0033').IMPRESSAO_0033;
    },
    async listPendingCharges({ checkId = null, graceMs = 0, windowMs = Infinity, limit = 100 } = {}) {
      const now = Date.now();
      return [...payments.values()]
        .filter((p) => {
          if (p.status !== 'pendente') return false;
          // Lista de EXCLUSÃO, não de inclusão. A regra é "métodos que
          // confirmam sozinhos, sem gateway" — hoje só o saldo da casa. Como
          // lista de inclusão isto deixava de fora todo trilho novo: um Bizum
          // pendente ficava fora da reconciliação ativa, e uma cobrança
          // autorizada cujo webhook se perdeu é dinheiro que ninguém vai
          // buscar. O default seguro é reconciliar.
          if (INLINE_METHODS.has(p.method)) return false;
          if (checkId && p.checkId !== checkId) return false;
          const age = now - Date.parse(p.createdAt);
          return age >= graceMs && age <= windowMs;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        // `currency` viaja com a linha porque é a CONCILIAÇÃO que precisa dela:
        // comparar centavos por venue sem saber a moeda é o jeito de atravessar
        // uma troca de moeda reportando 0,00 de divergência.
        .map((p) => ({
          checkId: p.checkId, txid: p.txid, amountCents: p.amountCents,
          tipCents: p.tipCents, method: p.method, currency: p.currency,
          // `createdAt` viaja porque a conciliação precisa julgar ABANDONO: um
          // Bizum parado em `requires_action` é alguém que abriu o app do banco
          // e não voltou, e sem a idade da cobrança isso é indistinguível de
          // alguém que está autorizando neste segundo.
          createdAt: p.createdAt,
        }));
    },

    /** Reconciliation inputs: each check's event log + its payment rows. */
    /** Ver o store do Supabase: cobranças confirmadas recentes, pra terceira
     *  perna da conciliação. */
    /**
     * Quantas cobranças a casa JÁ confirmou — sem janela. Ver o irmão no store
     * do Supabase: o guarda de recebedor pergunta uma propriedade PERMANENTE, e
     * perguntá-la pela janela de 24h fazia o achado se calar no dia seguinte.
     */
    async contarCobrancasConfirmadas(venueId) {
      return [...payments.values()].filter((p) => p.venueId === venueId
        && p.status === 'confirmado' && p.confirmedAt && p.method !== 'house_account').length;
    },

    async listRecentConfirmedCharges(venueId, { sinceIso, limit = 50 } = {}) {
      const corte = sinceIso ? Date.parse(sinceIso) : -Infinity;
      return [...payments.values()]
        .filter((p) => p.status === 'confirmado'
          && (p.venueId ?? (checks.get(p.checkId) || {}).venueId) === venueId
          && p.method !== 'house_account'
          && p.confirmedAt && Date.parse(p.confirmedAt) >= corte)
        .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt))
        .slice(0, limit)
        .map((p) => ({
          txid: p.txid, checkId: p.checkId, method: p.method, confirmedAt: p.confirmedAt,
          paidAmountCents: Number.isFinite(p.confirmedAmountCents)
            ? (p.confirmedAmountCents || 0) + (p.confirmedTipCents || 0)
            : (p.amountCents || 0) + (p.tipCents || 0),
        }));
    },

    async listChecksForReconcile(venueId) {
      return [...checks.values()]
        .filter((c) => c.venueId === venueId)
        .map((c) => ({
          checkId: c.id,
          openedAt: c.openedAt,
          // A coluna do Postgres, derivada da mesma regra do índice: aqui não há
          // SQL à mão, então ela só é `fechada` quando o razão fechou.
          statusDaLinha: ocupaAMesa(events.get(c.id)) ? 'aberta' : 'fechada',
          events: [...(events.get(c.id) || [])],
          payments: [...payments.values()]
            .filter((p) => p.checkId === c.id)
            .map((p) => ({
              txid: p.txid, amountCents: p.amountCents, tipCents: p.tipCents,
              status: p.status, method: p.method || 'pix', currency: p.currency,
              // Os CONFIRMADOS: as colunas que viram faturamento e gorjeta.
              confirmedAmountCents: p.confirmedAmountCents,
              confirmedTipCents: p.confirmedTipCents,
              confirmedAt: p.confirmedAt,   // faz a dívida envelhecer
              // Os acumulados estornados: a conciliação soma LÍQUIDO dos dois
              // lados, senão um estorno parcial vira divergência permanente.
              refundedAmountCents: p.refundedAmountCents || 0,
              refundedTipCents: p.refundedTipCents || 0,
            })),
        }));
    },
    /**
     * Restaurant panel view: every check of the venue with derived state,
     * plus day totals. Tips are reported from CONFIRMED payments only and
     * keyed by confirmed_at (Lei 13.419 payroll competência).
     */
    async getPanelView(venueId, nowIso = new Date().toISOString()) {
      const venue = venues.get(venueId);
      if (!venue) return null;
      /** txid → quanto falta restituir daquele pagamento. Ver o store do
       *  Supabase: o excedente vive no razão, não numa coluna. */
      const sobraPorTxid = new Map();
      /**
       * O MESMO RECORTE DO STORE DE PRODUÇÃO — abertas de qualquer idade, as da
       * janela, e as que receberam dinheiro na janela.
       *
       * Este store devolvia TODA conta da casa. Enquanto o de produção fazia o
       * mesmo, tudo bem; desde o recorte, os dois passaram a desenhar painéis
       * diferentes — e todo teste de painel escrito contra a memória passaria a
       * provar um comportamento que a produção não tem. É a armadilha que este
       * arquivo documenta sobre si mesmo em três lugares ("um dublê que oferece
       * campo que a produção não tem"), aplicada ao recorte em vez de ao campo.
       * Achado pela terceira revisão de compliance de 2026-09-16.
       */
      const desdeAJanela = new Date(Date.parse(nowIso) - 8 * 86400000).toISOString();
      const comDinheiroNaJanela = new Set(
        [...payments.values()]
          .filter((p) => p.status === 'confirmado' && p.confirmedAt && p.confirmedAt >= desdeAJanela)
          .map((p) => p.checkId),
      );
      const noRecorte = (c) => {
        const st = reduce(events.get(c.id) || []);
        // `!st` entra: no Postgres a órfã tem `status='aberta'` na coluna e
        // cai na consulta das abertas. Entra no recorte pra ser PULADA com
        // alarme logo abaixo, como lá — não pra sumir antes de ser vista.
        if (!st || st.status !== 'fechada') return true;         // aberta, qualquer idade
        if (c.openedAt && c.openedAt >= desdeAJanela) return true; // aberta na janela
        return comDinheiroNaJanela.has(c.id);                     // recebeu na janela
      };
      const rows = [...checks.values()]
        .filter((c) => c.venueId === venueId)
        .filter(noRecorte)
        // SEM `OPENED`, fora do painel — e sem derrubá-lo. Ver o do Supabase.
        .filter((c) => {
          if (reduce(events.get(c.id) || [])) return true;
          const { idadeMs, orfa } = idadeSemOpened(c.openedAt, Date.parse(nowIso));
          if (orfa) process.stderr.write(linhaDeAlarme(c.id, idadeMs, 'getPanelView'));
          return false;
        })
        .map((c) => {
          const table = [...tables.values()].find((t) => t.id === c.tableId);
          const state = reduce(events.get(c.id) || []);
          // PELA REGRA ÚNICA: este mapa desconta a dívida do FATURAMENTO da
          // série semanal (ver `ativacao.js`), e lido do excedente congelado ele
          // era cego justamente na sobra que nasce de uma reversão — a série
          // contava como receita a mesma quantia que a linha ao lado chamava de
          // dívida (CC art. 876; segurança HIGH-1 de a95e15c). Eram CINCO
          // leitores do congelado, não quatro: eu contei à mão em vez de varrer.
          acumularSobra(state, sobraPorTxid);
          return {
            checkId: c.id,
            tableLabel: table ? table.label : '?',
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
            // PAGO DEPOIS DE FECHAR, na parte que a sobra não cobre — ver `paidAfterClose`. A equipe
            // confere com a mesa se ela também pagou no caixa. (Compliance HIGH-1.)
            paidAfterClose: paidAfterClose(state),
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
              // PELA REGRA ÚNICA do redutor: o excedente cru é zero na
              // duplicidade que nasce depois, e o painel mostrava "a devolver"
              // sem nenhuma cobrança embaixo — com o runbook mandando devolver
              // "pelo valor ao lado da cobrança" (compliance HIGH-1 de 089e8a2).
              overpaidTxids: linhasDeSobra(state),
            } : {}),
              // Disputas por CONTAGEM: é a taxa de chargeback que o
              // adquirente julga, e o dono não tinha como ver a dele.
              disputes: disputeCounts(state),
            },
          };
        });
      // Venue-scoped like the supabase store — a shared demo instance must
      // never leak one venue's totals into another's panel (review finding).
      // A mesa de treino NÃO sai dos números — ver o store do Supabase e
      // `mesa-de-treino.js`. Ela não cobra; o que o painel encontra é real.
      const confirmed = [...payments.values()].filter((p) =>
        p.status === 'confirmado'
        && (p.venueId ?? (checks.get(p.checkId) || {}).venueId) === venueId);
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
          // à coluna. O painel somava o PEDIDO, então numa divergência o dono
          // lia faturamento e GORJETA errados — e a gorjeta é a base da folha
          // (Lei 13.419). Ver `confirmedMoney` e a migração 0015.
          //
          // MENOS a sobra a devolver: o que o cliente pagou a mais é dívida da
          // casa (CC art. 876), não receita dela. Ver o store do Supabase.
          confirmedCents: doDia.reduce((s, p) => s + confirmedMoney(p).amountCents, 0)
            - overpaidTotal,
          /** A dívida, na sua própria linha. */
          overpaidCents: overpaidTotal,
          tipsCents: doDia.reduce((s, p) => s + confirmedMoney(p).tipCents, 0),
          /** Serviço COBRADO (o que a conta pediu) vs arrecadado (`tipsCents`) —
           *  o contrapeso da regra de imputação. Ver `allocateUnderpayment`. */
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

    // --- writes --------------------------------------------------------------
    /**
     * @param {string} [pspEventId] id do evento do PSP. Único quando presente:
     *   a segunda entrega do MESMO evento é no-op e devolve o `seq` negativo,
     *   igual ao RPC do Supabase (migração 0018).
     *
     *   O mock precisa ser tão restritivo quanto a produção. Um dublê que
     *   aceita o que o banco recusa é uma armadilha, não um dublê — foi assim
     *   que três tipos de evento chegaram a produção recusados por um CHECK
     *   que nenhum teste lia.
     */
    /**
     * COMPARE-AND-APPEND (migração 0034): só grava se o razão daquela conta
     * ainda estiver no `seq` que o chamador viu.
     *
     * O dublê precisa ser tão restritivo quanto o banco — inclusive o ÍNDICE
     * ÚNICO parcial das devoluções fora do trilho, porque um dublê que aceita
     * o que o Postgres recusa é armadilha, não dublê. Os erros saem com
     * `pgCode`, na mesma forma que o `throwOn` do Supabase produz.
     */
    async appendEventIfUnchanged(checkId, type, payload, pspEventId = null, expectedSeq = null) {
      if (!Number.isInteger(expectedSeq) || expectedSeq < 0) {
        throw Object.assign(new Error('memory store appendEventIfUnchanged: expected_seq obrigatório'), { pgCode: '22023' });
      }
      if (!events.has(checkId)) throw new Error('unknown check');
      const log = events.get(checkId);
      const atual = log.length ? log[log.length - 1].seq : 0;
      if (atual !== expectedSeq) {
        throw Object.assign(
          new Error(`memory store appendEventIfUnchanged: o razão mudou (esperado ${expectedSeq}, atual ${atual})`),
          { pgCode: '40001' },
        );
      }
      const chave = chaveDaDevolucaoForaDoTrilho(type, payload);
      if (chave && log.some((e) => chaveDaDevolucaoForaDoTrilho(e.type, e.payload) === chave)) {
        throw Object.assign(
          new Error('memory store appendEventIfUnchanged: devolução fora do trilho já registrada'),
          // Pelo MESMO extrator da produção: o dublê escreve a mensagem que o
          // Postgres escreveria e deixa o parser tirar o nome dela. Receber o
          // nome de bandeja deixava o ramo de falha da extração sem teste
          // nenhum (segurança LOW-3 de 41b188a).
          { pgCode: '23505', pgConstraint: nomeDaRestricao(mensagemDeUnicidade('check_events_offrail_refund_uidx')) },
        );
      }
      return this.appendEvent(checkId, type, payload, pspEventId);
    },
    async appendEvent(checkId, type, payload, pspEventId = null) {
      if (!events.has(checkId)) throw new Error('unknown check');
      if (pspEventId != null) {
        for (const [, log] of events) {
          const visto = log.find((e) => e.pspEventId === pspEventId);
          if (visto) return -visto.seq;
        }
      }
      const log = events.get(checkId);
      const seq = log.length + 1;
      // `created_at` como no Postgres: o dublê tem que devolver o razão com a
      // mesma forma, senão a data que decide o prazo do trilho só existe em
      // produção (compliance MEDIUM-4 de d7f2683).
      log.push({
        seq, type, payload, created_at: new Date().toISOString(),
        ...(pspEventId != null ? { pspEventId } : {}),
      });
      return seq;
    },
    /** Ver a 0028: quem abriu a conta na mesa. Idempotente por conta+sessão. */
    async recordCheckView({ checkId, venueId, tableId, sessionHash }) {
      const chave = `${checkId}:${sessionHash}`;
      if (checkViews.has(chave)) return false;
      checkViews.set(chave, { checkId, venueId, tableId, sessionHash, at: new Date().toISOString() });
      return true;
    },
    /** O funil de adoção: abriram → pagaram. Ver o store do Supabase. */
    async getAdoptionFunnel(venueId, { sinceIso } = {}) {
      const corte = sinceIso ? Date.parse(sinceIso) : Date.now() - 30 * 86400000;
      const abertas = new Set([...checkViews.values()]
        .filter((v) => v.venueId === venueId && Date.parse(v.at) >= corte)
        .map((v) => v.checkId));
      const criadas = [...checks.values()]
        .filter((c) => c.venueId === venueId && Date.parse(c.openedAt || 0) >= corte);
      const pagas = new Set([...payments.values()]
        .filter((p) => p.status === 'confirmado' && p.confirmedAt
          && Date.parse(p.confirmedAt) >= corte
          && (p.venueId ?? (checks.get(p.checkId) || {}).venueId) === venueId)
        .map((p) => p.checkId));
      /** O numerador INTERSECTADO: quem pagou E foi visto na mesa. */
      const convertidas = new Set([...pagas].filter((id) => abertas.has(id)));
      return {
        contasCriadas: criadas.length,
        contasAbertasNaMesa: abertas.size,
        contasPagas: pagas.size,
        /**
       * A CONVERSÃO É SOBRE QUEM ABRIU — e o numerador tem que ser subconjunto
       * do denominador.
       *
       * Era `pagas.size / abertas.size` com os dois conjuntos medidos
       * INDEPENDENTES. O `recordCheckView` é telemetria de navegador, melhor
       * esforço: bloqueada, limitada por taxa ou perdida, a conta entra em
       * `pagas` e não em `abertas`. Com duas contas — A vista e não paga, B paga
       * com o beacon bloqueado — a conta dava 1.0, ou seja 100% de conversão,
       * onde a verdadeira é 0%. E é este número que o portão de adoção lê pra
       * decidir se o produto continua (CLAUDE.md, ≥25% na semana 8): inflado,
       * ele mantém vivo um piloto que fracassou. Achado pela terceira revisão de
       * segurança de 2026-09-16 (M4).
       */
      conversao: abertas.size > 0 ? convertidas.size / abertas.size : null,
      };
    },

    /** Ver a migração 0024: evento de dinheiro sem conta correspondente. */
    async recordOrphanMoneyEvent(e) {
      if (e.pspEventId && orphanEvents.some((o) => o.pspEventId === e.pspEventId)) return true;
      orphanEvents.push({ ...e, at: new Date().toISOString() });
      return true;
    },
    /** Só pra teste/inspeção: a lista de órfãos deste store. */
    async listOrphanMoneyEvents() { return [...orphanEvents]; },
    async listOpenOrphanMoneyEvents() {
      // `orderCode` na mesma forma do store de produção — ele vem dentro do
      // `payload` e a leitura o eleva, senão os dois stores descrevem órfãos
      // diferentes.
      return orphanEvents.filter((o) => !o.resolvedAt)
        .map((o) => ({ ...o, orderCode: (o.payload && o.payload.orderCode) || null }));
    },

    /**
     * Ver a migração 0023: só escreve se a linha ainda estiver como foi lida.
     * O duplo tem que recusar o que o banco recusa — senão a corrida que ele
     * deveria demonstrar passa verde aqui e falha lá.
     */
    async repairPaymentRow(p) {
      // `p.source` (migração 0029) é a procedência que o log grava. O duplo não
      // tem log, mas o CENSO de forma compara as chaves — e um duplo que aceita
      // menos que a produção é como o defeito de projeção começa.
      const atual = payments.get(p.txid);
      if (!atual) return false;
      if (atual.status !== p.expectedStatus) return false;
      if ((atual.refundedAmountCents || 0) !== (p.expectedRefundedAmountCents || 0)) return false;
      if ((atual.refundedTipCents || 0) !== (p.expectedRefundedTipCents || 0)) return false;
      payments.set(p.txid, {
        ...atual,
        status: p.status,
        confirmedAmountCents: p.confirmedAmountCents,
        confirmedTipCents: p.confirmedTipCents,
        refundedAmountCents: p.refundedAmountCents,
        refundedTipCents: p.refundedTipCents,
        confirmedAt: atual.confirmedAt || p.confirmedAt || null,
      });
      return true;
    },

    /**
     * Ver a migração 0020: `expirado` só pisa em `pendente`. O duplo tem que
     * ser tão restritivo quanto o banco — um pagamento confirmado não vira
     * expirado porque um evento antigo chegou atrasado.
     */
    async expirePaymentIfPending(txid) {
      const p = payments.get(txid);
      if (!p || p.status !== 'pendente') return false;
      payments.set(txid, { ...p, status: 'expirado' });
      return true;
    },
    /**
     * Este evento do PSP já foi aplicado?
     *
     * Consulta ANTES das conferências de estado, pra uma reentrega sair como
     * `duplicate` em vez de `rejected`. A garantia de verdade continua sendo o
     * índice único no append (migração 0018) — só ele fecha a corrida entre
     * duas entregas simultâneas, porque roda dentro do lock. Esta consulta é
     * pra a RESPOSTA ficar honesta: um 409 numa reentrega normal faz a Stripe
     * reenviar e acabar desabilitando o endpoint.
     */
    async seenPspEvent(pspEventId) {
      if (pspEventId == null) return false;
      for (const [, log] of events) {
        if (log.some((e) => e.pspEventId === pspEventId)) return true;
      }
      return false;
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
      //
      // E ele NORMALIZA, não só confere. Enquanto a regra era uma lista de
      // recusa, "conferir aqui" e "conferir no portão" davam no mesmo. Quando o
      // portão passou a LIMPAR, os dois deixaram de coincidir: o portão
      // aprovava `"Ana" + cem espaços` (que normaliza pra `"Ana"`) e esta linha
      // recusava o cru, DEPOIS de o adquirente já ter criado a cobrança — e a
      // vaga do teto não voltava. Guardar o normalizado é o que faz "o valor
      // conferido é o valor gravado" valer por construção, em vez de por
      // disciplina de chamador. Segunda revisão de segurança de 2026-09-16
      // (NEW-1).
      const rotulo = rotuloDoPagador(payerLabel);
      if (!rotulo.ok) throw badRequest('payerLabel must be a string of at most 60 chars');
      payerLabel = rotulo.valor;
      /**
       * `payments.txid` É ÚNICO NO BANCO (0001), e este dublê não recusava.
       *
       * Um segundo `registerCharge` com o mesmo txid SOBRESCREVIA a linha —
       * medido: uma cobrança já confirmada voltava a `pendente`, perdendo
       * `confirmedAt` e `confirmedAmountCents`. É exatamente a janela que a nova
       * tentativa de escrita abriu (o webhook confirma enquanto a primeira ida
       * de 10 s ainda está no ar), e em produção o `payments_txid_key` a fecha.
       *
       * Este arquivo já enuncia a regra sobre outro método — "o duplo tem que
       * recusar o que o banco recusa, senão a corrida que ele deveria demonstrar
       * passa verde aqui e falha lá" — e ela não tinha sido aplicada aqui. Sem
       * isto, o ramo "unicidade na segunda tentativa é sucesso" do
       * `create-charge` era inexercitável por dublê nenhum. Achado pela quarta
       * revisão de segurança de 2026-09-16 (MEDIUM-4).
       */
      if (payments.has(txid)) {
        /**
         * O NOME DA RESTRIÇÃO É EXTRAÍDO, não entregue de bandeja.
         *
         * Este sítio escrevia `pgConstraint: 'payments_txid_key'` direto,
         * enquanto o irmão vinte linhas acima já passava por
         * `nomeDaRestricao(mensagemDeUnicidade(...))` — e o motivo de aquele
         * passar está escrito no `pg-erro.js`: o ramo de FALHA da extração não
         * existe em teste nenhum se o dublê receber o nome pronto. Um
         * `lc_messages` não-inglês, ou um PostgREST que remonte a mensagem, e a
         * produção devolve `pgConstraint: null` onde o dublê devolvia o nome.
         *
         * Os dois revisores pediram pra promover isto duas rodadas seguidas, e
         * pelo mesmo motivo: duas decisões de dinheiro vivas hoje — a posse da
         * linha na primeira ida e o `linhaJaGravada` — dependem de um `23505`
         * que só este dublê e o MockPsp produzem. Ou seja, o dublê virou o
         * ÚNICO executor delas.
         *
         * SEJA HONESTO SOBRE O QUE ISTO COMPRA, porque eu já exagerei uma vez:
         * `nomeDaRestricao(mensagemDeUnicidade(x))` é a IDENTIDADE nesse input,
         * então o dublê continua sempre devolvendo o nome e nunca `null` — ele
         * não passou a errar como a produção erra, só passou a usar o extrator.
         * E o ramo de falha do extrator já tinha teste (`pg-erro.test.js`, o
         * caso em espanhol); a minha mensagem de commit dizia que não tinha.
         *
         * O que o censo irmão compra de verdade é impedir que um sítio NOVO
         * volte a escrever o nome à mão. O que ainda falta é um dublê com botão
         * de locale, que devolva `pgConstraint: null` e force o caminho de
         * `podeSerReentrega` — está no `o-que-dez-rodadas...md`.
         */
        throw Object.assign(
          new Error(`memory store registerCharge: ${mensagemDeUnicidade('payments_txid_key')}`),
          {
            pgCode: '23505',
            pgConstraint: nomeDaRestricao(mensagemDeUnicidade('payments_txid_key')),
          },
        );
      }
      txidToCheck.set(txid, checkId);
      const check = checks.get(checkId);
      const chargeVenue = check ? venues.get(check.venueId) : null;
      payments.set(txid, {
        txid, checkId, venueId: check ? check.venueId : null, // panel scoping
        amountCents, tipCents,
        payerLabel: payerLabel || null, method,
        // A MOEDA na linha, não deduzida na leitura. Ver
        // 0014_payment_currency.sql: `venues.market` pode mudar e o pagamento
        // não pode ser reetiquetado depois do fato.
        currency: market(chargeVenue && chargeVenue.market).currency,
        status: 'pendente', createdAt: new Date().toISOString(),
      });
    },
    async recordPayment({
      txid, kind, status, pspPayloadMasked, confirmedAt,
      confirmedAmountCents = null, confirmedTipCents = null,
      refundedAmountCents = null, refundedTipCents = null,
    }) {
      const p = payments.get(txid);
      if (!p) return;
      payments.set(txid, {
        ...p,
        // Os valores CONFIRMADOS entram ao lado dos registrados, nunca em cima
        // (migração 0015): comparar pedido contra log é o que produz o
        // `amount_mismatch`, e sobrescrever faria os dois concordarem sempre.
        ...(confirmedAmountCents !== null ? { confirmedAmountCents } : {}),
        ...(confirmedTipCents !== null ? { confirmedTipCents } : {}),
        // Acumulado ESTORNADO na linha: quem soma dinheiro soma líquido, em vez
        // de dropar a linha inteira num estorno parcial (migração 0016).
        ...(refundedAmountCents !== null ? { refundedAmountCents } : {}),
        ...(refundedTipCents !== null ? { refundedTipCents } : {}),
        // O status vem resolvido do módulo de dinheiro (ver
        // ROW_STATUS_FOR_KIND). Era `kind === 'refund' ? … : 'confirmado'` aqui,
        // e com a família da disputa lida de verdade esse `else` fazia uma
        // disputa PERDIDA virar `confirmado` com o dinheiro já ido.
        status: status || (kind === 'refund' ? 'devolvido' : 'confirmado'),
        // `undefined` e NAO MEXER, igual a producao.
        //
        // Aqui era `pspPayloadMasked, confirmedAt` cru. O aplicador omite
        // `confirmedAt` de proposito em tudo que nao e confirmacao — pra um
        // estorno nao reescrever a data de um pagamento de tres semanas atras
        // e mover o faturamento de dia. O supabase-js dropa `undefined` do
        // corpo do PATCH, entao em producao a data sobrevivia; aqui ela era
        // apagada, e o pagamento sumia da serie semanal depois de qualquer
        // estorno, reversao ou disputa ganha.
        //
        // Um duble que se comporta diferente da producao e uma armadilha, nao
        // um duble — foi assim que tres tipos de evento chegaram a producao
        // recusados por um CHECK que nenhum teste lia. Achado pela revisao de
        // seguranca de 2026-09-08.
        ...(pspPayloadMasked !== undefined ? { pspPayloadMasked } : {}),
        ...(confirmedAt !== undefined ? { confirmedAt } : {}),
      });
    },

    // --- house accounts (saldo da casa) -------------------------------------
    async getVenueByTableToken(qrToken) {
      const table = tables.get(qrToken);
      if (!table || !table.active) return null;
      return { venue: venues.get(table.venueId), table: { id: table.id, label: table.label, training: table.training === true } };
    },
    /** Grava o recebedor + status inicial + contatos do dono (aviso de KYC). */
    async setVenueRecipient(venueId, recipientId, opts = {}) {
      const venue = venues.get(venueId);
      if (!venue) throw new Error('unknown venue');
      venue.pspRecipientId = recipientId;
      if (opts.status !== undefined) venue.pspRecipientStatus = opts.status;
      if (opts.notifyEmail !== undefined) venue.notifyEmail = opts.notifyEmail;
      if (opts.notifyWhatsapp !== undefined) venue.notifyWhatsapp = opts.notifyWhatsapp;
      if (opts.cnpj !== undefined) venue.cnpj = opts.cnpj;
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
          // Ver o store do Supabase e a 0027: a perna de custódia precisa do ID.
        pspRecipientId: v.pspRecipientId || null,
        // Ver o store do Supabase e a 0027: a perna de custódia precisa do ID.
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
        if (a.venueId === venueId && a.phone === phone) throw Object.assign(new Error('duplicate house account'), { code: 'house_duplicate_account' });
      }
      const id = crypto.randomUUID();
      const accountToken = crypto.randomUUID().replace(/-/g, '');
      // A moeda do SALDO, gravada na abertura. Um crédito em real não quita
      // conta em euro, nem 1:1 nem convertido — e o `redeem` aplicava 1:1 sem
      // olhar, se alguém virasse o market da venue depois. Ver
      // 0014_payment_currency.sql; no Supabase é o default da coluna, porque a
      // abertura passa por RPC.
      const row = {
        id, venueId, phone, name, accountToken, active: true,
        currency: market(venues.get(venueId).market).currency,
        createdAt: new Date().toISOString(),
      };
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
    /**
     * Retenção (migração 0031), em memória. Existe porque a divergência entre
     * os dois stores é invisível: a rota do cron respondia `200 {skipped}` num
     * store sem o método, e cron verde num store que não sabe expurgar é
     * sucesso silencioso. Há censo de paridade de MÉTODOS agora.
     */
    async purgeExpiredPersonalData(prazos = {}) {
      const labelDays = prazos.labelDays ?? 90;
      const walletDays = prazos.walletDays ?? 90;
      const viewsDays = prazos.viewsDays ?? 90;
      const limite = (d) => Date.now() - d * 24 * 60 * 60 * 1000;
      let payerLabels = 0; let payerHints = 0; let houseAccountsN = 0; let checkViews = 0;

      for (const p of payments.values()) {
        if (!p.payerLabel) continue;
        const c = checks.get(p.checkId);
        const fechada = c && c.status === 'fechada' && c.closedAt
          && Date.parse(c.closedAt) < limite(labelDays);
        const velha = p.createdAt && Date.parse(p.createdAt) < limite(labelDays * 2);
        if (fechada || velha) { p.payerLabel = null; payerLabels += 1; }
      }
      for (const p of payments.values()) {
        const m = p.pspPayloadMasked;
        if (m && (('payer_hint' in m) || ('payer_doc_hint' in m))) {
          delete m.payer_hint; delete m.payer_doc_hint; payerHints += 1;
        }
      }
      for (const a of houseAccounts.values()) {
        if (!a.phone || a.principalCents !== 0) continue;
        // Bônus VIVO é dinheiro que a pessoa ainda pode gastar. A primeira
        // versão deste laço não tinha esta cláusula e o SQL tinha: as duas
        // implementações da MESMA regra já divergiam, e a maioria dos testes
        // roda contra esta — então um teste escrito aqui afirmaria a regra
        // errada. Achado da revisão de segurança.
        // Os lotes vivem no LOG, não numa coleção — o estado da carteira é
        // reduzido dos eventos, como o resto do produto.
        const lotes = (houseState.reduce(houseEvents.get(a.id) || []) || { lots: [] }).lots || [];
        const bonusVivo = lotes.some(
          (l) => (l.remainingCents || 0) > 0 && Date.parse(l.expiresAt || 0) > Date.now(),
        );
        if (bonusVivo) continue;
        const eventos = houseEvents.get(a.id) || [];
        const recente = eventos.some((e) => Date.parse(e.createdAt || 0) >= limite(walletDays));
        if (recente) continue;
        if (a.updatedAt && Date.parse(a.updatedAt) >= limite(walletDays)) continue;
        a.phone = null; a.name = '—'; houseAccountsN += 1;
      }
      const resumo = { payerLabels, payerHints, houseAccounts: houseAccountsN, checkViews };
      // Mesma transação, no espírito: o registro nasce junto com o expurgo.
      retentionRuns.push({ at: new Date().toISOString(), kind: 'purge', ...resumo });
      return resumo;
    },

    async lastRetentionRun() {
      const purgas = retentionRuns.filter((r) => r.kind === 'purge');
      if (!purgas.length) return null;
      // A MESMA FORMA do store do Postgres, sem `kind`: os dois já divergiram
      // uma vez nesta função (bônus vivo), e a maioria dos testes roda contra
      // este — então uma divergência aqui vira teste afirmando a regra errada.
      const { at, payerLabels, payerHints, houseAccounts, checkViews } = purgas[purgas.length - 1];
      return { at, payerLabels, payerHints, houseAccounts, checkViews };
    },

    async erasePaymentLabel(txid) {
      // Conta a LINHA TOCADA, não a linha mudada — é o que `get diagnostics
      // row_count` devolve no SQL. As duas divergiam (aqui zero pra um rótulo
      // já nulo, lá um), e o `scripts/erase-payment-label.js` ramifica
      // exatamente nesse número pra dizer "txid não encontrado".
      let n = 0;
      for (const p of payments.values()) {
        if (p.txid !== txid) continue;
        p.payerLabel = null;
        n += 1;
      }
      // Registra SEMPRE, inclusive no zero: "pediram e não havia" também é uma
      // resposta do art. 18 §4.
      retentionRuns.push({ at: new Date().toISOString(), kind: 'erasure_request', payerLabels: n, txid });
      return n;
    },

    async setHouseAccountActive(accountId, active) {
      const a = houseAccounts.get(accountId);
      if (!a) { const e = new Error('house_account_not_found'); e.statusCode = 404; e.code = 'house_account_not_found'; throw e; }
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
      houseLoads.set(txid, {
        txid, accountId, amountCents, bonusCents, validityDays, status: 'pendente',
        // `createdAt` existe pro TETO de cargas vivas — a coluna já existia no
        // Postgres (`house_loads.created_at`) e faltava aqui, então o gêmeo em
        // memória não podia medir a mesma janela. Ver `assertLoadSlot` no `house-service.js`.
        createdAt: new Date().toISOString(),
      });
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
        throw Object.assign(new Error('house_invalid_amount'), { statusCode: 400, code: 'house_invalid_amount' }); // = 22023 da 0040
      }
      const log = houseEvents.get(accountId);
      const naoAchada = () => Object.assign(new Error('house_account_not_found'), { statusCode: 404, code: 'house_account_not_found' }); // = RH005
      if (!log) throw naoAchada();
      const account = houseAccounts.get(accountId);
      if (!account || !account.active) throw naoAchada();
      const state = houseState.reduce(log);
      // idempotency: a retried redeem with the same txid returns the prior debit
      if (state && state.redeems[txid]) {
        const prior = state.redeems[txid];
        // = RH006 da 0041: débito ESTORNADO não é "já feito" — o retry com a
        // mesma chave pagaria a conta sem débito (compliance, PR #31, LOW-1).
        if (prior.reversed) {
          throw Object.assign(new Error('house_redeem_reversed'), { statusCode: 409, code: 'house_redeem_reversed' });
        }
        // = RH008 da 0042: o "já feito" tem de ser o MESMO pagamento.
        if (prior.checkId !== checkId || (prior.principalCents + prior.bonusCents) !== amountCents) {
          throw Object.assign(new Error('house_idempotency_mismatch'), { statusCode: 409, code: 'house_idempotency_mismatch' });
        }
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
          const err = new Error('house_insufficient_balance'); err.statusCode = 409; err.code = 'house_insufficient_balance'; throw err;
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
    async reverseHouseRedeem({ accountId, txid, nowIso, reason = 'check_append_refused', actor = null }) {
      // = 22023 da 0044: motivo de lista fechada; o do dono exige autor.
      if (!['check_append_refused', 'owner_recredit'].includes(reason)
        || (reason === 'owner_recredit' && !actor)) {
        throw Object.assign(new Error('house_invalid_amount'), { statusCode: 400, code: 'house_invalid_amount' });
      }
      const log = houseEvents.get(accountId);
      if (!log) throw new Error('unknown house account');
      const state = houseState.reduce(log);
      const orig = state ? state.redeems[txid] : null;
      // = RH010 da 0043: não há débito com este txid — nada foi debitado.
      if (!orig) throw Object.assign(new Error('house_redeem_unknown'), { statusCode: 404, code: 'house_redeem_unknown' });
      // = RH007 da 0042: o pagamento deste txid JÁ ENTROU na conta — estornar o
      // débito deixaria a conta paga sem débito.
      const logDaConta = events.get(orig.checkId) || [];
      if (logDaConta.some((e) => e.type === 'PAYMENT_CONFIRMED' && e.payload && e.payload.txid === txid)) {
        throw Object.assign(new Error('house_redeem_landed'), { statusCode: 409, code: 'house_redeem_landed' });
      }
      if (orig.reversed) return { duplicate: true };
      const seq = _houseAppend(accountId, 'REDEEM_REVERSED', {
        txid, at: nowIso, reason, ...(actor ? { actor } : {}),
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
      // = RH006 da 0042: o débito deste txid já foi estornado — não se lança.
      for (const hlog of houseEvents.values()) {
        if (hlog.some((e) => e.type === 'REDEEM_REVERSED' && e.payload && e.payload.txid === txid)) {
          throw Object.assign(new Error('house_redeem_reversed'), { statusCode: 409, code: 'house_redeem_reversed' });
        }
      }
      if (!state || state.status === 'fechada') {
        const e = new Error('check_closed'); e.statusCode = 409; e.code = 'check_closed'; throw e;
      }
      // = RH009 da 0043: só entra na conta o pagamento que tem DÉBITO — mesmo
      // txid, mesma conta, principal + bônus = valor. Antes do "excede", como
      // no banco: sem débito não se manda estornar nada.
      let temDebito = false;
      for (const hlog of houseEvents.values()) {
        if (hlog.some((e) => e.type === 'REDEEMED' && e.payload && e.payload.txid === txid
          && e.payload.checkId === checkId
          && (e.payload.principalCents || 0) + (e.payload.bonusCents || 0) === amountCents)) { temDebito = true; break; }
      }
      if (!temDebito) {
        throw Object.assign(new Error('house_debit_missing'), { statusCode: 500, code: 'house_debit_missing' });
      }
      if (state.paidCents + amountCents > state.totalCents) {
        const e = new Error('house_exceeds_remaining'); e.statusCode = 409; e.code = 'house_exceeds_remaining'; throw e;
      }
      const seq = log.length + 1;
      // `created_at` aqui também: no Postgres a coluna tem `default now()`, e o
      // dublê sem ela devolvia `confirmedAt: null` onde a produção devolve data
      // — dublê MENOS informado que o banco é a inversão do defeito que a rodada
      // passada consertou no outro sentido (segurança LOW-5 de 41b188a).
      log.push({
        seq, type: 'PAYMENT_CONFIRMED', created_at: new Date().toISOString(),
        payload: { txid, amountCents, tipCents: 0, method: 'house_account' },
      });
      return seq;
    },
    async refundHousePrincipal({ accountId, amountCents, nowIso }) {
      const log = houseEvents.get(accountId);
      if (!log) { const e = new Error('house_account_not_found'); e.statusCode = 404; e.code = 'house_account_not_found'; throw e; }
      const state = houseState.reduce(log);
      if (!state || amountCents > state.principalCents) {
        const e = new Error('house_insufficient_balance'); e.statusCode = 409; e.code = 'house_insufficient_balance'; throw e;
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
