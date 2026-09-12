#!/usr/bin/env node
'use strict';

/**
 * PEDIDO DO TITULAR (LGPD art. 18 IV) — apagar o nome de UM pagamento, agora.
 *
 *   node scripts/erase-payment-label.js <txid>
 *
 * O prazo de 90 dias da retenção é o PADRÃO, não a resposta a quem pede. Quem
 * pede exclusão tem direito a ela na hora, e até este arquivo existir o caminho
 * era SQL ad-hoc contra produção com a service role: sem log, sem revisão, a
 * uma cláusula `WHERE` de distância de zerar `payer_label` da tabela inteira.
 *
 * Isto é o instrumento limitado. Toca uma linha, identificada por `txid`, e
 * imprime quantas mudaram — que é o que quem executou precisa pra registrar a
 * resposta que o art. 18 §4 exige. Não apaga o pagamento: o razão é
 * event-sourced e o valor é registro contábil (art. 16 II). Sai o nome.
 *
 * A caixa do pedido continua sendo o restaurante, que é o controlador. Ver
 * `docs/compliance/retencao.md`.
 */

// Mesma seleção que o router faz: sem `RACHA_STORE=supabase` isto roda contra
// memória e não apaga nada de verdade — daí a checagem explícita abaixo.
const useSupabase = process.env.RACHA_STORE === 'supabase';

async function main() {
  const txid = process.argv[2];
  if (!txid) {
    process.stderr.write('uso: node scripts/erase-payment-label.js <txid>\n');
    process.exit(2);
  }

  if (!useSupabase) {
    process.stderr.write('RACHA_STORE=supabase é obrigatório: sem ele isto roda em memória e não apaga nada\n');
    process.exit(2);
  }
  const store = require('../api/_lib/store/supabase').createSupabaseStore();

  const n = await store.erasePaymentLabel(txid);
  // O `txid` vai pro log de propósito: é o registro de que o pedido foi
  // executado, e o art. 18 §4 exige poder responder por ele.
  //
  // Mas ele NÃO é dado anônimo. A primeira versão deste comentário dizia "não é
  // dado pessoal — é o identificador da cobrança", que é literalmente a frase
  // que o `docs/compliance/retencao.md` foi corrigido pra recusar, no mesmo
  // commit: o `txid` resolve pro cadastro do pagador no painel do adquirente, e
  // reidentificação por meios razoáveis é o critério do art. 12 §1. É dado
  // pessoal PSEUDONIMIZADO. Trate esta linha como tal — ela não vai pra
  // planilha, nem pra chat, nem pra ticket aberto.
  process.stdout.write(`[art18] txid=${txid} linhas=${n} em ${new Date().toISOString()}\n`);
  if (n === 0) {
    process.stderr.write('nenhuma linha tocada: txid não encontrado, ou o nome já tinha saído\n');
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`falhou: ${e.message}\n`);
  process.exit(1);
});
