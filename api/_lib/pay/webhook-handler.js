'use strict';

/**
 * PSP webhook → check event, pure orchestration with injected I/O.
 *
 * The store is injected ({ loadEvents, appendEvent, recordPayment }) so the
 * money path is fully unit-testable and the same code runs against the memory
 * store (demo) and Supabase (prod, where appendEvent calls the
 * append_check_event RPC — serialized per check by advisory lock).
 *
 * Idempotency contract (at-least-once webhooks):
 * - same txid, same amounts   → clean no-op, do NOT append (log stays lean)
 * - same txid, DIFFERENT money → APPEND anyway: the reducer records a
 *   'divergent_txid' anomaly, reconciliation alerts. Divergence must leave a
 *   trace (review finding) — dropping it silently is how tampering hides.
 * - refunds validate against current state (never exceed the original
 *   payment) at append time; the reducer stays total as defense-in-depth.
 *
 * `applyConfirmedPayment` is the SHARED confirmation core: it takes an already
 * verified/parsed charge and folds it into the ledger. Both the webhook
 * handler (verify → apply) and the active reconciler (re-fetch → apply) call
 * it, so a payment confirmed by a POLL is byte-identical to one confirmed by a
 * webhook — same idempotency, same event-sourcing, one code path for money.
 */

const { reduce, validateEvent, EventValidationError } = require('../checks/check-state');
const { maskPixPayload } = require('./mask');
const { allocateRefund } = require('../checks/split-engine');
const { alocarDevolucaoDoPagamento } = require('../checks/refund-allocation');
const { casarReversao } = require('../checks/reversal-match');

/**
 * Fold a verified+parsed PSP charge into the check ledger. Pure orchestration
 * over injected I/O; safe to call more than once for the same txid — the
 * reducer is idempotent by txid, so a retried webhook OR a webhook-vs-reconcile
 * race can never double-count money (paidCents/tipCents). The "already seen"
 * check reads state BEFORE the per-check append lock, so an exact-simultaneous
 * race could append a second identical PAYMENT_CONFIRMED row: harmless to money
 * (reduce() collapses it) and to the drift canary, just a duplicate log row.
 *
 * @param {{kind:string, txid:string, amountCents:number, tipCents:number, method?:string, raw?:any}} parsed
 * @param {object} deps
 * @param {(checkId:string)=>Promise<Array>} deps.loadEvents
 * @param {(checkId:string, type:string, payload:object)=>Promise<number>} deps.appendEvent
 * @param {(payment:object)=>Promise<void>} [deps.recordPayment]
 * @param {(txid:string)=>Promise<{id:string}|null>} deps.findCheckByTxid
 * @param {(parsed:object)=>Promise<object|null>} [deps.fallback]
 * @returns {Promise<{status:'appended'|'duplicate'|'divergent_appended'|'rejected', checkId?:string, seq?:number, reason?:string}>}
 */
/**
 * O rateio de uma devolução. A regra inteira — e o porquê de cada balde — mora
 * em `checks/refund-allocation.js`, compartilhada com a devolução que o dono
 * registra fora do trilho. Eram duas cópias da mesma conta, e uma delas não
 * conhecia o serviço devido do pago-depois-de-fechar.
 */
function alocarDevolucao(state, txid, pay, delta, opcoes) {
  // A regra mora em `refund-allocation.js` — a mesma que a devolução fora do
  // trilho usa. O `state` deixou de ser ignorado: é dele que sai o serviço
  // DEVIDO de um pagamento atrasado (balde 2).
  return alocarDevolucaoDoPagamento(state, txid, pay, delta, opcoes);
}


