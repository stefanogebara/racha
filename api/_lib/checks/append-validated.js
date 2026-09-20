'use strict';

/**
 * Anexar um evento ao razão COM validação.
 *
 * O `applyConfirmedPayment` sempre validou antes de gravar. Os appends diretos
 * da rota — a abertura de disputa, o fecho, e agora a resolução de pendência —
 * chamavam `store.appendEvent` cru, então um evento inválido virava anomalia do
 * redutor em vez de recusa limpa. Achado pela revisão de segurança de
 * 2026-09-08 (o mesmo ponto que pedia pra colapsar rota e portão).
 *
 * Isto não é uma segunda implementação da validação: é a MESMA
 * `validateEvent`, num lugar que quem grava direto pode chamar. O store
 * continua burro de propósito — no Supabase o append é um RPC, e validar em
 * SQL seria a terceira cópia das regras.
 */

const { reduce, validateEvent, EventValidationError } = require('./check-state');

/**
 * @param {number} [expectedSeq] quando vem, o lançamento é CONDICIONAL: só entra
 *   se o último `seq` da conta ainda for este (migração 0034). É como uma
 *   decisão de AUTORIZAÇÃO tirada de uma leitura vira uma escrita segura — a
 *   leitura que autorizou e a gravação passam a ser o mesmo passo.
 */
async function appendValidated(store, checkId, type, payload, pspEventId = null, expectedSeq) {
  const state = reduce(await store.loadEvents(checkId));
  try {
    validateEvent({ type, payload }, state);
  } catch (err) {
    if (err instanceof EventValidationError) {
      const e = new Error(err.message);
      e.statusCode = 400;
      e.code = 'event_invalid';
      throw e;
    }
    throw err;
  }
  if (expectedSeq === undefined) return store.appendEvent(checkId, type, payload, pspEventId);
  return store.appendEventIfUnchanged(checkId, type, payload, pspEventId, expectedSeq);
}

module.exports = { appendValidated };
