'use strict';

/**
 * QUAL ESTORNO FALHOU? — a decisão inteira, pura, num lugar só.
 *
 * O `refund.failed` da Stripe traz um TOTAL e (hoje) um `re_`. Ele não diz
 * quanto daquele total era consumo e quanto era serviço — quem sabe isso é o
 * RAZÃO, porque cada `PAYMENT_REFUNDED` gravou os baldes que ELE usou. Casar a
 * falha com o lançamento certo é o que decide três coisas caras:
 *
 *  · se a entrega é NOVA ou uma REENTREGA (a Stripe manda a mesma falha em dois
 *    eventos, `refund.failed` e `refund.updated` com status `failed`);
 *  · a repartição consumo/serviço da reversão, que sai ou não da base de
 *    cálculo da folha (Lei 13.419/2017, STJ Tema 1102);
 *  · se a TESTEMUNHA é verdadeira — e ela é o que autoriza a devolução por fora
 *    a passar por cima do rateio proporcional (`refund-allocation`, balde zero).
 *
 * Estava espalhada por sessenta linhas dentro do `applyConfirmedPayment`, com
 * três guardas em ordens diferentes, e as duas revisões obrigatórias da rodada
 * dez acharam SETE defeitos ali — quatro deles ALTOS, e todos da mesma família:
 * um ramo que decide sobre dinheiro e não alcança o caso pelo qual foi escrito.
 * O maior: a guarda de identidade (`re_`) foi movida pra cima justamente pra
 * cobrir a janela do deploy, e a janela do deploy é DEFINIDA pela reversão do
 * razão não ter `re_` — a guarda não podia disparar ali (segurança HIGH-1).
 *
 * Aqui é uma função pura sobre o razão. Dá pra enumerar.
 *
 * ── O MODELO ──────────────────────────────────────────────────────────────
 * Para um valor `v`:
 *   C(v) = lançamentos de estorno DESTE pagamento que somam `v` e que o
 *          adquirente poderia ter tentado pagar;
 *   R(v) = reversões já aplicadas neste pagamento que somam `v`.
 *
 * `R(v) > 0 && R(v) >= C(v)` → REENTREGA: todo candidato daquele valor já foi
 * revertido e não sobrou nenhum que pudesse ter falhado. O `R(v) > 0` não é
 * detalhe: sem ele, `0 >= 0` classificaria como reentrega uma falha de um valor
 * que o razão nem conhece — que é justamente o caso em que o adquirente sabe
 * algo que a gente não sabe.
 *
 * Senão é nova, e a TESTEMUNHA só é verdadeira quando não há ambiguidade
 * NENHUMA: nada daquele valor foi revertido antes (`R(v) === 0`) e todos os
 * candidatos daquele valor têm a MESMA repartição. Com uma reversão anterior no
 * meio não dá pra saber qual candidato ela consumiu — e chutar é o defeito que
 * a compliance mediu virando 409 eterno num caso e testemunha forjada no outro.
 */

/** Um lançamento de estorno é candidato? (Quem NÃO é, e por quê.) */
function candidatoDeEstorno(e) {
  if (!e || e.type !== 'PAYMENT_REFUNDED' || !e.payload) return false;
  // A devolução que o DONO registrou não é candidata: o adquirente nunca a viu,
  // e o rateio dela saiu do nosso próprio motor. Deixá-la no conjunto carimbava
  // a atestação do dono como testemunha do adquirente.
  if (e.payload.offRail === true) return false;
  // O CHARGEBACK também não. `dispute_lost` vira `PAYMENT_REFUNDED` (é dinheiro
  // saindo), mas um `refund.failed` descreve um objeto `Refund` da Stripe, e uma
  // disputa não é um — ela nunca pode ser "o estorno que falhou". Com a linha da
  // disputa no conjunto, um chargeback parcial do mesmo valor destruía a
  // testemunha de um estorno de verdade; e, sozinho, ele era "o único que casa",
  // então uma falha de estorno DESFAZIA no razão um chargeback que a rede
  // levou: a conta voltava de `parcial` pra `paga` sobre dinheiro que não está
  // mais na casa (segurança HIGH-3 da rodada dez).
  //
  // As duas exclusões são a MESMA regra — "só é candidato o que o adquirente
  // poderia estar reportando como estorno falho" — e por meses só uma estava
  // escrita.
  if (e.payload.disputeId) return false;
  return true;
}

/**
 * @param {Array} events   o razão inteiro da conta
 * @param {string} txid
 * @param {number} falhou  o TOTAL que o adquirente diz ter falhado
 * @param {string|null} refundId  o `re_` da entrega, quando existe
 */