async function applyConfirmedPayment(parsed, deps) {
  const {
    loadEvents, appendEvent, recordPayment, findCheckByTxid, fallback, seenPspEvent,
  } = deps;
  const check = await findCheckByTxid(parsed.txid);
  if (!check) {
    // Not a check charge — maybe another charge family (house-account loads).
    // The fallback owns its own idempotency/validation.
    if (fallback) {
      const alt = await fallback(parsed);
      if (alt) return alt;
    }
    // A webhook for a txid we never issued: reject loudly. Never 200 an
    // unknown money event — that is how funds disappear from ledgers.
    return { status: 'rejected', reason: `unknown txid ${parsed.txid}` };
  }

  /**
   * Reentrega ANTES de qualquer conferência de estado.
   *
   * Sem isto, a segunda entrega do mesmo evento batia nas guardas de estado e
   * saía como `rejected` → 409 → a Stripe reenvia e acaba desabilitando o
   * endpoint. Uma reversão de estorno, por exemplo: depois da primeira o
   * estornado é zero, e a segunda caía em "reverter o que não existe".
   *
   * A GARANTIA continua sendo o índice único no append (migração 0018), que é
   * o único que fecha a corrida entre entregas simultâneas porque roda dentro
   * do lock. Esta consulta existe pra a RESPOSTA ficar honesta.
   */
  if (parsed.eventId && typeof seenPspEvent === 'function' && await seenPspEvent(parsed.eventId)) {
    await repairRowFromLedger(check.id, parsed.txid, deps);
    return { status: 'duplicate', checkId: check.id };
  }

  const events = await loadEvents(check.id);
  const state = reduce(events);

  // MAPA, não ternário.
  //
  // Era `parsed.kind === 'refund' ? 'PAYMENT_REFUNDED' : 'PAYMENT_CONFIRMED'`,
  // e esse `else` era a raiz do achado mais perigoso das revisões: qualquer
  // espécie que chegasse aqui e não fosse `refund` virava PAGAMENTO. Um
  // chargeback viraria dinheiro recebido. O portão agora filtra por conjunto
  // fechado, e aqui a tradução é explícita — as duas defesas, não uma.
  const type = EVENT_FOR_KIND[parsed.kind];
  if (!type) throw new Error(`applyConfirmedPayment: kind sem evento ${JSON.stringify(parsed.kind)}`);

  /**
   * Estorno ACUMULADO → delta, e o rateio entre consumo e gorjeta.
   *
   * O PSP conta o total já devolvido naquela cobrança (`amount_refunded` da
   * Stripe é acumulado); o razão registra DELTAS, porque o redutor soma. Os
   * dois só se encontram aqui, onde se sabe quanto já foi estornado.
   *
   * O que isso conserta: o segundo estorno parcial reapresentava o acumulado
   * como se fosse novo, o `validateEvent` recusava, a rota devolvia 409, a
   * Stripe reenviava e depois desabilitava o endpoint. E de graça fica
   * idempotente: reenvio traz o mesmo acumulado, delta zero, nada acontece.
   *
   * O rateio é PROPORCIONAL (`allocateRefund`), e mora no motor de centavos
   * junto do resto da matemática de dinheiro. Era `Math.min(tipCents,
   * refunded)` no adaptador, que raspava a gorjeta inteira antes de tocar o
   * consumo — decisão sobre a folha de alguém (Lei 13.419) tomada por ordem de
   * subtração.
   */
  /**
   * Reversão: desfaz o que ESTE estorno tirou.
   *
   * O texto aqui já disse duas coisas falsas, e as duas autorizavam algo.
   * Primeiro, que ida e volta "não podem divergir, pelo mesmo `allocateRefund`"
   * — deixou de valer quando a ida ganhou três baldes (compliance MEDIUM-3 de
   * d7f2683). Depois, que "o adquirente não manda" qual lançamento falhou — e
   * manda: o `data.object` do `refund.failed` É o objeto Refund, e o adaptador
   * já lia `status`, `amount` e `payment_intent` dele, jogando fora só o `id`
   * (compliance MEDIUM-4 de 11a0904).
   *
   * Hoje: o `re_` identifica o estorno e fecha a reentrega; o rateio sai do
   * LANÇAMENTO que falhou quando o valor casa com um só, e do proporcional
   * quando não casa — e nesse caso o razão grava `testemunhado: false`, porque
   * palpite nosso não pode mandar no rateio que tira da base da folha.
   */
  let reversalAllocated = null;
  if (type === 'PAYMENT_REFUND_REVERSED') {
    const pay = state && state.payments[parsed.txid];
    if (!pay) return { status: 'rejected', reason: `reversal for unknown txid ${parsed.txid}` };
    /**
     * O TETO DA REVERSÃO conta só o que o ADQUIRENTE estornou.
     *
     * `falhou` é o `Refund.amount` da Stripe — a mesma régua do
     * `charge.amount_refunded`, que nunca conta disputa. Comparar com o nosso
     * acumulado TOTAL, com o chargeback dentro, é a mesma "duas réguas
     * diferentes" que o ramo do estorno cumulativo já corrige cem linhas abaixo
     * — e aqui ela fazia coisa pior do que errar a conta: o saldo da disputa
     * MASCARAVA o `jaEstornado === 0`, então uma reversão de um estorno que o
     * razão nunca viu não caía em `out_of_order`, era aplicada contra o
     * chargeback, devolvia pra conta dinheiro que a rede levou e subia a
     * gorjeta junto — na base de cálculo da folha (Lei 13.419/2017). Sem uma
     * anomalia sequer (compliance HIGH-1 da rodada onze).
     */
    const estornadoAmount = pay.refundedPeloTrilhoAmountCents || 0;
    const estornadoTip = pay.refundedPeloTrilhoTipCents || 0;
    const jaEstornado = estornadoAmount + estornadoTip;
    const falhou = Number.isSafeInteger(parsed.amountCents) ? parsed.amountCents : jaEstornado;

    /**
     * QUEM DECIDE É O `casarReversao`, e ele é puro.
     *
     * Esta decisão morava aqui, em três guardas com ordens diferentes, e as duas
     * revisões da rodada dez acharam sete defeitos nela. O pior era de ORDEM: a
     * guarda de identidade tinha sido movida pra cima pra cobrir a janela do
     * deploy, e a janela do deploy é definida pela reversão do razão não ter
     * `re_` — ela não podia disparar ali. A segunda entrega caía em
     * `jaEstornado === 0` e saía por `out_of_order`, gravando no razão, para
     * sempre, que "a reversão chegou antes do estorno". Chegou depois, e já
     * estava aplicada (segurança HIGH-1 da rodada dez).
     *
     * A decisão por CONTAGEM não depende de o estorno ainda estar vivo no razão,
     * então ela alcança a janela — e vem antes de tudo.
     */
    const casamento = casarReversao(events, parsed.txid, falhou, parsed.refundId || null);

    // A ANOMALIA leva a chave da ENTREGA, com sufixo.
    //
    // A rodada nove chaveou por `txid:motivo:valor`, o que deduplica a
    // reentrega — e também deduplica PARA SEMPRE: uma segunda falha cega, de
    // verdade, do mesmo valor no mesmo pagamento passava calada (segurança
    // MEDIUM-1, compliance LOW-1). Agora a reentrega é barrada acima, por
    // identidade ou por contagem, então cada entrega que CHEGA aqui é um
    // acontecimento distinto e merece o próprio registro.
    //
    // O sufixo não é enfeite: com `parsed.eventId` puro a anomalia queimava a
    // chave de idempotência do próprio evento (`psp_event_id` é único no banco
    // inteiro, migração 0018) e a reentrega saía como `duplicate` sem nunca
    // aplicar a reversão.
    const gritar = async (chave, severity, reason) => {
      try {
        await appendEvent(check.id, 'PAYMENT_ANOMALY', { txid: parsed.txid, reason, severity },
          parsed.eventId ? `${parsed.eventId}:${chave}` : `${parsed.txid}:${chave}:${falhou}`);
      } catch (e) {
        // FALA. Um `catch` mudo foi o que transformou um `ReferenceError` numa
        // guarda morta por um commit inteiro (segurança HIGH-1 de 53c9ff0).
        process.stderr.write(`[webhook] anomalia ${chave} não gravada: ${String(e && e.message).slice(0, 160)}\n`);
      }
    };

    if (casamento.decisao === 'reentrega') {
      await repairRowFromLedger(check.id, parsed.txid, deps);
      return { status: 'duplicate', checkId: check.id };
    }

    if (jaEstornado === 0) {
      /**
       * O estorno ainda não entrou no razão. Reverter o que não existe não é
       * desfazer, é inventar (inegociável #6) — mas RECUSAR também está errado:
       * a Stripe não garante ordem, 409 vira reenvio, e reenvio esgotado vira
       * endpoint desabilitado. Então registra a ANOMALIA e devolve 200.
       *
       * `high`, e não `info`. O texto aqui dizia que o caso "converge sozinho
       * quando a reentrega aplica a reversão" — não há reentrega: esta saída
       * devolve 200, e a Stripe só reentrega em resposta de falha. O irmão
       * (`refund.updated` com status `failed`) é emitido no MESMO instante,
       * então numa ordem trocada os dois caem aqui e os dois somem: dinheiro do
       * cliente sem dono no razão, com a conciliação comparando duas projeções
       * que contam a mesma mentira (compliance HIGH-2 de 53c9ff0).
       *
       * E RECONCILIA a linha antes de sair. Este era o único caminho em forma de
       * `duplicate` sem reparo: uma linha que ficou velha entre duas entregas em
       * voo ficava velha pra sempre, dizendo "devolvido" sobre dinheiro que está
       * na casa (segurança HIGH-1 da rodada dez, item 2).
       */
      await gritar('out_of_order', 'high',
        `reversão de estorno chegou antes do estorno (valor ${parsed.amountCents ?? '?'})`);
      await repairRowFromLedger(check.id, parsed.txid, deps);
      return { status: 'out_of_order', checkId: check.id, reason: `reversal before refund for txid ${parsed.txid}` };
    }

    // Valor NEGATIVO ou zero é recusa, não exceção.
    //
    // O `allocateRefund` estoura em `refundCents` negativo — de propósito, é o
    // motor de dinheiro. Mas um `amountCents` negativo num webhook chegaria
    // aqui e viraria 500 `internal`, que a Stripe reenvia até desabilitar o
    // endpoint. Um valor impossível merece 409 com motivo, não uma exceção
    // não tratada no caminho do dinheiro.
    const aReverter = Math.min(falhou, jaEstornado);
    if (!Number.isSafeInteger(aReverter) || aReverter <= 0) {
      return { status: 'rejected', reason: `reversal amount inválido (${parsed.amountCents}) para ${parsed.txid}` };
    }

    for (const a of casamento.anomalias) await gritar(a.chave, a.severity, a.reason);

    /**
     * O `Math.min` ESCONDIA uma divergência entre o adquirente e o razão.
     *
     * `falhou` é o `Refund.amount` da Stripe; `jaEstornado` é o que o NOSSO
     * razão sabe. Quando o adquirente relata uma falha maior do que o estorno
     * que a gente registrou, a diferença sumia sem anomalia, sem log, sem nada —
     * e o número JÁ CORTADO ia casar por valor, podendo casar exatamente com um
     * estorno que deu CERTO. O razão então revertia o estorno certo, com
     * testemunha, e abria teto de devolução por fora sobre dinheiro que o
     * cliente já tinha recebido: pagamento em dobro (CC art. 884, CDC art. 42) e
     * base da folha movida sobre uma ficção (compliance HIGH-2 da rodada dez).
     *
     * Um valor cortado é, por construção, uma coisa que o adquirente NÃO disse.
     * Então não pode sustentar testemunha nenhuma.
     *
     * A ZERAGEM ABAIXO É CINTO SOBRE SUSPENSÓRIO — e o suspensório é o
     * `casaOValor` logo adiante, não o que eu escrevi aqui antes.
     *
     * A versão anterior deste parágrafo dizia que a zeragem era redundante por
     * causa de uma invariante: "se existe um candidato vivo somando `falhou`,
     * então `jaEstornado >= falhou`". As duas revisões da rodada onze mostraram
     * que ela é FALSA, com um contraexemplo que este próprio arquivo produz — a
     * reversão é gravada pelo valor CORTADO e rateada proporcionalmente, então
     * ela não soma o total de candidato nenhum, e um corte com testemunha é
     * perfeitamente alcançável.
     *
     * O que realmente segura é a aritmética do `casaOValor`: a repartição que o
     * casador devolve quando testemunha soma EXATAMENTE `falhou` (é a de um
     * candidato daquele valor), e `casaOValor` a compara com `aReverter`. Num
     * corte os dois são diferentes por definição, então o proporcional entra.
     * Essa invariante é sobre o casador sozinho, é verdadeira, e está provada
     * por propriedade em `reversal-match.test.js` — com um gerador que ALCANÇA
     * o corte com testemunha, que é o que a prova anterior não fazia.
     *
     * Um parágrafo que chama de redundante a guarda errada é um convite escrito
     * pra alguém remover a que está segurando o dinheiro.
     */
    let testemunhado = casamento.testemunhado === true;
    if (aReverter !== falhou) {
      await gritar('reversao_maior_que_o_razao', 'high',
        `adquirente relata falha de ${falhou} e o razão só conhece ${jaEstornado} estornado — `
        + `revertendo ${aReverter} e conferindo o estorno no adquirente`);
      testemunhado = false;
    }

    /**
     * A repartição, e QUEM a afirma.
     *
     * Com testemunha: os baldes são os do lançamento que o adquirente nomeou —
     * o razão sabe quanto daquele estorno era consumo e quanto era serviço.
     * Sem: volta o proporcional, e o razão grava `testemunhado: false`, porque
     * palpite nosso não pode mandar no rateio que tira da base da folha.
     */
    /**
     * A TESTEMUNHA TEM QUE CABER NOS BALDES VIVOS, não só somar o valor certo.
     *
     * O casador olha o razão INTEIRO: a repartição que ele devolve é a de um
     * lançamento HISTÓRICO, e os baldes vivos do trilho já podem ter sido
     * drenados por reversões anteriores de OUTRO valor — que a guarda da
     * testemunha não enxerga, porque ela filtra por valor.
     *
     * Medido: estorno A de {0,1000} e B de {1800,200}; uma falha de 1500 (que
     * não casa com nenhum) entra proporcional e deixa o trilho em {900,600};
     * depois a falha de 1000, que É o A, ganha testemunha {0,1000} — e o
     * `validateEvent` recusa, porque 1000 de gorjeta não cabe em 600. A rota
     * devolvia 409 SEM UMA ANOMALIA: a Stripe reenvia, o endpoint acaba
     * desabilitado, e o razão segue dizendo que o cliente foi reembolsado de um
     * dinheiro que nunca saiu (compliance HIGH-1 da rodada doze; inegociável #8,
     * CDC art. 6º III, Lei 13.419/2017).
     *
     * `falhou` que não casa com um lançamento é o caso NORMAL, não exótico: o
     * razão grava deltas de um acumulado, então dois estornos com um
     * `charge.refunded` perdido viram um lançamento só.
     *
     * Não cabendo, a testemunha cai e o proporcional entra — que por construção
     * cabe, porque é calculado SOBRE os baldes vivos.
     */
    /**
     * E `cabeNosBaldes` EXIGE INTEIRO SEGURO nos dois baldes, com o `if` abaixo
     * disparando sempre que ela é falsa — é o que faz a forma impossível cair no
     * lado seguro em vez de escapar.
     *
     * Eu tinha posto `isSafeInteger` nas DUAS condições e removido o mesmo teste
     * do `casaOValor` chamando-o de guarda morta ("apagá-lo não quebra teste
     * nenhum"). Nenhum teste quebrar significa que nenhum teste cobre a forma —
     * esta série inteira é sobre essa diferença. Com um `amountCents`
     * fracionário: `cabeNosBaldes` dava `false`, o `if` NÃO rodava (exigia o
     * mesmo `isSafeInteger`), a testemunha sobrevivia, e `casaOValor` virava uma
     * soma solta — `{10.5, 9.5}` casaria com `aReverter = 20` e entraria no
     * razão. Centavo fracionário, inegociável #5 (segurança LOW-2 da rodada
     * treze).
     *
     * Não há entrada alcançável hoje (todo lançamento nasce de `allocateRefund`,
     * que é inteiro) — e é exatamente por isso que é defesa em profundidade, que
     * é o que não se remove por "não quebrou teste". Ainda mais aqui: o
     * `appendEvent` do store de produção não chama `validateEvent`, então no
     * caminho do webhook o portão é o RPC e esta função.
     */
    const cabeNosBaldes = Number.isSafeInteger(casamento.amountCents)
      && Number.isSafeInteger(casamento.tipCents)
      && casamento.amountCents <= estornadoAmount && casamento.tipCents <= estornadoTip;
    if (testemunhado && casamento.amountCents !== undefined && !cabeNosBaldes) {
      await gritar('testemunha_excede_o_balde', 'high',
        `o adquirente aponta um estorno de ${casamento.amountCents}+${casamento.tipCents} e o razão só tem `
        + `${estornadoAmount}+${estornadoTip} vivos neste pagamento — revertendo pelo proporcional, `
        + `confira os estornos deste pagamento no adquirente`);
      testemunhado = false;
    }
    // `cabeNosBaldes` não se repete aqui: o `if` acima já derruba a testemunha
    // sempre que ela não cabe — INCLUSIVE quando o valor não é inteiro seguro,
    // que é o caso que a versão anterior deixava escapar.
    const casaOValor = testemunhado
      && casamento.amountCents + casamento.tipCents === aReverter;
    reversalAllocated = casaOValor
      ? { amountCents: casamento.amountCents, tipCents: casamento.tipCents, testemunhado: true }
      // O proporcional é sobre o que o ADQUIRENTE estornou, não sobre o que
      // saiu do pagamento: com o chargeback na base, o rateio tirava da gorjeta
      // uma proporção calculada sobre dinheiro que a rede levou.
      : { ...allocateRefund(estornadoAmount, estornadoTip, aReverter), testemunhado: false };
  }

  let refundAllocated = null;
  // Disputa perdida traz um DELTA (o valor disputado), não um acumulado. Rateia
  // proporcional pelo mesmo `allocateRefund`: um chargeback leva a gorjeta
  // junto, e deixá-la nos livros como "paga" mentiria pra folha (Lei 13.419).
  if (type === 'PAYMENT_REFUNDED' && Number.isSafeInteger(parsed.refundDeltaCents)) {
    const pay = state && state.payments[parsed.txid];
    if (!pay) return { status: 'rejected', reason: `refund for unknown txid ${parsed.txid}` };
    const sobra = (pay.amountCents - pay.refundedAmountCents) + (pay.tipCents - pay.refundedTipCents);
    // IDEMPOTÊNCIA da disputa perdida.
    //
    // Este é o único caminho de razão que reporta um DELTA e não um acumulado —
    // justamente a forma que o resto do estorno abandonou. Sem dedupe, uma
    // reentrega do `charge.dispute.closed` (a Stripe é at-least-once, e o
    // contrato no topo deste arquivo diz isso) aplicava o estorno de novo.
    //
    // No chargeback do valor inteiro a segunda entrega já era recusada por
    // exceder o que sobrou. Mas uma disputa de valor PARCIAL — que a rede
    // permite, e duas disputas numa cobrança também — cabia no saldo restante:
    // um segundo PAYMENT_REFUNDED entrava e a conta reabria por dinheiro que
    // saiu uma vez só. Achado pela revisão de compliance de 2026-09-08.
    //
    // A CHAVE é a disputa, não o pagamento.
    //
    // Aqui havia `if (pay.disputeStatus === 'lost') return duplicate`, e a
    // marca é POR PAGAMENTO, permanente depois da primeira derrota — enquanto
    // a rede permite DUAS disputas na mesma cobrança, que é o caso que o
    // comentário acima descreve. A segunda derrota, com outro `evt_` e outro
    // `dp_`, passava batida pelo índice único do append e era engolida aqui:
    // a Stripe debitava mais R$ 120 do restaurante, o razão dizia que nada
    // aconteceu, a linha dizia o mesmo, e a conciliação comparava os dois
    // entre si e reportava verde. Achado pela revisão de segurança de
    // 2026-09-08.
    //
    // A idempotência de verdade é o `psp_event_id` único dentro do lock
    // (migração 0018) — por ENTREGA, que é a granularidade certa. Esta guarda
    // fica com a granularidade da DISPUTA: a mesma `dp_` não encerra duas
    // vezes, disputas diferentes seguem cada uma seu caminho.
    // Sem `dp_`, o cinto ANTIGO volta.
    //
    // Escrito como `if (parsed.disputeId && …)`, um evento sem id de disputa
    // passava direto — e ficam sem ele: um payload da Stripe onde `d.id` não é
    // string, e TODO `PAYMENT_REFUNDED` que já está no razão de antes deste
    // deploy (nenhum tem `disputeId`, então `disputeIdsClosed` fica vazio pras
    // disputas em curso). Nesses casos a única proteção restante seria a
    // unicidade do `evt_`, que não cobre um segundo evento descrevendo o mesmo
    // desfecho. A guarda velha era pior por ser cega demais; ausente é pior
    // ainda. Achado pela revisão de segurança de 2026-09-08.
    const jaEncerrada = parsed.disputeId
      ? (Array.isArray(pay.disputeIdsClosed) && pay.disputeIdsClosed.includes(parsed.disputeId))
      : pay.disputeStatus === 'lost';
    if (jaEncerrada) {
      // Se a decisão veio do CINTO CEGO (sem `dp_`), deixa marca.
      //
      // A guarda por pagamento acerta a reentrega e não sabe distinguir uma
      // segunda derrota legítima. Devolver `duplicate` calado nesse caso é o
      // desfecho que este arquivo passa trinta linhas chamando de inaceitável:
      // dinheiro debitado, os dois registros mudos, conciliação verde. Sucesso
      // silencioso é o inimigo — então quando a guarda opera às cegas ela
      // registra que operou. Achado pela revisão de segurança de 2026-09-08.
      if (!parsed.disputeId) {
        try {
          await appendEvent(check.id, 'PAYMENT_ANOMALY', {
            txid: parsed.txid, severity: 'high',
            reason: `disputa perdida recusada como reentrega SEM id de disputa `
              + `(delta ${parsed.refundDeltaCents}¢) — conferir no adquirente`,
          }, parsed.eventId ? `${parsed.eventId}:blind_belt` : null);
        } catch (e) {
          process.stderr.write(`[webhook] anomalia de recusa não gravada: ${String(e && e.message).slice(0, 160)}\n`);
        }
      }
      await repairRowFromLedger(check.id, parsed.txid, deps);
      return { status: 'duplicate', checkId: check.id };
    }
    if (parsed.refundDeltaCents === 0) {
      // ZERO é caso normal, não erro: a Stripe emite `dispute.closed` de valor
      // zero no encerramento de algumas consultas prévias. Recusar isso vira
      // 409 → reenvio → endpoint desabilitado, pela coisa mais inofensiva que
      // ela manda.
      await repairRowFromLedger(check.id, parsed.txid, deps);
      return { status: 'duplicate', checkId: check.id };
    }
    if (parsed.refundDeltaCents < 0) {
      // Negativo é impossível: recusa com motivo, não uma exceção do motor de
      // dinheiro virando 500.
      return { status: 'rejected', reason: `refund delta inválido (${parsed.refundDeltaCents}) para ${parsed.txid}` };
    }
    if (parsed.refundDeltaCents > sobra) {
      // O `checkId` VAI na recusa. Sem ele a rota pula o
      // `PAYMENT_DISPUTE_CLOSED` (ela testa `if (result.checkId)`) e devolve
      // 409: a Stripe reenvia até desabilitar o endpoint, e a conta guarda um
      // `dispute_evidence_overdue` crítico por uma disputa já resolvida.
      return {
        status: 'rejected',
        checkId: check.id,
        reason: `refund ${parsed.refundDeltaCents} exceeds outstanding ${sobra} for txid ${parsed.txid}`,
      };
    }
    // A disputa perdida usa o MESMO rateio: se parte do que entrou era
    // excedente, é ele que sai primeiro. O chargeback leva a gorjeta junto — e
    // deixá-la nos livros como paga mentiria pra folha — mas o excedente nunca
    // foi gorjeta nem receita, e não pode virar desconto na folha por ordem de
    // subtração.
    //
    // `forcada`: aqui o dinheiro foi TIRADO, não devolvido. O balde do consumo
    // primeiro existe pra quem ESCOLHE devolver; num chargeback a rede decidiu,
    // e o proporcional é o que diz a verdade sobre de onde o dinheiro saiu
    // (compliance MEDIUM-2 de d7f2683).
    refundAllocated = alocarDevolucao(state, parsed.txid, pay, parsed.refundDeltaCents, { forcada: true });
  }
  if (type === 'PAYMENT_REFUNDED' && Number.isSafeInteger(parsed.cumulativeRefundedCents)) {
    const pay = state && state.payments[parsed.txid];
    if (!pay) {
      return { status: 'rejected', reason: `refund for unknown txid ${parsed.txid}` };
    }
    /**
     * O ACUMULADO DO ADQUIRENTE conta objetos `Refund`. A DISPUTA não é um.
     *
     * `charge.amount_refunded` nunca é incrementado por um chargeback, então
     * comparar com o nosso acumulado TOTAL — que tem o chargeback dentro —
     * é comparar duas réguas diferentes. Depois de um chargeback parcial o
     * nosso ficava permanentemente à frente e todo estorno de verdade que
     * viesse depois caía em `delta <= 0`: engolido como reentrega, sem
     * anomalia e sem log, com o cliente já com o dinheiro na mão (segurança
     * HIGH-4 da rodada dez).
     */
    const jaEstornado = (pay.refundedPeloTrilhoAmountCents || 0) + (pay.refundedPeloTrilhoTipCents || 0);
    const delta = parsed.cumulativeRefundedCents - jaEstornado;
    if (delta <= 0) {
      // Reenvio do mesmo estorno, ou um acumulado mais velho que o que já
      // temos. Nada a fazer, e nada de anomalia: é o caso normal.
      await repairRowFromLedger(check.id, parsed.txid, deps);
      return { status: 'duplicate', checkId: check.id };
    }
    const paidTotal = pay.amountCents + pay.tipCents;
    if (parsed.cumulativeRefundedCents > paidTotal) {
      // O PSP diz ter devolvido mais do que recebeu. Não inventa número: recusa
      // alto, porque isto é divergência de dinheiro e não arredondamento.
      return {
        status: 'rejected',
        reason: `refund ${parsed.cumulativeRefundedCents} exceeds paid ${paidTotal} for txid ${parsed.txid}`,
      };
    }
    /**
     * A REFAÇÃO do estorno também segue a testemunha.
     *
     * Ela caía no proporcional: com uma falha só de serviço (R$ 10,00), refazer
     * o estorno pelo trilho devolvia R$ 10,00 ao cliente e o razão registrava
     * R$ 0,91 — R$ 9,09 ficando na folha sobre serviço que voltou (compliance
     * MEDIUM-1 de 95f72a9). Ou a testemunha vale nos dois trilhos, ou em nenhum.
     */
    refundAllocated = alocarDevolucao(state, parsed.txid, pay, delta,
      // A MESMA guarda que o `tetoDaRestituicao` tem: testemunha zerada não é
      // testemunha. Duas cópias da regra, e esta estava com três de quatro
      // condições (segurança HIGH-2 de 11a0904).
      (pay.reversedOpenTestemunhado === true && pay.reversedOpenCents > 0) ? {
        testemunha: {
          amountCents: Math.max(0, pay.reversedOpenAmountCents || 0),
          tipCents: Math.max(0, pay.reversedOpenTipCents || 0),
        },
      } : undefined);
  }

  const payload = type === 'PAYMENT_DISPUTE_CLOSED' ? {
    txid: parsed.txid,
    outcome: parsed.status === 'warning_closed' ? 'warning_closed' : 'won',
  } : {
    txid: parsed.txid,
    amountCents: (refundAllocated || reversalAllocated)
      ? (refundAllocated || reversalAllocated).amountCents : parsed.amountCents,
    tipCents: (refundAllocated || reversalAllocated)
      ? (refundAllocated || reversalAllocated).tipCents : parsed.tipCents,
    // Real method from the PSP ('card' for Apple/Google Pay) — it used to be
    // hardcoded 'pix', which would mislabel wallet money in the ledger.
    ...(type === 'PAYMENT_CONFIRMED' ? { method: parsed.method || 'pix' } : {}),
    // O excedente DESTE pagamento (ver `alocarDevolucao`).
    ...(type === 'PAYMENT_CONFIRMED' && Number.isSafeInteger(parsed.excessCents) && parsed.excessCents > 0
      ? { excessCents: parsed.excessCents } : {}),
    // O `dp_` fica no LOG: é o que distingue a reentrega de uma derrota da
    // segunda derrota de verdade, e o log é o único lugar durável.
    ...(type === 'PAYMENT_REFUNDED' && parsed.disputeId ? { disputeId: parsed.disputeId } : {}),
    /**
     * E A PROCEDÊNCIA fica marcada MESMO SEM O `dp_`.
     *
     * "É uma disputa" e "qual disputa" são perguntas diferentes, e o razão
     * gravava só a segunda. Um `dispute_lost` sem `dp_` — o cinto cego, que este
     * arquivo já trata cem linhas acima — produzia um `PAYMENT_REFUNDED` que
     * nenhum leitor conseguia distinguir de um estorno do adquirente: entrava no
     * acumulado do trilho, virava candidato a "o estorno que falhou", e o
     * chargeback podia ser desfeito no razão (segurança HIGH-3 da rodada dez,
     * HIGH-1 da rodada onze).
     *
     * A marca é derivada do KIND, que a gente sempre tem. Os lançamentos
     * gravados ANTES desta linha continuam sem ela — e pra esses o `dp_`, quando
     * existe, ainda responde.
     */
    ...(type === 'PAYMENT_REFUNDED' && parsed.kind === 'dispute_lost' ? { deDisputa: true } : {}),
    // A TESTEMUNHA É VERDADEIRA? Só quando o valor revertido casou com UM
    // lançamento do razão. Sem isso o rateio é palpite nosso, e o razão precisa
    // dizer qual dos dois foi — é ele que autoriza tirar da base da folha.
    ...(type === 'PAYMENT_REFUND_REVERSED' && reversalAllocated
      ? {
        testemunhado: reversalAllocated.testemunhado === true,
        // O id do estorno que falhou — a chave que separa a segunda entrega da
        // mesma falha de uma falha nova.
        ...(parsed.refundId ? { refundId: parsed.refundId } : {}),
      } : {}),
  };

  if (type === 'PAYMENT_CONFIRMED' && state && state.payments[parsed.txid]) {
    const existing = state.payments[parsed.txid];
    if (existing.amountCents === parsed.amountCents && existing.tipCents === parsed.tipCents) {
      await repairRowFromLedger(check.id, parsed.txid, deps);
      return { status: 'duplicate', checkId: check.id }; // clean at-least-once replay
    }
    // Divergent replay: append so the anomaly is durable and alertable.
    const seq = await appendEvent(check.id, type, payload, parsed.eventId || null);
    if (typeof seq === 'number' && seq < 0) {
      await repairRowFromLedger(check.id, parsed.txid, deps);
      return { status: 'duplicate', checkId: check.id, seq: -seq };
    }
    return { status: 'divergent_appended', checkId: check.id, seq };
  }

  try {
    validateEvent({ type, payload }, state);
  } catch (err) {
    if (err instanceof EventValidationError) {
      // e.g. refund exceeding the payment, refund for unknown txid after a
      // check swap. Reject: PSP retries will keep failing loudly, which is
      // what we want a human to see.
      return { status: 'rejected', checkId: check.id, reason: err.message };
    }
    throw err;
  }

  /**
   * O append é a fronteira de IDEMPOTÊNCIA.
   *
   * `seq` negativo quer dizer "este evento do PSP já foi aplicado" — o append
   * confere DENTRO do lock por conta (migração 0018) e não grava nada. É o que
   * fecha a corrida entre duas entregas simultâneas do mesmo evento, que a
   * checagem em memória logo acima não fecha: ela lê o estado antes, e duas
   * entregas leem o mesmo estado velho.
   *
   * Necessário porque uma falha de estorno chega em DOIS eventos diferentes
   * (`refund.failed` e `refund.updated` com status `failed`), e antes disto
   * cada um aplicava uma reversão. Reproduzido: um estorno de 900 do qual 500
   * tinha dado certo era apagado inteiro, a conta voltava pra `paga` e o POS
   * era informado de que a mesa tinha pago.
   */
  const seq = await appendEvent(check.id, type, payload, parsed.eventId || null);
  if (typeof seq === 'number' && seq < 0) {
    await repairRowFromLedger(check.id, parsed.txid, deps);
    return { status: 'duplicate', checkId: check.id, seq: -seq };
  }

  /**
   * O estado da LINHA depois deste evento.
   *
   * Recalculado do razão, não deduzido da espécie: só o razão sabe se o
   * estorno acumulado igualou o pagamento. `devolvido` é desfecho, não é
   * "houve um estorno".
   */
  let rowStatus = ROW_STATUS_FOR_KIND[parsed.kind] || 'confirmado';
  let refundedTotals = null;
  // A DISPUTA GANHA entra aqui junto com o estorno, e não porque ela move
  // saldo — ela não move — mas porque `ROW_STATUS_FOR_KIND.dispute_won` é
  // `confirmado` e era aplicado seco. Uma disputa ganha sobre um pagamento já
  // estornado por inteiro virava a linha de `devolvido` pra `confirmado`, e a
  // conciliação passava a gritar `status_lag` pra sempre por uma linha que o
  // dinheiro já tinha deixado. Quem decide o estado da linha é o razão.
  if (type === 'PAYMENT_REFUNDED' || type === 'PAYMENT_REFUND_REVERSED'
      || type === 'PAYMENT_DISPUTE_CLOSED') {
    const depois = reduce(await loadEvents(check.id));
    const pay = depois && depois.payments[parsed.txid];
    if (pay) {
      refundedTotals = {
        amountCents: pay.refundedAmountCents,
        tipCents: pay.refundedTipCents,
      };
      const total = pay.refundedAmountCents === pay.amountCents
        && pay.refundedTipCents === pay.tipCents;
      rowStatus = total ? 'devolvido' : 'confirmado';
    }
  }

  if (recordPayment) {
    await recordPayment({
      checkId: check.id,
      txid: parsed.txid,
      amountCents: parsed.amountCents,
      tipCents: parsed.tipCents,
      kind: parsed.kind,
      // O status vem RESOLVIDO daqui. O store não decide dinheiro.
      //
      // `devolvido` SÓ no estorno total. O tri-estado da linha não sabe dizer
      // "parcialmente estornado", e marcar `devolvido` num estorno parcial
      // fazia a conciliação gritar pra sempre e o pagamento inteiro sumir do
      // faturamento e da gorjeta. Ver a migração 0016.
      status: rowStatus,
      // Os ACUMULADOS estornados vão pra linha, pra quem soma dinheiro somar
      // líquido em vez de dropar a linha inteira.
      ...(refundedTotals ? {
        refundedAmountCents: refundedTotals.amountCents,
        refundedTipCents: refundedTotals.tipCents,
      } : {}),
      // Os valores CONFIRMADOS, e só na confirmação de pagamento: num estorno
      // `parsed.amountCents` é o delta estornado, não o valor do pagamento, e
      // gravar isso como "confirmado" trocaria uma verdade por outra.
      //
      // Vão em colunas SEPARADAS das registradas (migração 0015). Sobrescrever
      // as registradas seria a correção óbvia e destruiria o detector: é
      // comparar o pedido com o log que produz `amount_mismatch`.
      ...(type === 'PAYMENT_CONFIRMED' ? {
        confirmedAmountCents: payload.amountCents,
        confirmedTipCents: payload.tipCents,
      } : {}),
      // O retrato mascarado é da CONFIRMAÇÃO, e só dela.
      //
      // Escrito em todo evento, um estorno ou uma disputa sobrescreviam o
      // payload do pagamento — o retrato forense de quando o dinheiro entrou,
      // que é o que se olha quando alguém contesta. A reparação da linha já
      // preserva esse campo de propósito (passa `undefined`); o caminho normal
      // destruía o que ela protege. Achado pela revisão de segurança de
      // 2026-09-08.
      ...(type === 'PAYMENT_CONFIRMED'
        ? { pspPayloadMasked: maskPixPayload(parsed.raw) }  // só o subconjunto mascarado é gravável
        : {}),
      // `confirmedAt` só na CONFIRMAÇÃO.
      //
      // Era carimbado em todo evento, então um estorno, uma reversão ou uma
      // disputa ganha reescreviam a data de um pagamento de três semanas atrás
      // pra hoje — e a série semanal (`buildAtivacao`) agrupa por essa data.
      // O faturamento pulava de dia sozinho. Achado pela revisão de segurança
      // de 2026-09-08.
      ...(type === 'PAYMENT_CONFIRMED' ? { confirmedAt: new Date().toISOString() } : {}),
    });
  }
  return { status: 'appended', checkId: check.id, seq };
}

