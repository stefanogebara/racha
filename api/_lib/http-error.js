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
/**
 * OS CÓDIGOS QUE ATRAVESSAM UM 5xx — por nome, e com o motivo.
 *
 * A regra de cima existe por uma razão boa: num 5xx a mensagem é NOSSA e
 * costuma nomear internos (o adquirente da casa, a env que falta, o erro cru do
 * Postgres), então ela não viaja. Só que ela engolia o CÓDIGO junto, e há
 * desfechos de 5xx em que o código é a única coisa que diz ao cliente o que
 * fazer — e em que "tente de novo" é a resposta ERRADA.
 *
 * Foi o que aconteceu com o `charge_maybe_captured`: um 502 com código próprio,
 * escrito pra desarmar o botão do Google Pay sobre um cartão que pode já ter
 * sido cobrado, chegava ao cliente como `internal` → "algo deu errado, tente de
 * novo" → botão armado. O conserto inteiro era código morto, e o teste não viu
 * porque afirmava o erro LANÇADO e nunca a resposta da rota. Achado pela quarta
 * revisão de compliance de 2026-09-16 (CRITICAL-1).
 *
 * O repositório já tinha o sintoma: o `platform_misconfigured` é emitido com
 * `json(res, 503, …)` à mão em dois lugares, contornando esta função —
 * justamente porque ela o comeria. Uma lista de permissão nomeada é o que
 * generaliza esse contorno em vez de multiplicá-lo.
 *
 * O que entra aqui: código NOSSO, sem detalhe interno, cuja ausência muda o que
 * o cliente faz. Não a mensagem — a mensagem continua sem viajar.
 */
const CODIGOS_QUE_ATRAVESSAM_5XX = new Set([
  // O cartão pode já ter sido capturado: a tela desarma o botão e diz pra não
  // pagar de novo. Sem o código, ela convida à segunda cobrança (CDC art. 42).
  'charge_maybe_captured',
  // A cobrança NÃO chegou a ser criada: nada saiu, e aqui "tente de novo" é a
  // resposta certa — o oposto do de cima, e é por isso que são dois códigos.
  'charge_not_started',
  // O adquirente não respondeu, e NADA saiu de conta nenhuma — dizer isso é
  // melhor que "algo deu errado", que num caminho de dinheiro é convite a
  // tentar de novo sem saber o que aconteceu. Quem tinha captura em voo não
  // chega aqui: aquele caminho troca por `charge_maybe_captured` antes.
  'psp_unavailable',
  // Configuração nossa, não do adquirente. Está aqui porque ele é lançado com
  // 400 num sítio e 503 noutros dois — e no dia em que alguém uniformizar pra
  // 503 "por consistência", sem esta linha ele viraria `internal` em silêncio.
  'platform_misconfigured',
  // O login não respondeu. Sem o código o cliente trata como 401 e desloga o
  // dono no meio do turno.
  'auth_unavailable',
  // O lançamento da carteira não teve débito que o pagasse (0043, RH009) E o
  // estorno falhou — o saldo pode ter baixado sem pagamento. Sem o código, o
  // cliente lê "tente de novo" e não sabe que precisa falar com o balcão
  // (segurança, PR #42, LOW-1).
  'house_debit_missing',
]);

function errorBody(err, status = errorStatus(err)) {
  if (status >= 500) {
    if (err && CODIGOS_QUE_ATRAVESSAM_5XX.has(err.code)) {
      return { success: false, error: 'erro interno', code: err.code };
    }
    return { success: false, error: 'erro interno', code: 'internal' };
  }
  // Com CÓDIGO, a mensagem interna NÃO viaja.
  //
  // O cliente já prefere o código (`tError`), então a frase era só reserva — e
  // essa reserva ia pra qualquer diner sem autenticação, nomeando internos:
  // "psp pagarme não emite em eur" identifica o adquirente daquela casa;
  // "market es: market_not_live" conta que a Espanha existe e não está no ar;
  // "venue has no settlement recipient configured" descreve o cadastro. Numa
  // verificação de webhook a frase carrega o erro da própria Stripe, o que
  // vira um oráculo de assinatura ("no signatures found" contra "timestamp
  // outside tolerance"). Achado pela revisão de segurança de 2026-09-07.
  //
  // Sem código a frase continua indo: são erros de contrato de quem integra
  // ("checkId required"), e sem ela o chamador fica sem nada. A saída é
  // acrescentar código a esses erros, não devolver mudez.
  if (err && err.code) {
    return {
      success: false,
      code: err.code,
      ...(err.vars ? { vars: err.vars } : {}),
    };
  }
  return { success: false, error: (err && err.message) || 'erro' };
}

module.exports = { errorStatus, errorBody, CODIGOS_QUE_ATRAVESSAM_5XX };
