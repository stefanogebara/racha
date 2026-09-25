'use strict';
const { eMesaDeTreino, CODIGO_MESA_DE_TREINO } = require('../checks/mesa-de-treino');

const { gravarAposCobrar } = require('../pay/gravar-apos-cobrar');

const { isDemoVenue } = require('../demo');

// A janela é a MESMA da conta da mesa — validade do Pix, 15 minutos — e vem de
// lá, não de um número repetido aqui: duas janelas que deviam ser uma já
// divergiram neste repositório por um acento e por um `\b`.
const { JANELA_VIVA_MS } = require('../pay/create-charge');
const { normalizarTextoDaCasa } = require('../texto-da-casa');
/** O CHECK da 0005: `house_accounts.name` é `char_length between 1 and 60`. */
const NOME_DA_CONTA_MAX = 60;
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

/**
 * Reivindica uma vaga de carga nesta CONTA e nesta CASA de uma vez, e devolve
 * a função que as devolve se o PSP nem chegou a ser chamado. Ver
 * `assertChargeSlot` no `create-charge.js` e a migração 0033: a contagem e a
 * reserva são uma instrução só no banco, com janela deslizante.
 *
 * DOIS CÓDIGOS, porque os prazos são diferentes. Por CONTA, quem enche o balde
 * é o próprio dono da carteira (o token é dele), então a espera tem prazo e ele
 * vai na frase. Por CASA, contas de saldo são de graça e quem as gera pode manter
 * o balde cheio: sem prazo. A versão anterior deste texto chamava "pague uma
 * delas" de remédio da conta — não é: a carteira não lista recarga pendente,
 * voltar descarta o código, e pagar não libera vaga. (Compliance, L3.)
 *
 * A CHAVE DA CASA VEM PRIMEIRO: com os dois baldes cheios, a recusa que sai é a
 * sem prazo. Na ordem inversa a pessoa lia "tente em até 15 minutos", esperava, e
 * recebia a recusa da casa. (Compliance, L4.)
 */