/**
 * @param {object} deps
 * @param {(checkId: string) => Promise<Array>} deps.loadEvents  seq-ordered
 * @param {(checkId: string, type: string, payload: object) => Promise<number>} deps.appendEvent
 * @param {(payment: object) => Promise<void>} [deps.recordPayment]  payments-table upsert (masked payload)
 * @param {{ verifyAndParseWebhook: Function }} deps.psp
 * @param {(checkId: string) => Promise<{id: string}|null>} deps.findCheckByTxid
 * @param {(parsed: object) => Promise<object|null>} [deps.fallback]
 *   Tried when the txid is not a check charge (e.g. house-account loads).
 *   Returns a result object to use, or null → the unknown-txid rejection.
 */
/**
 * Espécie de evento → tipo de evento do razão. Quem não está aqui não entra.
 *
 * `refund_failed` está: o estorno já tinha sido gravado quando foi CRIADO
 * (a Stripe incrementa `amount_refunded` na criação), então "não fazer nada"
 * deixava o razão dizendo que o cliente foi reembolsado quando o dinheiro
 * voltou pro restaurante. Desfazer é o único registro verdadeiro.
 */
const EVENT_FOR_KIND = Object.freeze({
  payment_confirmed: 'PAYMENT_CONFIRMED',
  refund: 'PAYMENT_REFUNDED',
  refund_failed: 'PAYMENT_REFUND_REVERSED',
  // Disputa PERDIDA é estorno de verdade: o dinheiro foi. Espécie própria (e
  // não `refund` genérico) porque o razão também precisa LIMPAR a marca da
  // disputa, e porque o valor vem como delta pra ser rateado entre consumo e
  // gorjeta — um chargeback leva a gorjeta junto.
  dispute_lost: 'PAYMENT_REFUNDED',
  // Disputa GANHA não mexe em dinheiro, mas PRECISA de evento: sem ele a
  // anomalia nunca sai e a conta fica vermelha pra sempre.
  dispute_won: 'PAYMENT_DISPUTE_CLOSED',
});

