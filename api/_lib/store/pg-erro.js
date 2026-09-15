'use strict';

/**
 * O NOME DA RESTRIÇÃO VIOLADA, extraído da mensagem do Postgres.
 *
 * Mora aqui, e não dentro do store do Supabase, porque o DUBLÊ também precisa
 * passar por ele. Enquanto a produção extraía por regex e o dublê recebia o nome
 * de bandeja, o ramo de FALHA da extração não existia em teste nenhum: um
 * `lc_messages` não-inglês, ou uma versão do PostgREST que remonte a mensagem, e
 * a reentrega da mesma devolução fora do trilho passaria a ser classificada como
 * "recusada" — o operador leria que o razão não recebeu nada sobre uma
 * devolução que ESTÁ lá, e pagaria o cliente uma segunda vez (segurança LOW-3 de
 * 41b188a).
 *
 * `null` quando não dá pra saber, e quem lê trata isso como "não é a minha
 * restrição" — que é o lado seguro: vira recusa, não sucesso.
 */
function nomeDaRestricao(texto) {
  if (typeof texto !== 'string' || !texto) return null;
  const achado = texto.match(/unique constraint "([a-zA-Z0-9_]+)"/);
  return achado ? achado[1] : null;
}

/** A mensagem que o Postgres escreve, pro dublê falar a mesma língua. */
function mensagemDeUnicidade(restricao) {
  return `duplicate key value violates unique constraint "${restricao}"`;
}

module.exports = { nomeDaRestricao, mensagemDeUnicidade };