function casarReversao(events, txid, falhou, refundId) {
  const mesmo = (a) => String(a) === String(txid);
  const anomalias = [];

  // 1. IDENTIDADE. Se este `re_` já foi revertido, é a segunda entrega da mesma
  //    falha — e nem `seenPspEvent` nem o índice único do append a separam,
  //    porque os dois eventos têm `evt_` diferentes.
  const jaRevertido = refundId && events.some((e) => e.type === 'PAYMENT_REFUND_REVERSED'
    && e.payload && e.payload.refundId === refundId);
  if (jaRevertido) return { decisao: 'reentrega', porque: 'refund_id', anomalias };

  const candidatos = events.filter((e) => candidatoDeEstorno(e) && mesmo(e.payload.txid))
    .map((e) => ({
      amountCents: Number(e.payload.amountCents) || 0,
      tipCents: Number(e.payload.tipCents) || 0,
    }));
  const revertidos = events.filter((e) => e.type === 'PAYMENT_REFUND_REVERSED'
    && e.payload && mesmo(e.payload.txid))
    .map((e) => ({
      total: (Number(e.payload.amountCents) || 0) + (Number(e.payload.tipCents) || 0),
      comId: !!e.payload.refundId,
    }));

  const doValor = candidatos.filter((l) => l.amountCents + l.tipCents === falhou);
  const revertidosDoValor = revertidos.filter((r) => r.total === falhou);

  // 2. REENTREGA POR CONTAGEM — a defesa que sobra sem identidade, e a única
  //    que alcança a JANELA DO DEPLOY: toda reversão já gravada nasceu sem
  //    `re_` (o adaptador descartava), então a guarda de identidade não pode
  //    disparar ali. Esta pode, e não depende de o estorno ainda estar vivo no
  //    razão — o que é o ponto: depois da primeira reversão ele não está.
  if (revertidosDoValor.length > 0 && revertidosDoValor.length >= doValor.length) {
    return { decisao: 'reentrega', porque: 'consumo', anomalias };
  }

  // 3. A AMBIGUIDADE, nomeada em vez de adivinhada. Já há reversão deste valor e
  //    ainda sobra candidato: "segunda entrega da mesma falha" e "o refazimento
  //    também falhou" produzem o mesmo par de números, e não dá pra decidir sem
  //    inventar. Aplica — o razão é de fatos relatados — e GRITA.
  if (revertidosDoValor.length > 0) {
    anomalias.push({
      chave: 'reversao_ambigua',
      severity: 'high',
      reason: `reversão de ${falhou} chegou sobre ${revertidosDoValor.length} reversão(ões) do mesmo valor `
        + `com ${doValor.length} estorno(s) candidato(s) — reentrega ou falha nova? confira o estorno no adquirente`,
    });
  }

  // 4. SEM IDENTIDADE, grita também. Só a Stripe emite este evento e o objeto
  //    `Refund` sempre traz `id`: este ramo não devia acontecer, e "não devia
  //    acontecer" é o que esta série aprendeu a não confiar.
  if (!refundId) {
    anomalias.push({
      chave: 'sem_refund_id',
      severity: 'high',
      reason: `reversão de estorno sem id do estorno (valor ${falhou}) — não dá pra separar reentrega de falha nova`,
    });
  }

  /**
   * 5. A TESTEMUNHA — verdadeira só quando o relato do adquirente nomeia UM
   *    lançamento e nenhum outro.
   *
   *    Duas condições, e as duas são estreitas de propósito. `R(v) === 0`: com
   *    uma reversão anterior no meio não dá pra saber qual candidato ela
   *    consumiu, e chutar é o defeito que a compliance mediu virando 409 eterno
   *    num caso e testemunha forjada no outro (HIGH-1 da rodada dez).
   *    `C(v) === 1`: dois candidatos do mesmo valor não nomeiam lançamento
   *    nenhum, mesmo quando a repartição dos dois é igual.
   *
   *    O caso "dois candidatos, mesma repartição" seria conhecível — o
   *    proporcional sobre o acumulado devolve exatamente os mesmos centavos —,
   *    e ainda assim fica de fora. Não custa dinheiro nenhum recusar a
   *    testemunha ali: a única coisa que a testemunha faz A MAIS é autorizar a
   *    devolução por fora a passar por cima do rateio e tirar da base de
   *    cálculo da folha (Lei 13.419/2017). Autoridade a mais sobre a folha é
   *    exatamente o que não se concede por inferência.
   */
  if (revertidosDoValor.length === 0 && doValor.length === 1) {
    return { decisao: 'aplicar', testemunhado: true, ...doValor[0], anomalias };
  }
  return { decisao: 'aplicar', testemunhado: false, anomalias };
}

module.exports = { casarReversao, candidatoDeEstorno };