/** As espécies que viram lançamento no razão. */
const LEDGER_KINDS = new Set(Object.keys(EVENT_FOR_KIND));

/**
 * O STATUS da linha de pagamento, por espécie.
 *
 * Os dois stores faziam `kind === 'refund' ? 'devolvido' : 'confirmado'` — o
 * mesmo `else` que causou o achado do chargeback, uma camada abaixo. Com a
 * família da disputa lida de verdade isso passou a estar ERRADO: uma disputa
 * PERDIDA cai no `else` e a linha fica `confirmado`, com o dinheiro já ido.
 *
 * Então o mapa é explícito e mora aqui, no módulo que decide dinheiro. O store
 * só grava o que recebe.
 */
const ROW_STATUS_FOR_KIND = Object.freeze({
  payment_confirmed: 'confirmado',
  refund: 'devolvido',
  dispute_lost: 'devolvido',      // o dinheiro foi
  refund_failed: 'confirmado',    // o estorno não aconteceu: o dinheiro é da casa
  dispute_won: 'confirmado',      // a casa manteve o dinheiro
  // `expirado` já existe no esquema desde a primeira migração e é exatamente
  // isto: cobrança que não vai se concretizar.
  payment_failed: 'expirado',
});

/**
 * Espécies de evento de DINHEIRO que não viram lançamento aqui.
 *
 * Cada uma tem um dono: a disputa tem prazo de prova, o estorno que falhou
 * significa que o dinheiro voltou pro restaurante e o cliente ficou sem, e o
 * `unusable_money_event` é dinheiro que saiu num valor que o adaptador não
 * consegue medir. Nenhuma delas move saldo, e nenhuma delas pode cair no
 * aplicador — lá dentro tudo que não é `refund` é tratado como pagamento.
 */