async function assertLoadSlot(store, account) {
  const r = await store.claimSlots({
    keys: [`venue:${account.venueId}`, `account:${account.id}`],
    limits: [TETO_CARGAS_POR_CASA, TETO_CARGAS],
    windowMs: JANELA_VIVA_MS,
  });
  if (r.claimId === null) {
    const porCasa = r.fullIndex === 0;
    const limite = porCasa ? TETO_CARGAS_POR_CASA : TETO_CARGAS;
    // Ver o gêmeo: guarda que ninguém vê é guarda caracterizado em produção.
    process.stderr.write(`[teto] cargas vivas ${porCasa ? `casa=${account.venueId}` : `conta=${account.id}`} ocupadas=${r.counts[r.fullIndex]} teto=${limite}\n`);
    const err = new Error(`too many live pending loads (${r.counts[r.fullIndex]})`);
    err.statusCode = 429;
    err.code = porCasa ? 'too_many_pending_loads_venue' : 'too_many_pending_loads';
    // Prazo só por conta — ver o docblock. E a casa vai no erro pro aviso ao
    // operador (`avisarTetoDisparado`), nunca pro corpo.
    err.vars = porCasa ? { limit: limite } : { limit: limite, windowMinutes: JANELA_VIVA_MS / 60000 };
    if (porCasa) err.venueId = account.venueId;
    throw err;
  }
  let devolvida = false;
  return async function devolver() {
    if (devolvida) return;
    devolvida = true;
    try {
      await store.releaseSlots(r.claimId);
    } catch (e) {
      process.stderr.write(`[teto] vaga de carga não devolvida claim=${r.claimId}: ${String(e && e.message).slice(0, 80)}\n`);
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
/**
 * O EXTRATO: tipo e valores, SEM frase — a tela traduz pelo `type` (o servidor
 * não escolhe língua por quem ele não vê; CLAUDE.md).
 *
 * E o ESTORNO APARECE. Um pagamento recusado pela conta é estornado
 * (`REDEEM_REVERSED`) e a tela diz "seu saldo não foi debitado" — mas o extrato
 * mostrava o `REDEEMED` como "Pagamento na mesa −R$X" e nenhuma linha de volta:
 * saldo certo, extrato contradizendo (compliance, PR #31, M-3; CDC art. 6º III).
 * Agora a volta tem linha própria, com o valor do débito que ela desfaz.
 */
function ledgerView(events) {
  const rows = [];
  const debitos = new Map();   // txid → valor debitado (principal + bônus), ainda não estornado
  const vistos = new Set();    // txids de REDEEMED já contados
  for (const evt of events) {
    const p = evt.payload || {};
    if (evt.type === 'LOAD_CONFIRMED') {
      rows.push({ at: p.at ?? null, type: 'load', amountCents: p.principalCents, bonusCents: p.bonusCents ?? 0 });
    } else if (evt.type === 'REDEEMED') {
      // Dedup como o redutor (razão at-least-once): o mesmo txid duas vezes é
      // UM débito — o extrato não pode divergir do saldo (compliance, PR #32, L-4).
      if (vistos.has(p.txid)) continue;
      vistos.add(p.txid);
      const valor = (p.principalCents ?? 0) + (p.bonusCents ?? 0);
      debitos.set(p.txid, valor);
      rows.push({ at: p.at ?? null, type: 'redeem', amountCents: -valor, bonusCents: 0 });
    } else if (evt.type === 'REDEEM_REVERSED') {
      const valor = debitos.get(p.txid);
      if (valor !== undefined) {
        debitos.delete(p.txid);   // uma volta por débito
        rows.push({ at: p.at ?? null, type: 'redeem_reversed', amountCents: valor, bonusCents: 0 });
      }
    } else if (evt.type === 'PRINCIPAL_REFUNDED') {
      rows.push({ at: p.at ?? null, type: 'refund', amountCents: -p.amountCents, bonusCents: 0 });
    }
  }
  return rows.reverse(); // most recent first
}

function createHouseService({ store, psp, now = () => new Date().toISOString() }) {
  if (!store || !psp) throw new Error('createHouseService: missing dependencies');

  /** Public per-table config — what the diner sees before opening a wallet. */
  async function publicConfig(tableQrToken) {
    const hit = await store.getVenueByTableToken(tableQrToken || '');
    if (!hit) throw httpError(404, 'Mesa não encontrada', 'table_not_found');
    const cfg = venueHouseConfig(hit.venue);
    return {
      // Na mesa de treino o saldo não se oferece: abrir e recarregar é Pix real.
      // Nem em mercado não liberado: o formulário pede nome e telefone e só
      // falharia no envio (segurança e compliance, PR #26).
      enabled: cfg.enabled && !eMesaDeTreino(hit) && !chargingAllowed(hit.venue.market),
      venueName: hit.venue.name,
      bonusBp: cfg.bonusBp,
      validityDays: cfg.validityDays,
      minLoadCents: cfg.minLoadCents,
      maxLoadCents: cfg.maxLoadCents,
    };
  }

  async function openAccount({ tableQrToken, phone, name }) {
    const hit = await store.getVenueByTableToken(tableQrToken || '');
    if (!hit) throw httpError(404, 'Mesa não encontrada', 'table_not_found');
    // Nem carteira nova a partir da mesa de treino: a recarga é Pix de verdade,
    // e "mesa de treino nunca cobra" não tem exceção (compliance, PR #18, LOW-1).
    if (eMesaDeTreino(hit)) throw httpError(409, 'mesa de treino não cobra', CODIGO_MESA_DE_TREINO);
    // A TRAVA DE MERCADO MORA AQUI, no serviço — como na recarga e no resgate.
    // Na rota ela lia `.market` do par { venue, table } e nunca disparava; e
    // qualquer outro chamador de `openAccount` a pularia. A carteira coleta
    // nome e telefone: em mercado não liberado (Espanha sem a papelada de
    // transferência internacional), nada é gravado (PR #26).
    const live = chargingAllowed(hit.venue.market);
    if (live) throw badRequest(`mercado ${hit.venue.market}: ${live.code}`, live.code);
    const cfg = venueHouseConfig(hit.venue);
    if (!cfg.enabled) throw badRequest('house balance is off for this venue', 'house_off');
    const digits = normalizePhone(phone);
    if (!digits) throw badRequest('Telefone inválido', 'house_phone_invalid');
    // PELO MESMO NORMALIZADOR das palavras da casa. Este nome aparece na tela
    // do balcão, então ele carrega o mesmo risco de marca bidi e zero-width; e
    // o `.length` que estava aqui conta unidades UTF-16 enquanto o CHECK da
    // 0005 conta pontos de código — sessenta emoji passavam num lado e não no
    // outro.
    //
    // E sai com CÓDIGO, não com a frase em português que estava aqui: o
    // CLAUDE.md diz que o servidor manda código e o cliente escolhe a língua, e
    // esta é uma tela de CLIENTE — a pessoa que abre a conta da casa pode estar
    // lendo em inglês ou espanhol. O número do limite viaja em `vars` pra frase
    // não ter que repeti-lo (seria a quinta cópia).
    const nome = normalizarTextoDaCasa(name, { max: NOME_DA_CONTA_MAX, code: 'house_name_invalid' });
    if (!nome.ok) throw badRequest('house account name invalid', nome.code, nome.vars);
    // Abuse bound: a public endpoint must not allow unbounded row creation
    // (each account also costs the owner panel a ledger read).
    const MAX_ACCOUNTS_PER_VENUE = 5000;
    if (store.countHouseAccounts
        && (await store.countHouseAccounts(hit.venue.id)) >= MAX_ACCOUNTS_PER_VENUE) {
      // 409 com CÓDIGO, não 503: é capacidade, não falha do servidor — e todo 5xx
      // vira 'internal' no `errorBody`, então o 'fale com o balcão' nunca chegava
      // (compliance, PR #32, M-2).
      throw httpError(409, 'Limite de contas deste restaurante atingido — fale com o balcão', 'house_account_limit');
    }
    let account;
    try {
      account = await store.createHouseAccount({
        venueId: hit.venue.id, phone: digits, name: nome.valor,
      });
    } catch (e) {
      // Pelo CÓDIGO que o store põe (23505 → `house_duplicate_account`), não
      // pela palavra "duplicate" na mensagem.
      if (e && e.code === 'house_duplicate_account') {
        // NEVER return the existing token — knowing a phone number must not
        // grant access to its balance. Recovery goes through the owner panel.
        throw httpError(409, 'Conta já existe — peça seu link no balcão', 'house_account_exists');
      }
      throw e;
    }
    return { accountToken: account.accountToken, venueName: hit.venue.name };
  }

  async function wallet(accountToken) {
    const account = await store.getHouseAccountByToken(accountToken || '');
    if (!account) throw httpError(404, 'Conta não encontrada', 'house_account_not_found');
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
      // `demo`: a carteira só mostra o botão de SIMULAR a confirmação do banco na
      // casa de demonstração — aparecia pra todo cliente de verdade (auditorias
      // de fluxo H2 e de UI H3). A decisão é a da casa, a mesma do `isDemoVenue`.
      venue: { name: venue ? venue.name : '?', demo: isDemoVenue(venue) },
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
    if (!account) throw httpError(404, 'Conta não encontrada', 'house_account_not_found');
    const venue = await store.getVenue(account.venueId);
    if (!venue) throw httpError(404, 'venue not found', 'venue_not_found');
    const cfg = venueHouseConfig(venue);
    if (!cfg.enabled) throw badRequest('house balance is off for this venue', 'house_off');
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequest('Valor inválido', 'house_invalid_amount');
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

    const devolverVaga = await assertLoadSlot(store, account);
    let pspChamado = false;
    try {
    const bonusCents = quoteBonusCents(amountCents, cfg.bonusBp);
    // Daqui em diante o adquirente pode ter criado algo: a vaga fica. Ver
    // `assertChargeSlot` no `create-charge.js` — a regra anterior era furável.
    pspChamado = true;
    const charge = await psp.createPixCharge({
      // Random nonce: two identical loads are DIFFERENT charges (the mock PSP
      // derives txid from chargeRef; a deterministic ref would collide).
      chargeRef: `hload:${account.id}:${crypto.randomUUID()}`,
      amountCents,
      tipCents: 0,
      recipientId: venue.pspRecipientId, // venue is the issuer — funds go direct
      description: `Saldo ${venue.name}`.slice(0, 40),
    });
    /**
     * O MESMO PORTÃO DOS OUTROS DOIS CAMINHOS.
     *
     * Aqui também se fala com o adquirente ANTES de gravar, então aqui também
     * um prazo de 10 s do banco devolvia 500 `internal` → "algo deu errado,
     * tente de novo", que é a frase exata que `gravar-apos-cobrar` existe pra
     * substituir. O dano é menor que no cartão (o Pix não captura nada, e o
     * copia-e-cola nem chegou a quem pediu), mas é a MESMA forma — e o censo
     * que devia impedir um terceiro caminho só lia o `router.js`, então não viu
     * este. Achado pela sexta revisão de compliance (2026-09-19, MEDIUM-1).
     *
     * Sem `nossa`: o `chargeRef` daqui carrega um UUID aleatório de propósito
     * (ver acima), então dois carregamentos idênticos são cobranças
     * DIFERENTES e não há colisão de txid pra desfazer.
     */
    await gravarAposCobrar({
      gravar: () => store.registerHouseLoad({
        accountId: account.id,
        txid: charge.txid,
        amountCents,
        bonusCents,                     // quoted NOW; webhook applies this, not live config
        validityDays: cfg.validityDays, // snapshot too
      }),
      capturou: false,                  // Pix: a cobrança existe, ninguém foi debitado
      txid: charge.txid, alvo: `conta-da-casa=${account.id}`, rail: 'pix',
    });
    return {
      txid: charge.txid, copiaECola: charge.copiaECola, expiresAt: charge.expiresAt,
      amountCents, bonusCents,
    };
    } finally {
      if (!pspChamado) await devolverVaga();
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
    if (!account) throw httpError(404, 'Conta não encontrada', 'house_account_not_found');
    const view = await store.getCheckByQrToken(tableQrToken || '');
    if (!view) throw httpError(404, 'Mesa sem conta aberta', 'check_not_found');
    // Saldo da casa é dinheiro do cliente: mesa de treino não o gasta.
    if (eMesaDeTreino(view)) throw httpError(409, 'mesa de treino não cobra', CODIGO_MESA_DE_TREINO);
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

    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequest('Valor inválido', 'house_invalid_amount');
    const remaining = remainingCents(view.state);
    if (amountCents > remaining) {
      throw badRequest(`Valor excede o que falta pagar (${remaining} centavos)`, 'house_exceeds_remaining');
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
      // TAMBÉM no retry (`debit.duplicate`): o append é idempotente por txid,
      // então um 409 prova que ESTE txid nunca entrou na conta — e o estorno é
      // idempotente. Sem isto, a tentativa que debitou e caiu antes do append
      // deixava o cliente debitado no retry (compliance, PR #31, M-2).
      if (e.statusCode === 409) {
        // The check refused the payment (raced full / closed). Compensate:
        // put the exact breakdown back and tell the diner nothing was spent.
        await store.reverseHouseRedeem({ accountId: account.id, txid, nowIso: now() });
        throw httpError(409, 'A conta mudou agora há pouco — seu saldo não foi debitado', 'house_raced');
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
    if (!r) throw httpError(404, 'Conta não encontrada', 'house_account_not_found');
    return { accountToken: r.accountToken };
  }

  async function refundPrincipal({ accountId, amountCents }) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequest('Valor inválido', 'house_invalid_amount');
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

module.exports = { createHouseService, normalizePhone, maskPhone, quoteBonusCents, ledgerView };
