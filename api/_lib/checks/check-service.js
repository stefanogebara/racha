'use strict';

/**
 * Check lifecycle — the money-safe write side that opens / adjusts / closes a
 * check on a table. This is what a POS adapter drives: in MANUAL mode the
 * owner triggers these from the panel (they enter the total); in a future POS
 * integration the sync triggers them from the POS's open comanda. Either way
 * the same validated events land in the log.
 *
 * Every mutation goes through validateEvent (the strict append gate) before
 * appendEvent, so a closed check can never be re-opened/adjusted and the
 * reducer stays total. Store is injected → testable against both stores.
 */

const { reduce, validateEvent } = require('./check-state');
const { desfechoDoLancamento } = require('./reconcile');

/**
 * LER → CONFERIR → GRAVAR, com a gravação CONDICIONAL ao que foi lido.
 *
 * `closeCheck` e `adjustCheck` liam o razão e depois gravavam, sem nada entre
 * as duas coisas: dois toques no "fechar" (o botão fica ativo 3–4 s sem retorno,
 * medido pela auditoria do painel) gravavam DOIS `CLOSED`; um ajuste e um
 * pagamento cruzados gravavam o ajuste sobre um estado que já não existia. A
 * mesma forma que a demo abandonou no PR #16. Agora o lançamento só entra se o
 * razão ainda está no `seq` lido (`appendEventIfUnchanged`, migração 0034); se
 * mudou (`conflito`), relê e decide de novo — até `TENTATIVAS` vezes.
 *
 * `decidir(state)` devolve o evento a gravar, ou `{ pronto }` quando a releitura
 * mostra que não há mais nada a fazer (a outra chamada já fechou).
 */
const TENTATIVAS = 3;

async function lancarCondicional(store, checkId, decidir) {
  for (let i = 0; i < TENTATIVAS; i += 1) {
    const eventos = await store.loadEvents(checkId);
    const state = reduce(eventos);
    if (!state) throw badRequest('conta não encontrada');
    const d = await decidir(state);
    if (d.pronto) return d.pronto;
    const seq = eventos.length ? eventos[eventos.length - 1].seq : 0;
    try {
      await store.appendEventIfUnchanged(checkId, d.type, d.payload, null, seq);
      return d.resultado;
    } catch (e) {
      // Conflito: o razão andou entre a leitura e a gravação. Relê. Qualquer
      // outro desfecho é erro de verdade e sobe — pelo classificador, que é o
      // único lugar que decide por código de erro (censo do `sql-contract`).
      if (desfechoDoLancamento(e) !== 'conflito') throw e;
    }
  }
  const e = new Error('a conta mudou enquanto a gente gravava — tente de novo');
  e.statusCode = 409; e.code = 'check_changed';
  throw e;
}

function badRequest(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  return err;
}

/**
 * Normalize owner input into a validated item list. Accepts an itemized bill
 * OR a single total (total-only venues). Always yields items so the diner
 * sees a line breakdown; the total is the sum.
 */
const MAX_ITEMS = 200; // a real check never has more; bounds the stored snapshot

function normalizeItems({ items, totalCents }) {
  if (Array.isArray(items) && items.length > 0) {
    if (items.length > MAX_ITEMS) throw badRequest(`no máximo ${MAX_ITEMS} itens por conta`);
    let sum = 0;
    const out = items.map((it, i) => {
      if (!it || typeof it.name !== 'string' || !it.name.trim()) throw badRequest(`item ${i + 1}: nome obrigatório`);
      if (!Number.isSafeInteger(it.priceCents) || it.priceCents < 0) throw badRequest(`item ${i + 1}: valor inválido`);
      sum += it.priceCents;
      if (sum > Number.MAX_SAFE_INTEGER) throw badRequest('total excede o limite');
      return { id: String(it.id || `i${i + 1}`), name: it.name.trim().slice(0, 80), priceCents: it.priceCents };
    });
    if (sum === 0) throw badRequest('a conta não pode ser zero');
    return out;
  }
  if (Number.isSafeInteger(totalCents) && totalCents > 0) {
    return [{ id: 'total', name: 'Total da conta', priceCents: totalCents }];
  }
  throw badRequest('informe os itens ou um total maior que zero');
}

function createCheckService({ store }) {
  if (!store) throw new Error('createCheckService: store required');

  /** Open a check on a table (one open check per table). */
  async function openCheck({ tableId, items, totalCents }) {
    const table = await store.getTable(tableId);
    if (!table) throw badRequest('mesa não encontrada');
    if (!table.active) throw badRequest('mesa desativada');
    // One open check per table — reuse the security-derived open-check read.
    if (await store.getCheckByQrToken(table.qrToken)) {
      throw badRequest('mesa já tem uma conta aberta');
    }
    const norm = normalizeItems({ items, totalCents });
    const check = await store.openCheck(table.qrToken, norm);
    return { checkId: check.id, tableId, totalCents: norm.reduce((s, i) => s + i.priceCents, 0), items: norm };
  }

  /** Adjust an open check's total/items (waiter added items). */
  async function adjustCheck({ checkId, items, totalCents }) {
    const norm = normalizeItems({ items, totalCents });
    const newTotal = norm.reduce((s, i) => s + i.priceCents, 0);
    return lancarCondicional(store, checkId, async (state) => {
      // validateEvent throws (→ 400) if the check is closed.
      try { validateEvent({ type: 'ADJUSTED', payload: { totalCents: newTotal } }, state); }
      catch (e) { throw badRequest(e.message); }
      // Items snapshot first, then the event — a diner reading between the two
      // sees the OLD total with OLD items (consistent), never new items w/ old total.
      await store.setCheckItems(checkId, norm);
      return { type: 'ADJUSTED', payload: { totalCents: newTotal }, resultado: { checkId, totalCents: newTotal, items: norm } };
    });
  }

  /**
   * Close a check (end of table). O `motivo` diz QUEM fechou: o razão da demo já
   * distinguia a renovação; o do dono gravava `{}` (compliance, PR #16).
   */
  async function closeCheck({ checkId }) {
    const resultado = { checkId, status: 'fechada' };
    let primeira = true;
    return lancarCondicional(store, checkId, async (state) => {
      // Já fechada NA RELEITURA (outra chamada ganhou a corrida): é o mesmo
      // resultado, sem segundo `CLOSED`. Na PRIMEIRA leitura, já fechada segue
      // sendo o 400 de sempre — fechar duas vezes à mão é erro do chamador.
      if (state.closed && !primeira) return { pronto: resultado };
      primeira = false;
      try { validateEvent({ type: 'CLOSED', payload: {} }, state); }
      catch (e) { throw badRequest(e.message); } // already closed → 400
      return { type: 'CLOSED', payload: { motivo: 'dono' }, resultado };
    });
  }

  return { openCheck, adjustCheck, closeCheck, normalizeItems };
}

module.exports = { createCheckService, normalizeItems };