const NON_LEDGER_KINDS = new Set([
  'dispute_opened', 'refund_progress', 'unusable_money_event',
  // Mudança de estado da disputa (prazo, prova enviada) e movimento do valor
  // disputado no SALDO. Nenhum dos dois muda o que a mesa deve; os dois
  // precisam de alerta e de registro, que é do chamador.
  'dispute_updated', 'dispute_funds',
  // Conta e repasse: `payout.failed` (o dinheiro do restaurante não chegou),
  // capacidade virando inativa (o trilho falha na mesa), e aviso precoce de
  // fraude (o único momento em que estornar evita a disputa inteira). Não
  // movem o razão de nenhuma mesa; precisam de alerta.
  'account_alert',
  // Pagamento que falhou (recusa no app do banco, ou intent cancelado). Não
  // move o razão — nenhum dinheiro se moveu — mas a LINHA da cobrança precisa
  // sair de `pendente`, senão ela some da janela de conciliação sem registro.
  'payment_failed',
]);

/**
 * A LINHA reconciliada a partir do razao — a reparacao de uma entrega parcial.
 *
 * O aplicador faz duas escritas: o `appendEvent` (o razao, a verdade) e o
 * `recordPayment` (a linha, uma projecao). Entre as duas cabe uma falha: um
 * 5xx do Supabase, uma conexao cortada. O razao diz que o cliente pagou, a
 * linha continua `pendente`, e a REENTREGA — que existe exatamente pra isso —
 * nunca reparava, porque os tres curto-circuitos de idempotencia devolvem
 * `duplicate` ANTES da linha: o `seenPspEvent` no topo, a conferencia de
 * estado da confirmacao, e o `seq` negativo do append.
 *
 * A conciliacao ativa tambem nao alcancava: ela chama o mesmo aplicador,
 * recebe `duplicate`, e segue. Passadas 24h a cobranca sai da janela e a linha
 * fica `pendente` pra sempre — o faturamento e a GORJETA (base da folha, Lei
 * 13.419) perdidos, com `ledger_drift` critico permanente ate alguem escrever
 * SQL na mao. Achado pela revisao de seguranca de 2026-09-08.
 *
 * A reparacao e segura por construcao porque a linha e uma PROJECAO: escrever
 * o que o razao diz nao pode inventar dinheiro. So escreve quando diverge, e
 * `confirmedAt` so quando esta faltando — reescrever a data moveria o
 * faturamento de dia, que e outro defeito ja corrigido.
 */
