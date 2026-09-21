'use strict';

/**
 * UM SANITIZADOR, PORQUE DOIS VIRAM DOIS COMPORTAMENTOS.
 *
 * O rastro de um caminho de dinheiro é linha a linha: um `\r` ou `\n` no meio
 * de um valor que veio de fora inventa uma linha inteira que ninguém escreveu.
 * A regra já existia em `router.js` (`sanitizeForLog`) e, quando ela fez falta
 * no adaptador da Pagar.me, foi reescrita inline — duas vezes, com forma
 * diferente da original. Duas regras pro mesmo trabalho é como a próxima cópia
 * diverge; a re-revisão de segurança apontou os quatro sítios que ficaram de
 * fora e o fato de o ajudante já existir.
 *
 * Duas funções porque são dois trabalhos:
 *
 *  · `soUmaLinha` é pra TEXTO que a gente quer ler inteiro (a frase do
 *    adquirente explicando a recusa): preserva o conteúdo e só garante que ele
 *    não quebra a linha.
 *  · `soIdentificador` é pra IDENTIFICADOR que a gente só confere (txid, id de
 *    cobrança, nome de evento): joga fora tudo que não é caractere de id,
 *    então nem escape nem tamanho passam.
 */

/** Texto de terceiro que vai INTEIRO pro rastro, numa linha só. */
function soUmaLinha(v, max = 160) {
  return String(v).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, max);
}

/** Identificador de terceiro: só o que cabe num id, e curto. */
function soIdentificador(v, max = 60) {
  return String(v).replace(/[^\w.:-]/g, '·').slice(0, max);
}

module.exports = { soUmaLinha, soIdentificador };
