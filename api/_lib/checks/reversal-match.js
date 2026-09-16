'use strict';

const { estornoDoTrilho } = require('./check-state');

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
 * ── O QUE ISTO NÃO RESOLVE, e é melhor estar escrito ──────────────────────
 * Com DOIS OU MAIS candidatos do mesmo valor e nenhuma identidade, a mesma
 * falha entregue duas vezes é indistinguível de duas falhas: `R(v)` não alcança
 * `C(v)`, as duas entram, e o teto da devolução por fora (`reversedOpenCents`)
 * fica maior do que o que o adquirente deixou de entregar. A revisão de
 * segurança mediu: dois estornos de R$ 11,00, duas entregas cegas, teto de
 * R$ 22,00.
 *
 * Não dá pra fechar sem escolher um lado errado. Exigir testemunha pro teto
 * bloquearia a devolução por fora em todo caso ambíguo — que é o caso comum — e
 * deixaria sem remédio um cliente a quem a casa DEVE. O que resta é gritar, e é
 * o que acontece: `sem_refund_id` em cada entrega (chave por entrega, não por
 * valor) mais `reversao_ambigua`. E a janela fecha sozinha: depois deste deploy
 * toda reversão nasce com `re_`, e aí a guarda 1 resolve por identidade.
 *
 * Senão é nova, e a TESTEMUNHA só é verdadeira quando não há ambiguidade
 * NENHUMA: nada daquele valor foi revertido antes (`R(v) === 0`) e todos os
 * candidatos daquele valor têm a MESMA repartição. Com uma reversão anterior no
 * meio não dá pra saber qual candidato ela consumiu — e chutar é o defeito que
 * a compliance mediu virando 409 eterno num caso e testemunha forjada no outro.
 */

/**
 * Um lançamento de estorno é candidato? É a MESMA pergunta que o redutor faz
 * pra decidir o que entra no acumulado do trilho, então é a MESMA função.
 *
 * A devolução que o DONO registrou (`offRail`) e o CHARGEBACK (`dispute_lost`)
 * viram `PAYMENT_REFUNDED` porque são dinheiro saindo, mas nenhum dos dois é um
 * objeto `Refund` da Stripe — nenhum dos dois pode ser "o estorno que falhou".
 * Com o chargeback no conjunto, uma falha de estorno DESFAZIA no razão um
 * chargeback que a rede levou.
 *
 * Esta função foi uma cópia local por uma rodada, e a cópia divergiu da régua do
 * acumulado em dois predicados diferentes — dois achados ALTOS, um por rodada.
 * Agora ela é o `estornoDoTrilho` do redutor, reexportado com o nome que este
 * arquivo usa.
 */
const candidatoDeEstorno = estornoDoTrilho;

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
  // As reversões daquele valor que NÃO TÊM IDENTIDADE — as únicas que poderiam
  // ser esta mesma falha de novo.
  const cegasDoValor = revertidosDoValor.filter((r) => !r.comId);

  /**
   * 2. REENTREGA POR CONTAGEM — a defesa que sobra sem identidade, e a única
   *    que alcança a JANELA DO DEPLOY: toda reversão já gravada nasceu sem
   *    `re_` (o adaptador descartava), então a guarda de identidade não pode
   *    disparar ali. Esta pode, e não depende de o estorno ainda estar vivo no
   *    razão — o que é o ponto: depois da primeira reversão ele não está.
   *
   *    DUAS CONDIÇÕES, e a primeira separa "pode ser esta mesma" de "é outra,
   *    provadamente". Se TODAS as reversões daquele valor têm `re_` — e nenhum
   *    deles é o nosso, senão a guarda 1 já teria disparado —, então esta é uma
   *    falha diferente, dita pela identidade. Engoli-la como reentrega deixa o
   *    cliente sem o dinheiro e o razão dizendo que ele foi reembolsado, que é o
   *    desfecho que este repositório chama de o pior possível (CDC art. 6º III e
   *    art. 42; compliance HIGH-2 da rodada onze).
   *
   *    O `comId` já era calculado aqui e nunca era lido: o sinal estava na mão.
   */
  if (cegasDoValor.length > 0 && revertidosDoValor.length >= doValor.length) {
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