async function repairRowFromLedger(checkId, txid, deps) {
  const { loadEvents, getPayment, repairPaymentRow } = deps;
  if (typeof getPayment !== 'function' || typeof repairPaymentRow !== 'function') return;
  try {
    const linha = await getPayment(txid);
    if (!linha) return;
    const state = reduce(await loadEvents(checkId));
    const pay = state && state.payments[txid];
    if (!pay) return; // o razao nao conhece este pagamento: nada a projetar

    const estornoTotal = pay.refundedAmountCents === pay.amountCents
      && pay.refundedTipCents === pay.tipCents;
    const status = estornoTotal ? 'devolvido' : 'confirmado';
    const faltaData = !linha.confirmedAt;
    if (linha.status === status && !faltaData) return; // ja converge

    /**
     * CONDICIONAL: só escreve se a linha ainda estiver como foi lida.
     *
     * Era um `recordPayment` cego, e ele roda em todo caminho de `duplicate` —
     * ou seja, exatamente quando há duas entregas do mesmo webhook em voo. O
     * intercalamento perdia escrita: uma reentrega de `charge.paid` lia
     * `refunded = 0`, um `charge.refunded` gravava `devolvido` no meio, e a
     * reparação escrevia `confirmado`/`refunded 0` por cima. O painel voltava
     * a contar como faturamento — e a gorjeta como base da folha — um
     * pagamento devolvido por inteiro.
     *
     * Migração 0023, inegociável #7. Perder a corrida é NORMAL e não é erro: a
     * outra entrega sabia mais. Só registra e sai.
     */
    process.stderr.write(`[webhook] reparando linha ${txid}: ${linha.status} -> ${status}\n`);
    const reparou = await repairPaymentRow({
      txid,
      expectedStatus: linha.status,
      expectedRefundedAmountCents: linha.refundedAmountCents || 0,
      expectedRefundedTipCents: linha.refundedTipCents || 0,
      status,
      confirmedAmountCents: pay.amountCents,
      confirmedTipCents: pay.tipCents,
      refundedAmountCents: pay.refundedAmountCents,
      refundedTipCents: pay.refundedTipCents,
      ...(faltaData ? { confirmedAt: new Date().toISOString() } : {}),
      // Procedência pro log de reparo (migração 0029): a reentrega do adquirente — o único caso que a frase antiga descrevia.
      source: 'webhook_redelivery',
    });
    if (!reparou) {
      process.stderr.write(`[webhook] linha ${txid} mudou no meio do reparo — a outra entrega ganhou\n`);
    }
  } catch (e) {
    // A reparacao e oportunista: falhar aqui nao pode transformar uma
    // reentrega inofensiva num 500 que faz o PSP reenviar em laco.
    process.stderr.write(`[webhook] reparo da linha ${txid} falhou: ${String(e.message).slice(0, 120)}\n`);
  }
}

