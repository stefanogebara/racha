'use strict';

/**
 * O QUE O PAINEL MOSTRA SOBRE A SOBRA — uma implementação, dois stores.
 *
 * Os dois stores montavam isto por conta própria, em duas cópias: a linha "qual
 * cobrança devolver, e quanto" embaixo da mesa, e o mapa que DESCONTA a dívida
 * do faturamento da série semanal (dinheiro pago a mais é dívida da casa, CC
 * art. 876, não receita).
 *
 * Enquanto eram duas cópias, o censo só conseguia prender uma: a revisão de
 * segurança plantou, no store de PRODUÇÃO, um segundo laço que sobrescrevia o
 * mapa com a derivação errada, e a suíte inteira ficou verde — o painel mandaria
 * o dono devolver ao pagador errado (segurança MEDIUM-2 de 11a0904). Com uma
 * implementação só, o teste do módulo vale pros dois.
 */

const { sobraPorPagamento } = require('./check-state');

/** A lista que o painel desenha embaixo da mesa: qual cobrança, e quanto. */
function linhasDeSobra(state) {
  return [...sobraPorPagamento(state).entries()]
    .map(([txid, restituteCents]) => ({ txid, restituteCents }))
    .filter((x) => x.restituteCents > 0);
}

/** O mapa que desconta a dívida do faturamento (ver `ativacao.js`). */
function acumularSobra(state, destino) {
  for (const [txid, centavos] of sobraPorPagamento(state)) {
    if (centavos > 0) destino.set(txid, centavos);
  }
  return destino;
}

module.exports = { linhasDeSobra, acumularSobra };
