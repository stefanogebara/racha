'use strict';

/**
 * Como um erro sai pela rede.
 *
 * Existe como módulo próprio — e não como um objeto literal dentro do `catch`
 * do router — porque ali ele não era testável e estava errado: devolvia só
 * `err.message`, e perdia o `code` e os `vars`.
 *
 * O que isso causava: todo erro levantado no caminho do dinheiro
 * (`tip_not_supported`, `market_not_live`, `psp_market_mismatch`,
 * `amount_over_max` com o limite em centavos) chegava ao cliente como uma
 * FRASE EM PORTUGUÊS e sem código. O `tError` do cliente, não encontrando
 * código, cai no texto cru — então um espanhol lia português na hora de pagar.
 * É exatamente o que o CLAUDE.md proíbe: o servidor manda um `code` estável
 * mais centavos crus, e quem traduz e formata é o cliente, que sabe o idioma.
 *
 * A regra do 500: 4xx é erro de contrato e a mensagem ajuda quem chamou. 500
 * não mapeado costuma vir do PostgREST/Postgres, e ecoar isso é vazar interno
 * — loga inteiro, devolve um código estável e nada mais.
 */

/** O status HTTP de um erro levantado no meio do caminho. */
function errorStatus(err) {
  if (err && err.statusCode) return err.statusCode;
  if (err && err.name === 'WebhookVerificationError') return 401;
  return 500;
}

/**
 * O corpo JSON de um erro. Nunca inclui texto de tela nem detalhe interno.
 *
 * @param {Error & {code?: string, vars?: object}} err
 * @param {number} status
 */
function errorBody(err, status = errorStatus(err)) {
  if (status >= 500) {
    return { success: false, error: 'erro interno', code: 'internal' };
  }
  return {
    success: false,
    error: (err && err.message) || 'erro',
    ...(err && err.code ? { code: err.code } : {}),
    ...(err && err.vars ? { vars: err.vars } : {}),
  };
}

module.exports = { errorStatus, errorBody };