function createWebhookHandler({
  loadEvents, appendEvent, recordPayment, psp, findCheckByTxid, fallback, seenPspEvent, getPayment,
  repairPaymentRow,
}) {
  if (!loadEvents || !appendEvent || !psp || !findCheckByTxid) {
    throw new Error('createWebhookHandler: missing dependencies');
  }
  // `seenPspEvent` estava FORA desta lista, e os três chamadores passavam.
  // Dois jogavam fora em silêncio: o curto-circuito de reentrega no topo do
  // aplicador — o que faz uma segunda entrega sair como `duplicate` em vez de
  // 409 → reenvio → endpoint desabilitado — estava morto nos dois caminhos de
  // webhook. Achado pela revisão de segurança de 2026-09-08.
  const deps = {
    loadEvents, appendEvent, recordPayment, findCheckByTxid, fallback, seenPspEvent,
    getPayment, repairPaymentRow,
  };

  /**
   * @returns {Promise<{status: 'appended'|'duplicate'|'divergent_appended'|'rejected'|'ignored', checkId?: string, seq?: number, reason?: string, type?: string}>}
   * Throws WebhookVerificationError upward (HTTP layer → 401).
   */
  return async function handlePspWebhook(rawBody, signatureHeader) {
    // await: o mock verifica em memória (sync), o Pagar.me RE-BUSCA a
    // cobrança na API (async) — o corpo do webhook nunca é a verdade.
    const parsed = await psp.verifyAndParseWebhook(rawBody, signatureHeader); // throws on bad sig/auth

    // CONJUNTO FECHADO. Só duas espécies de evento chegam ao razão.
    //
    // A primeira versão desta guarda testava só `kind === 'ignored'`, e as duas
    // revisões de 2026-09-08 apontaram o mesmo problema: ela endurecia a
    // espécie inofensiva e deixava as PERIGOSAS passando. `dispute_opened`,
    // `refund_failed` e `refund_progress` eram tratadas só na ROTA, então
    // qualquer outro chamador as mandava pro aplicador, e lá dentro:
    //
    //     const type = parsed.kind === 'refund' ? 'PAYMENT_REFUNDED' : 'PAYMENT_CONFIRMED';
    //
    // Uma notificação de CHARGEBACK viraria PAYMENT_CONFIRMED. Concretamente:
    // a disputa chega pra um `pi_` cuja confirmação nunca caiu, o `payments`
    // resolve o check, o razão grava o valor disputado como dinheiro RECEBIDO,
    // a conta vira `paga`, o write-back empurra "pago" pro POS e a mesa fecha
    // em cima de um chargeback.
    //
    // Então: lista de quem PODE mover o razão, e tudo o mais para aqui. Espécie
    // desconhecida ESTOURA — é erro de programação, e um 500 alto é melhor que
    // um evento de dinheiro classificado por acidente.
    if (!parsed || typeof parsed.kind !== 'string') {
      throw new Error('webhook: parse sem `kind`');
    }
    // Ignorado é o caso comum e barato. Medido rodando de verdade
    // (2026-09-08): um pagamento Bizum entrega CINCO eventos —
    // `payment_intent.created`, `.requires_action`, `.succeeded`,
    // `charge.succeeded` e `charge.updated` — e só um move dinheiro.
    if (parsed.kind === 'ignored') {
      return { status: 'ignored', type: parsed.type };
    }
    // Evento de dinheiro que NÃO se resolve num lançamento: disputa aberta,
    // estorno que falhou, estorno em progresso, e o "saiu dinheiro e não
    // sabemos quanto" de um cancelamento parcial. Quem trata é o chamador
    // (alerta, prazo, registro) — o razão não se mexe aqui.
    if (NON_LEDGER_KINDS.has(parsed.kind)) {
      return { status: parsed.kind, type: parsed.type || null, txid: parsed.txid || null, raw: parsed };
    }
    if (!LEDGER_KINDS.has(parsed.kind)) {
      throw new Error(`webhook: kind desconhecido ${JSON.stringify(parsed.kind)}`);
    }
    return applyConfirmedPayment(parsed, deps);
  };
}

module.exports = {
  createWebhookHandler, applyConfirmedPayment,
  EVENT_FOR_KIND, ROW_STATUS_FOR_KIND, LEDGER_KINDS, NON_LEDGER_KINDS,
};
