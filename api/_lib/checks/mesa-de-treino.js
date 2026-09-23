'use strict';

/**
 * MESA DE TREINO NÃO COBRA — decisão pura.
 *
 * A mesa de treino existia pra "a equipe praticar sem sujar os números", e o
 * roteiro do workshop mandava cada garçom pagar "uma conta de mentira no
 * próprio celular" nela. Só que nenhum caminho de pagamento olhava a marca:
 * em produção, a conta de mentira era um Pix de verdade, liquidado no CNPJ da
 * casa — e o painel TIRAVA esse dinheiro dos números, o serviço inclusive, que
 * é a base da folha (Lei 13.419/2017). Dinheiro real que o dono não via.
 * Achado pela auditoria do painel de 2026-09-23 (P1), confirmado no código.
 *
 * E a marca muda com UM toque, sem confirmação: uma mesa de verdade marcada
 * por engano passava a esconder do painel o histórico dela.
 *
 * Duas saídas eram possíveis. Dinheiro de mentira na mesa de treino (o MockPsp
 * da demo) fecharia sem pagamento real a conta de uma mesa de verdade marcada
 * por engano — o cliente sai achando que pagou. Recusar cobrar é o que falha
 * seguro: a mesa marcada por engano recusa, a tela manda pagar no caixa, e
 * nenhum centavo real some. Então: mesa de treino NUNCA cobra, e o painel
 * NUNCA tira dinheiro dos números por causa da marca.
 */

/** O código estável que o cliente traduz. O servidor não manda frase. */
const CODIGO_MESA_DE_TREINO = 'table_training';

/** A conta lida por QR é de uma mesa de treino? Sem a informação, não é. */
function eMesaDeTreino(view) {
  return Boolean(view && view.table && view.table.training === true);
}

module.exports = { CODIGO_MESA_DE_TREINO, eMesaDeTreino };
