'use strict';

/**
 * Reconciliation canary — the money core's final safety net.
 *
 * Racha keeps TWO independent records of the same money, both written by the
 * webhook handler but to different places:
 *   1. the append-only EVENT LOG (check_events) → reduce() → paid/tip per txid
 *   2. the PAYMENTS TABLE (one row per txid, status confirmado/devolvido)
 *
 * A partial write, a dropped append, a divergent replay, or a raced lifecycle
 * event makes these disagree. This module cross-checks them per check and
 * reports drift ≥ 1 centavo — the "alert on drift" promise from the plan.
 * PURE and TOTAL: never throws; a malformed input becomes a finding.
 *
 * Findings are severity-ranked so the canary can page on `critical`/`high`
 * and merely log `info`.
 */

const { reduce } = require('./check-state');
const houseState = require('../house/account-state');

/**
 * @param {object} input
 * @param {string} input.checkId
 * @param {Array} input.events        seq-ordered check_events
 * @param {Array} input.payments      payment rows: { txid, amountCents, tipCents, status }
 * @returns {{ checkId: string, ok: boolean, driftCents: number, findings: Array }}
 */
function reconcileCheck({ checkId, events, payments }) {
  const findings = [];
  const add = (severity, code, msg, extra = {}) =>
    findings.push({ severity, code, message: msg, ...extra });

  let state;
  try {
    state = reduce(events || []);
  } catch (err) {
    // reduce() is total, but guard anyway — a throw here is itself a finding.
    add('critical', 'reduce_threw', `event log could not be reduced: ${err.message}`);
    return { checkId, ok: false, driftCents: 0, findings };
  }

  // 1. Event-log anomalies are reconciliation findings in their own right.
  for (const a of state ? state.anomalies : []) {
    // A SEVERIDADE vem da anomalia. Antes tudo virava `high`, então uma
    // informação registrada — uma disputa perdida já contabilizada, uma
    // pendência já resolvida — deixava a casa vermelha pra sempre. Uma casa que
    // nunca fica verde é uma casa que para de olhar, que é o modo de falha que
    // o inegociável #8 descreve.
    add(a.severity || 'high', 'log_anomaly', `event-log anomaly: ${a.reason}`,
      { seq: a.seq, type: a.type, ...(a.txid ? { txid: a.txid } : {}) });
  }

  const rows = Array.isArray(payments) ? payments : [];
  const byTxid = new Map();
  for (const r of rows) {
    if (r && typeof r.txid === 'string') byTxid.set(r.txid, r);
  }

  // 1b. UMA conta, UMA moeda.
  //
  // A conciliação soma centavos e compara com centavos. Sem olhar a moeda, ela
  // atravessa uma troca de moeda somando 2450 de real com 2450 de euro e
  // reportando 0,00 de divergência — o inegociável #8 derrotado exatamente
  // onde ele deveria gritar. Duas revisões independentes apontaram isso no
  // mesmo dia, e a resposta tem duas partes: a moeda passou a ser gravada na
  // linha do pagamento (0014_payment_currency.sql), e AQUI é onde ela é
  // conferida. Gravar sem conferir é um campo, não uma defesa.
  //
  // Como isto pode acontecer, apesar do gatilho que congela o market: um
  // pagamento gravado antes da coluna existir (moeda ausente, não errada) ao
  // lado de um gravado depois. Por isso ausente NÃO é divergência — é o
  // histórico. O que é divergência é DUAS moedas presentes na mesma conta.
  // 1c. O PRAZO DE PROVA de uma disputa aberta.
  //
  // O Bizum dá 40 dias corridos pra apresentar prova, e perder o prazo é
  // perder o dinheiro por INAÇÃO — não por ter perdido o mérito. Antes disto,
  // a defesa inteira desse prazo era um `notifyFounderMoneyEvent`, que devolve
  // `{skipped:true}` e escreve em stderr quando falta `RACHA_NOTIFY_SECRET`, e
  // que engole qualquer falha de rede. Um prazo de dinheiro defendido por uma
  // notificação best-effort é um prazo indefeso.
  //
  // Aqui ele vira ACHADO, que é o que o job diário lê e o que o canário
  // pageia. Achado pela revisão de compliance de 2026-09-08.
  const agora = Date.now();
  for (const [txid, pay] of Object.entries(state ? state.payments : {})) {
    if (!pay.disputeDueBy || !(pay.disputedAmountCents > 0)) continue;
    const prazo = Date.parse(pay.disputeDueBy);
    if (!Number.isFinite(prazo)) continue;
    const diasRestantes = Math.floor((prazo - agora) / 86400000);
    if (diasRestantes < 0) {
      add('critical', 'dispute_evidence_overdue',
        `prazo de prova da disputa de ${txid} VENCEU em ${pay.disputeDueBy}`,
        { txid, dueBy: pay.disputeDueBy, disputedCents: pay.disputedAmountCents });
    } else if (diasRestantes <= 7) {
      // Sete dias: tempo de alguém juntar recibo, IP e horário sem correr.
      add('high', 'dispute_evidence_due',
        `prazo de prova da disputa de ${txid} vence em ${diasRestantes} dia(s) (${pay.disputeDueBy})`,
        { txid, dueBy: pay.disputeDueBy, disputedCents: pay.disputedAmountCents });
    }
  }

  /**
   * DINHEIRO A MAIS na conta é uma DÍVIDA da casa, e ela tem que aparecer.
   *
   * O redutor já marcava `overpaidCents` e o número morria ali: nenhum achado,
   * nada no painel, nada na tela do cliente. Quem recebeu o que não lhe era
   * devido é obrigado a restituir (CC art. 876) e a obrigação não espera o
   * consumidor pedir; o cliente tem direito à informação clara (CDC art. 6º,
   * III). Um saldo a devolver que ninguém vê não é devolvido.
   *
   * `high`, não `critical`: nada se perdeu, mas alguém precisa agir — e sai da
   * lista assim que a restituição for registrada (o estorno reduz `paidCents`
   * e a sobra some sozinha).
   * Recomendação da revisão de compliance de 2026-09-08.
   */
  if (state && state.overpaidCents > 0) {
    /**
     * E a dívida ENVELHECE.
     *
     * `high` na primeira noite e na nonagésima é a mesma coisa que não
     * escalar: uma dívida com o consumidor que nunca sobe de tom é uma dívida
     * que a casa pode ir guardando (CC art. 884, enriquecimento sem causa).
     * Passadas 48h vira `critical`, que é o que pinta o relatório diário de
     * vermelho e sai no alerta.
     */
    // A data vem da linha do pagamento CONFIRMADO mais antigo desta conta: o
    // razão não guarda hora (o `loadEvents` lê `seq, type, payload`), e
    // inventar "agora" faria a dívida nunca envelhecer.
    // A data é do pagamento que pagou a MAIS, não da conta inteira.
    //
    // Era a menor `confirmedAt` de qualquer pagamento da conta: um excedente
    // de hoje numa conta velha nascia `critical`, e escalar cedo demais treina
    // quem lê a ignorar — o mesmo desgaste que este achado quer evitar. Quem
    // sabe de excedente é o RAZÃO (`state.payments[txid].excessCents`); a
    // linha só tem a data.
    const comSobra = new Set(Object.entries((state && state.payments) || {})
      .filter(([, pg]) => ((pg.excessCents || 0) - (pg.refundedAmountCents || 0)) > 0)
      .map(([txid]) => txid));
    const candidatas = comSobra.size > 0
      ? rows.filter((r) => r && comSobra.has(r.txid))
      : rows;
    const datas = candidatas.map((r) => r && r.confirmedAt).filter(Boolean).sort();
    const abertaDesde = datas[0] || null;
    const horas = abertaDesde ? (Date.now() - Date.parse(abertaDesde)) / 3600000 : 0;
    add(horas > 48 ? 'critical' : 'high', 'overpaid_pending_restitution',
      `conta recebeu ${state.overpaidCents}¢ a mais do que devia — restituição pendente`
      + `${horas > 48 ? ` há ${Math.floor(horas / 24)} dia(s)` : ''} (CC art. 876)`,
      { overpaidCents: state.overpaidCents, ...(abertaDesde ? { since: abertaDesde } : {}) });
  }

  const moedas = new Set(rows.map((r) => r && r.currency).filter(Boolean));
  if (moedas.size > 1) {
    add('critical', 'mixed_currency',
      `check has payments in more than one currency: ${[...moedas].sort().join(', ')}`,
      { currencies: [...moedas].sort() });
  }

  // 2. Every confirmed event-log payment must have a matching confirmed row.
  const logPayments = state ? state.payments : {};
  let logConfirmedCents = 0;
  for (const txid of Object.keys(logPayments)) {
    const pay = logPayments[txid];
    const net = pay.amountCents - pay.refundedAmountCents + pay.tipCents - pay.refundedTipCents;
    logConfirmedCents += net;

    const row = byTxid.get(txid);
    if (!row) {
      add('critical', 'missing_payment_row',
        `txid ${txid} is in the event log but has no payments row (partial write?)`, { txid });
      continue;
    }
    /**
     * O que se compara com o razão é o CONFIRMADO, não o pedido.
     *
     * Antes, `amount_mismatch` crítico comparava `amount_cents` (o valor que a
     * cobrança PEDIU) contra o log. Isso valia enquanto "pedido ≠ recebido"
     * era, por definição, defeito. Deixou de valer no dia em que o Pix
     * `underpaid` passou a entrar como dinheiro recebido: agora todo pagamento
     * a menor — comportamento CORRETO do cliente — acenderia um crítico
     * permanente, e "um alerta que dispara em comportamento correto está morto
     * em duas semanas" (a lição escrita três parágrafos abaixo).
     *
     * O invariante de projeção de verdade é: a coluna confirmada tem que ser
     * igual ao razão. E é a coluna que o painel soma em faturamento e em
     * GORJETA — a base da folha (Lei 13.419) era conferida contra nada.
     * Achado pela revisão de compliance de 2026-09-08.
     */
    const confirmadoLinha = Number.isFinite(row.confirmedAmountCents)
      ? (row.confirmedAmountCents || 0) + (row.confirmedTipCents || 0)
      : null;
    const logTotal = pay.amountCents + pay.tipCents;
    if (confirmadoLinha !== null && confirmadoLinha !== logTotal) {
      add('critical', 'amount_mismatch',
        `txid ${txid}: confirmado na linha ${confirmadoLinha}¢ vs razão ${logTotal}¢`, { txid });
    }
    // A gorjeta SOZINHA também: as duas partes podem somar igual e estar
    // trocadas entre si, e o número trocado é o que vai pra folha.
    if (Number.isFinite(row.confirmedTipCents) && row.confirmedTipCents !== pay.tipCents) {
      add('critical', 'tip_mismatch',
        `txid ${txid}: gorjeta confirmada ${row.confirmedTipCents}¢ vs razão ${pay.tipCents}¢`,
        { txid, tipCents: pay.tipCents });
    }
    /**
     * PEDIDO vs RECEBIDO — um fato do negócio, não um defeito.
     *
     * Fica registrado, com os centavos, e em `info`: é o Pix em que o cliente
     * digitou outro valor. Serve pro relatório de serviço COBRADO vs
     * ARRECADADO, que é o contrapeso da regra de imputação (ver
     * `allocateUnderpayment`), e nunca deve pintar o canário de vermelho.
     */
    const rowTotal = (row.amountCents || 0) + (row.tipCents || 0);
    if (confirmadoLinha !== null && rowTotal !== confirmadoLinha) {
      const delta = confirmadoLinha - rowTotal;
      /**
       * Esta é a ÚLTIMA testemunha independente, e por isso ela não pode ser
       * `info` em qualquer tamanho.
       *
       * `confirmed_*` e o evento do razão saem da MESMA variável na MESMA
       * chamada (`applyConfirmedPayment` → `recordPayment`): comparar os dois
       * pega defeito de projeção e mais nada. `amount_cents` foi escrito num
       * outro momento, por outro caminho (`registerCharge`, na criação da
       * cobrança) — é o único número que discorda por conta própria.
       *
       * Rebaixar TODA discordância a `info` (que não conta como falha e não
       * chega ao alerta diário) fechou o único olho que restava: um defeito de
       * medição no adaptador — `receivedCents` lendo o campo errado depois de
       * uma virada de versão da API, `metadata.tip_cents` torto — confirmaria
       * 1 centavo pra uma cobrança de 37,29, os dois lados concordariam, o
       * canário ficaria verde, e a conta ficaria aberta pra ser cobrada de novo.
       *
       * Então a FAIXA decide: um Pix pago a menor é o cliente digitando outro
       * valor no app do banco, e isso é fato do negócio (`info`). Receber MAIS
       * do que se pediu não é: o pagador não escolhe pagar além numa cobrança
       * Pix com valor, então excedente é sempre `high`. E uma diferença
       * grotesca pra menos — menos de um décimo do pedido — é defeito de
       * medição, não gorjeta recusada.
       * Achado pela revisão de segurança de 2026-09-08.
       */
      /**
       * E o excedente JÁ RESTITUÍDO não fica alto pra sempre.
       *
       * A comparação é com o valor PEDIDO, que nunca muda — então uma cobrança
       * paga a mais mantinha o achado `high` mesmo depois de a casa devolver
       * tudo, e a casa ficava na lista vermelha da noite indefinidamente. O
       * canário que grita pra sempre, instalado no caminho que esta série toda
       * existe pra servir. O que aconteceu continua registrado (`info`); o que
       * pede ação é só o que ainda não foi resolvido.
       * Achado pela revisão de compliance de 2026-09-08.
       */
      const sobraNaoRestituida = Math.max(0, (pay.excessCents || 0) - (pay.refundedAmountCents || 0));
      // Resolvido é: HAVIA excedente nesta conta e ele já voltou. Se nunca
      // houve — a cobrança capturou mais do que pediu sem que a CONTA ficasse
      // paga a mais — a diferença é sinal de medição, e segue alta.
      const resolvido = delta > 0 && (pay.excessCents || 0) > 0 && sobraNaoRestituida === 0;
      const grotesca = (delta > 0 && !resolvido) || confirmadoLinha * 10 < rowTotal;
      add(grotesca ? 'high' : 'info', delta < 0 ? 'underpayment' : 'overpayment',
        `txid ${txid}: pedido ${rowTotal}¢, recebido ${confirmadoLinha}¢ (Δ ${delta}¢)`,
        { txid, deltaCents: delta });
    }
    /**
     * Linha `confirmado` SEM valor confirmado é notícia, não dispensa.
     *
     * A guarda `confirmadoLinha !== null` acima existe pra histórico anterior à
     * migração 0015 — mas a 0021 preencheu tudo, então uma linha confirmada sem
     * o valor hoje só aparece por escrita parcial. Sem isto ela ficava isenta
     * das duas conferências, em silêncio.
     */
    if (confirmadoLinha === null && row.status === 'confirmado') {
      // `info`: o DINHEIRO desta linha continua conferido pela divergência
      // total logo abaixo (o bruto entra na soma). O que falta aqui é a
      // conferência por txid, e isso é higiene de dado, não dinheiro perdido —
      // subir o tom faria toda linha anterior à 0015 acender o alerta diário,
      // que é como um canário morre.
      add('info', 'confirmed_amount_missing',
        `txid ${txid}: linha confirmada sem valor confirmado (anterior à 0015, ou escrita parcial)`,
        { txid });
    }
    /**
     * CONFIRMADA SEM DATA — invisível pra casa e pra perna de custódia.
     *
     * `getPanelView` e `listRecentConfirmedCharges` filtram por
     * `confirmed_at`, e o funil também. Uma linha `confirmado` com a data nula
     * some do faturamento, some da base de gorjeta e nunca chega à conferência
     * de destino — com o canário verde, porque nenhum achado olhava a DATA:
     * `confirmed_amount_missing` só dispara quando o VALOR é nulo.
     *
     * A 0021 reprojetou `confirmed_amount_cents` e `confirmed_tip_cents` e
     * nunca escreveu `confirmed_at`, então a premissa "a 0021 preencheu tudo"
     * valia pra duas das três colunas. Detector, não conserto: o escopo do
     * reparo não cresce. (HIGH-C da revisão de compliance de 2026-09-09.)
     */
    // Só onde a PROJEÇÃO existe e a data não: é exatamente a população da 0021,
    // que reprojetou as duas colunas de valor e nunca escreveu a data. Linha
    // sem valor confirmado já tem o seu achado (`confirmed_amount_missing`), e
    // acusar as duas coisas na mesma linha é barulho, não informação.
    if (row.status === 'confirmado' && confirmadoLinha !== null && !row.confirmedAt) {
      add('high', 'confirmed_at_missing',
        `txid ${txid}: linha confirmada SEM data — fora do faturamento, da gorjeta e da conferência de destino`,
        { txid });
    }
    const fullyRefunded = pay.refundedAmountCents === pay.amountCents && pay.refundedTipCents === pay.tipCents;
    if (fullyRefunded && row.status !== 'devolvido') {
      add('high', 'status_lag',
        `txid ${txid} fully refunded in log but row status is '${row.status}'`, { txid });
    }
    if (!fullyRefunded && row.status !== 'confirmado') {
      add('high', 'status_lag',
        `txid ${txid} confirmed in log but row status is '${row.status}'`, { txid });
    }
    // O ESTORNO PARCIAL também tem que bater entre a linha e o log. É a mesma
    // ideia do `amount_mismatch`, no valor devolvido: sem isto a linha podia
    // dizer que devolveu 500 e o razão 900, e a soma líquida do painel
    // divergiria do razão sem nada acusar.
    const rowRefunded = (row.refundedAmountCents || 0) + (row.refundedTipCents || 0);
    const logRefunded = pay.refundedAmountCents + pay.refundedTipCents;
    if (rowRefunded !== logRefunded) {
      add('critical', 'refund_mismatch',
        `txid ${txid}: estornado na linha ${rowRefunded}¢ vs razão ${logRefunded}¢`, { txid });
    }
  }

  // 3. Every confirmed payments row must have a matching event-log payment
  //    (a webhook that hit the payments table but never appended = lost money
  //    from the check's derived state).
  let rowConfirmedCents = 0;
  for (const row of rows) {
    if (row.status === 'confirmado') {
      // LÍQUIDO de estorno, igual ao lado do razão.
      //
      // Somar o bruto fazia o estorno parcial virar `ledger_drift` CRÍTICO
      // permanente: o razão já descontava o estorno de `paidCents` e a linha
      // não. Um alerta que dispara em comportamento correto está morto em duas
      // semanas — o mesmo modo de falha da disputa que nunca encerrava.
      // O CONFIRMADO, com o pedido só como histórico (linha anterior à 0015).
      // Somar o pedido fazia a segunda contagem discordar da primeira em todo
      // pagamento a menor, e a discordância virava `ledger_drift` crítico.
      const bruto = Number.isFinite(row.confirmedAmountCents)
        ? (row.confirmedAmountCents || 0) + (row.confirmedTipCents || 0)
        : (row.amountCents || 0) + (row.tipCents || 0);
      rowConfirmedCents += bruto
        - (row.refundedAmountCents || 0) - (row.refundedTipCents || 0);
      if (!logPayments[row.txid]) {
        add('critical', 'missing_log_event',
          `txid ${row.txid} is a confirmed payment row but absent from the event log`, { txid: row.txid });
      }
    }
  }

  // 4. The bottom line: two independent tallies of confirmed money must match.
  const driftCents = rowConfirmedCents - logConfirmedCents;
  if (driftCents !== 0) {
    add('critical', 'ledger_drift',
      `confirmed-money drift: payments table ${rowConfirmedCents}¢ vs event log ${logConfirmedCents}¢ (Δ ${driftCents}¢)`,
      { driftCents });
  }

  return {
    checkId,
    /**
     * `ok` é AUSÊNCIA DE PROBLEMA, não ausência de achado.
     *
     * Era `findings.length === 0`, e desde que a conciliação passou a registrar
     * fatos do negócio como `info` — um Pix pago a menor, uma linha antiga sem
     * valor confirmado — isso marcava como não-ok contas onde nada está
     * errado. E `checksFailed` já contava só o acionável, então as duas
     * medidas da mesma ideia discordavam entre si.
     *
     * Os achados `info` continuam TODOS em `findings`: eles existem pra serem
     * lidos, só não pra acender o alerta.
     */
    ok: !findings.some((f) => f.severity === 'critical' || f.severity === 'high'),
    driftCents,
    findings,
  };
}

/**
 * Reconcile every check of a venue via the store. Returns the venue roll-up
 * plus per-check results that failed. Store must implement
 * listChecksForReconcile(venueId) → [{ checkId, events, payments }].
 */
/**
 * A TESTEMUNHA AGREGADA: o serviço que a casa cobra e nunca arrecada.
 *
 * Nenhuma faixa por pagamento consegue separar os dois casos que importam,
 * porque eles dão o MESMO número: o serviço é 10%, então quem recusa a linha
 * opcional paga `pedido / 1,1` — e um adaptador que passe a ler o campo errado
 * (`receivedCents` depois de uma virada de versão da API) confirma exatamente
 * isso, em todo pagamento. Como a coluna confirmada e o razão saem da mesma
 * variável na mesma chamada, os dois concordam, e a divergência com o valor
 * pedido sai como `info` por ser do tamanho do serviço.
 *
 * O que distingue não é o tamanho, é a FREQUÊNCIA. Cem pessoas recusando o
 * serviço no mesmo dia não é fato do negócio; é um adaptador. Então o olho
 * fica aqui, no agregado do restaurante — que é onde a diferença entre cobrado
 * e arrecadado já existia como número no painel, e não estava ligada em
 * canário nenhum. Achado pela revisão de segurança de 2026-09-08.
 *
 * @returns {Array} achados no nível do restaurante
 */
function acharServicoNuncaArrecadado(inputs) {
  let cobrado = 0;
  let arrecadado = 0;
  let pagamentos = 0;
  for (const inp of inputs) {
    for (const row of inp.payments || []) {
      if (row.status !== 'confirmado') continue;
      pagamentos += 1;
      cobrado += row.tipCents || 0;
      arrecadado += Number.isFinite(row.confirmedTipCents)
        ? row.confirmedTipCents : (row.tipCents || 0);
    }
  }
  // Amostra pequena não diz nada: três mesas tirando o serviço numa terça é
  // uma terça.
  if (pagamentos < 8 || cobrado === 0) return [];
  if (arrecadado === 0) {
    return [{
      severity: 'high',
      code: 'service_never_collected',
      message: `${pagamentos} pagamentos confirmados, ${cobrado}¢ de serviço cobrado e ZERO arrecadado`
        + ' — recusa em massa não existe; conferir a leitura do valor pago',
      chargedTipCents: cobrado, collectedTipCents: arrecadado, payments: pagamentos,
    }];
  }
  return [];
}

/**
 * Teto de reparos por varredura. Atraso sistemático é BUG, não soluço: passar
 * disto, o certo é um humano olhar a causa, não a varredura reprojetar mil
 * linhas no escuro.
 */
const TETO_DE_REPAROS = 200;
/** Acima disto o reparo deixa de ser `info` e passa a pedir gente. */
const REPAROS_DEMAIS = 3;

/**
 * O REPARO TEM TESTEMUNHA — senão a varredura conserta e reporta verde.
 *
 * A varredura passou a ESCREVER em `payments`, em toda casa, toda noite, sem
 * ninguém olhando. E o relatório saía idêntico a uma noite em que ela não fez
 * nada: `reconcileOneVenue` nunca lia `rowsRepaired`, o `formatReconcileAlert`
 * nunca falava dele, e o único rastro durável (`payment_repair_log`, migração
 * 0026) não é lido por nada. Um bug de projeção que se repete seria remendado
 * toda noite e reportado verde pra sempre — a forma exata dos 12 dias do
 * incidente do Seatable, e o oposto do que o cabeçalho deste módulo promete
 * ("ela grita e um humano decide").
 *
 * Achado pela revisão de segurança de 2026-09-09 (HIGH-2).
 */
/**
 * O SUMIDOURO vira números e achados — de UMA função, chamável de fora.
 *
 * Existe pra que o `catch` de quem chama produza exatamente o mesmo resumo que
 * o caminho feliz, a partir do mesmo objeto. Duas construções do relatório é
 * como um dos lados fica pra trás — foi assim que os contadores nasceram em
 * quatro lugares e faltaram no quinto.
 */
/**
 * ESTE CÓDIGO PROVA QUE NADA FOI ESCRITO?
 *
 * "Tem SQLSTATE" NÃO basta, e a diferença decide dinheiro. O PostgREST devolve
 * o SQLSTATE cru, e há classes inteiras emitidas JUSTAMENTE PORQUE a conexão ou
 * o backend morreram — ou seja, o estado fica EM DÚVIDA, não em rollback:
 *
 *   `08*`   (`08006 connection_failure`, `08003`) — o elo caiu. Se caiu depois
 *           do COMMIT e antes de o PostgREST ler o resultado, a linha ESTÁ
 *           escrita.
 *   `57P01` `57P02` `57P03` — backend terminado (manutenção do Supabase,
 *           failover). Terminar durante o COMMIT é o caso clássico de dúvida.
 *   `XX*`   (`XX000 internal_error`).
 *
 * E não dá pra excluir a classe 57 inteira: `57014 statement timeout` é a
 * recusa mais comum de verdade, e essa É rollback.
 *
 * Então: lista de permissão por forma, exclusão por classe, e o resto cai no
 * lado conservador (`ackLost`, "pode ter escrito"). Errar pra cá custa uma
 * conferência; errar pro outro lado faz o dono distribuir pelo número antigo e
 * maior, e o CLT art. 462 não deixa descontar depois.
 *
 * Achado pela revisão de segurança de 2026-09-09 (HIGH-2), que leu o
 * `postgrest-js` 2.110.7 em vez de deduzir.
 */
const EM_DUVIDA = [/^08/, /^57P0/, /^XX/];
function recusaProvada(codigo) {
  if (typeof codigo !== 'string' || !codigo) return false;
  // `PGRST116` vem anexado a uma resposta 2xx — depois de um commit bem
  // sucedido. Nunca é prova de que nada foi escrito.
  if (/^PGRST/.test(codigo)) return false;
  if (!/^[0-9A-Z]{5}$/.test(codigo)) return false;
  return !EM_DUVIDA.some((re) => re.test(codigo));
}

function resumoDoReparo(pia = {}) {
  const reparados = pia.repaired || [];
  const corridas = pia.raced || [];
  const ackPerdido = pia.ackLost || [];
  const rejeitados = pia.rejected || [];
  const gorjeta = pia.tip || [];
  return {
    reparadas: reparados.length,
    corridas: corridas.length,
    ackPerdidos: ackPerdido.length,
    rejeitados: rejeitados.length,
    achados: acharReparos(reparados, pia.skipped || 0, gorjeta, corridas, ackPerdido, rejeitados),
    // Os achados de AGREGADO (serviço nunca arrecadado) vivem na pia também,
    // pra que o `catch` monte a lista de UMA fonte. Ver `reconcileVenue`.
    venueFindings: pia.venueFindings || [],
  };
}

function acharReparos(reparados, naoOlhadas, gorjeta = [], corridas = [], ackPerdido = [], rejeitados = []) {
  const achados = [];
  /**
   * RECUSADO pelo banco — `high`, e a afirmação é firme: nada foi escrito.
   *
   * Esta é a metade classificável do que antes virava tudo "pode ter escrito".
   * Grant revogado, assinatura trocada, `42703`: o servidor respondeu, a
   * transação caiu, a projeção segue atrás do razão. É a mensagem antiga —
   * agora dita só quando é verdade, e com um guarda que dispara de fato.
   */
  if (rejeitados.length > 0) {
    achados.push({
      severity: 'high',
      code: 'payment_row_repair_rejected',
      message: `${rejeitados.length} reparo(s) RECUSADOS pelo banco — nada foi escrito, a projeção segue atrás do razão`,
      txids: rejeitados.slice(0, 10),
      rejected: rejeitados.length,
    });
  }
  /**
   * NÃO SEI SE ESCREVEU — `high`, e diz isso.
   *
   * A RPC pode ter dado commit com a resposta perdida. O achado tem que
   * carregar a dúvida, não resolvê-la pro lado otimista nem pro pessimista, e
   * tem que carregar a GORJETA — senão a base da folha se move sem testemunha
   * sempre que a rede pisca. (HIGH-1 da revisão de segurança de 2026-09-09.)
   */
  if (ackPerdido.length > 0) {
    const somaAck = ackPerdido.reduce((s, g) => s + (g.deltaCents || 0), 0);
    const periodosAck = [...new Set(ackPerdido.map((g) => g.periodo).filter(Boolean))].sort();
    achados.push({
      severity: 'high',
      code: 'payment_repair_ack_lost',
      message: `${ackPerdido.length} reparo(s) sem resposta do banco — PODE ter escrito`
        + (somaAck !== 0
          ? `, incluindo ${somaAck}¢ na base da folha de ${periodosAck.join(', ')}; confira a linha antes de fechar`
          : '; confira a linha'),
      txids: ackPerdido.slice(0, 10).map((g) => g.txid),
      tipDeltaCents: somaAck,
      periods: periodosAck,
      uncertain: ackPerdido.length,
    });
  }
  if (corridas.length > 0) {
    // `info`: a linha mudou porque OUTRO caminho a projetou. Isso é o sistema
    // funcionando, não um achado de dinheiro — mas fica dito, porque uma
    // escrita que virou no-op sem registro nenhum é como se começa a confiar
    // num guarda que nunca dispara.
    achados.push({
      severity: 'info',
      code: 'payment_row_repair_raced',
      message: `${corridas.length} reparo(s) não pegaram — a linha foi projetada por outro caminho antes`,
      txids: corridas.slice(0, 10),
      raced: corridas.length,
    });
  }
  /**
   * A BASE DA FOLHA mexeu — `high` no PRIMEIRO, sem esperar contagem.
   *
   * Ver a justificativa longa em `repararLinhasAtrasadas`: CLT art. 457 §§ e
   * art. 462, STJ Tema 1102. Um reparo de principal ou de status pode esperar
   * a contagem; este não, porque a casa distribui a gorjeta e não a
   * desdistribui.
   */
  if (gorjeta.length > 0) {
    const soma = gorjeta.reduce((s, g) => s + g.deltaCents, 0);
    const periodos = [...new Set(gorjeta.map((g) => g.periodo))].sort();
    achados.push({
      severity: 'high',
      code: 'payment_tip_base_repaired',
      message: `${gorjeta.length} linha(s) tiveram a GORJETA reprojetada do razão `
        + `(${soma >= 0 ? '+' : ''}${soma}¢ na base da folha) — confira a folha de ${periodos.join(', ')}`,
      txids: gorjeta.slice(0, 10).map((g) => g.txid),
      tipDeltaCents: soma,
      periods: periodos,
      repaired: gorjeta.length,
    });
  }
  if (reparados.length > 0) {
    achados.push({
      severity: reparados.length > REPAROS_DEMAIS ? 'high' : 'info',
      code: 'payment_row_repaired',
      message: `${reparados.length} linha(s) de pagamento reprojetada(s) do razão`
        + (reparados.length > REPAROS_DEMAIS ? ' — atraso sistemático, olhe a causa' : ''),
      txids: reparados.slice(0, 10),
      repaired: reparados.length,
    });
  }
  if (naoOlhadas > 0) {
    achados.push({
      severity: 'high',
      code: 'payment_rows_unrepaired',
      message: `${naoOlhadas} linha(s) não foram nem olhadas (prazo da varredura ou teto de reparos)`,
      skipped: naoOlhadas,
    });
  }
  return achados;
}

/**
 * A LINHA QUE FICOU ATRÁS DO RAZÃO — só nas colunas de ESTORNO, e só isso.
 *
 * ESCOPO, e por que ele encolheu tanto.
 *
 * Este reparo existe por UM caso: uma restituição fora do trilho entra no razão,
 * a projeção da linha falha, e nasce um `refund_mismatch` + `ledger_drift`
 * CRÍTICO PERMANENTE por uma dívida corretamente quitada. Não há webhook pra
 * reentregar, então `repairRowFromLedger` nunca chega, e um canário que grita
 * pra sempre morre.
 *
 * Nesse caso a linha tem `status` certo, `confirmed_*` certo, e só `refunded_*`
 * atrasado. Mas eu escrevi o reparo pra reprojetar as CINCO colunas que a RPC
 * escreve, e três revisões seguidas acharam bloqueador dentro dele:
 *
 *  - a guarda somava duas colunas e escrevia cinco, então uma linha À FRENTE
 *    passava por "atrás" e o reparo APAGAVA um evento de devolução perdido;
 *  - virando `status` pra `confirmado` sem `confirmed_at`, a linha sumia de
 *    `getPanelView`, de `listRecentConfirmedCharges` e do funil — dinheiro
 *    ausente dos livros da casa e cobrança fora da perna de custódia, PRA
 *    SEMPRE, com o canário verde;
 *  - `devolvido → confirmado` era um rebaixamento sem guarda nenhuma, e devolvia
 *    a gorjeta estornada pra base da folha. A migração 0021 faz exatamente esse
 *    flip e o trata como o comando de maior risco do arquivo: rodado à mão, com
 *    imagem anterior, dizendo "REVER A FOLHA do periodo" e "o restaurante
 *    PRECISA ser avisado". A varredura fazia igual, sozinha, de madrugada, em
 *    `info`, justo nas linhas que a 0021 EXCLUI de propósito.
 *
 * Três consertos aumentaram a superfície. Este a corta: o reparo escreve as
 * DUAS colunas de estorno, e só quando todo o resto da linha já bate com o
 * razão. Fecha o caso que motivou a coisa e não pode fazer mais nada.
 *
 *  - `status` nunca é escrito → o rebaixamento não existe;
 *  - `confirmed_*` nunca é escrito → não há linha sem `confirmed_at`, e a
 *    divergência de confirmação segue sendo `amount_mismatch`/`tip_mismatch`,
 *    CRÍTICOS, decididos por gente;
 *  - a linha nunca projetada (`confirmed_*` nulo) não é reparável: ela é o
 *    caso de risco da 0021 e continua sendo achado.
 *
 * O que ele NÃO cobre volta a ser o que sempre foi: achado alto, e um humano
 * decide. É o que o cabeçalho do `reconcile-daily` promete.
 */
async function repararLinhasAtrasadas(store, inputs, opts = {}) {
  // De UMA forma, como o `base` do relatório: montar à mão foi como os
  // contadores nasceram em quatro lugares e faltaram no quinto. Faltavam aqui
  // `rejeitados` e `venueFindings` — a mesma "três de quatro".
  const vazio = resumoDoReparo({});
  if (typeof store.repairPaymentRow !== 'function') return vazio;
  /**
   * O SUMIDOURO — a testemunha não depende de esta função RETORNAR.
   *
   * O conserto anterior tirou o `reconcileVenue` do `Promise.all` pra que a
   * escrita sobrevivesse a uma perna IRMÃ que estourasse. Mas `reparo` só é
   * atribuído quando esta função resolve, então um lance de DENTRO dela — um
   * `reduce()` que estoura na conta seguinte, depois de já ter escrito —
   * apagava os contadores do mesmo jeito. Medido: `escritas: ["ch_1"]`,
   * `rowsRepaired: 0`, código `venue_reconcile_threw`.
   *
   * Com o sumidouro, quem chama lê o que já aconteceu mesmo que a gente exploda
   * no meio. A invariante deixa de depender de enumerar o que pode estourar —
   * que é a diferença entre conserto de instância e conserto de classe.
   * (MEDIUM-2 da revisão de segurança de 2026-09-09.)
   */
  const pia = opts.witness || {};
  // ZERADO A CADA INVOCAÇÃO. Era `pia.x = pia.x || []`, que ACUMULA se alguém
  // reusar o mesmo `opts` — e a retentativa que vai ser acrescentada é
  // justamente pro "5xx transitório" que estes comentários vivem descrevendo.
  // Medido: duas chamadas com o mesmo `opts` davam `rowsRepaired` 1 e depois 2,
  // e a soma de centavos da gorjeta dobrava junto.
  pia.repaired = [];
  pia.raced = [];
  pia.ackLost = [];
  pia.rejected = [];
  pia.tip = [];
  const reparados = pia.repaired;
  /**
   * CORRIDA PERDIDA não é falha.
   *
   * `false` deste claim quer dizer que a linha MUDOU entre a leitura e a
   * escrita — sob concorrência é o desfecho benigno, e o chamador irmão já diz
   * isso por escrito ("Perder a corrida é NORMAL e não é erro: a outra entrega
   * sabia mais"). Contando como falha, um webhook que pousasse no meio da
   * varredura e projetasse a linha CORRETAMENTE produzia um `high` afirmando
   * que a projeção está atrás do razão — quando ela acabara de ficar em dia.
   * Uma corrida benigna virava um `high` e dois `critical`, todos falsos, no
   * único alerta que o inegociável #8 diz que não pode ser ignorável.
   * (MEDIUM-1 da revisão de segurança de 2026-09-09.)
   */
  const corridasPerdidas = pia.raced;
  /** Os que mexeram na BASE DA FOLHA — severidade própria, ver `acharReparos`. */
  const mexeramNaGorjeta = pia.tip;
  /** Escreveu ou não? Não dá pra saber — ver o `catch`. */
  const ackPerdido = pia.ackLost;
  /** RECUSADOS pelo banco: SQLSTATE = resposta completa = rollback. */
  const rejeitados = pia.rejected;
  let naoOlhadas = 0;
  let cortou = false;

  for (const inp of inputs) {
    if (cortou) break;
    const estado = reduce(inp.events || []);
    for (const row of inp.payments || []) {
      const pay = estado && estado.payments[row.txid];
      if (!pay) continue;

      /**
       * CANDIDATA primeiro, PRAZO depois.
       *
       * A conferência de prazo estava no topo do laço, antes de saber se a
       * linha era sequer reparável — então, estourado o prazo, TODA linha de
       * TODA casa restante entrava em `payment_rows_unrepaired` (`high`) e a
       * casa saía vermelha. Com 90s globais e a perna de recebíveis
       * consumindo o seu, isso disparava lá pela quinta casa: o alerta noturno
       * viraria "N de M restaurantes com divergência" com quase nenhuma
       * divergência — a morte por alerta que o inegociável #8 descreve.
       * (MEDIUM-1 da revisão de segurança de 2026-09-09.)
       */
      const atrasada = (row.refundedAmountCents || 0) < pay.refundedAmountCents
        || (row.refundedTipCents || 0) < pay.refundedTipCents;
      if (!atrasada) continue;

      /**
       * O RESTO DA LINHA tem que bater com o razão. Este reparo é de estorno.
       *
       * Nunca projetada (`confirmed_*` nulo) NÃO é reparável aqui: é a
       * população que a 0021 exclui à mão, e mexer nela é decisão de gente.
       * `status` divergente idem — `status_lag` já é `high` e diz melhor.
       */
      if (row.confirmedAmountCents !== pay.amountCents) continue;
      if (row.confirmedTipCents !== pay.tipCents) continue;
      if (row.status !== 'confirmado') continue;
      // À FRENTE em qualquer perna: o razão é que perdeu um evento, e
      // reprojetar apagaria a evidência.
      if ((row.refundedAmountCents || 0) > pay.refundedAmountCents) continue;
      if ((row.refundedTipCents || 0) > pay.refundedTipCents) continue;

      // Só agora custa alguma coisa: uma chamada de RPC por linha.
      if (Number.isFinite(opts.deadline) && Date.now() > opts.deadline) { naoOlhadas += 1; cortou = true; break; }
      // TETO conta TENTATIVAS, não sucessos. Com um grant revogado ou a
      // assinatura trocada — a classe do inegociável #7 — o laço gastava a
      // varredura inteira em escritas que falhavam e o teto nunca engatava.
      // TENTATIVAS, nas quatro saídas: reparo, corrida, resposta perdida e o
      // que quer que seja classificável. Contando só sucesso, uma RPC que só
      // estoura gastava a varredura inteira sem nunca engatar o corte.
      const tentativas = reparados.length + corridasPerdidas.length + ackPerdido.length + rejeitados.length;
      if (tentativas >= TETO_DE_REPAROS) { naoOlhadas += 1; cortou = true; break; }

      /**
       * A GORJETA que este reparo vai MOVER — medida antes de escrever.
       *
       * `confirmedMoney` subtrai `refunded_tip_cents` direto, então lançar o
       * estorno de gorjeta MUDA o número que a casa leva pra folha. E esse
       * número, uma vez distribuído, não volta: CLT art. 462 proíbe o desconto
       * unilateral no salário do garçom. Lei 13.419/2017 (CLT art. 457 §§) põe
       * na casa o dever de escriturar por período; STJ Tema 1102 mantém a
       * gorjeta na base remuneratória. Severidade por COLUNA, não por
       * contagem: mexeu na gorjeta é `high` no primeiro.
       */
      const deltaGorjeta = (row.refundedTipCents || 0) - pay.refundedTipCents;
      // O PERÍODO vai junto. `listChecksForReconcile` não tem recorte de data,
      // então a varredura olha a história inteira da casa: sem isto a mensagem
      // dizia "confira antes de fechar o período" sobre uma folha de sete meses
      // atrás. O dever de escrituração da Lei 13.419/2017 é POR PERÍODO —
      // dizer que um número mexeu sem dizer qual mês não é acionável.
      // Calculado FORA do `try` porque o `catch` também precisa dele: uma
      // resposta perdida pode ter mexido na folha.
      const periodo = String(row.confirmedAt || '').slice(0, 7) || 'sem data';

      try {
        const ok = await store.repairPaymentRow({
          txid: row.txid,
          expectedStatus: row.status,
          expectedRefundedAmountCents: row.refundedAmountCents || 0,
          expectedRefundedTipCents: row.refundedTipCents || 0,
          // `status` e `confirmed_*` vão de volta COMO FORAM LIDOS: a RPC
          // escreve as cinco colunas, e reescrever o mesmo valor é a única
          // forma de não mexer nelas sem mudar a assinatura da 0023.
          status: row.status,
          confirmedAmountCents: row.confirmedAmountCents,
          confirmedTipCents: row.confirmedTipCents,
          refundedAmountCents: pay.refundedAmountCents,
          refundedTipCents: pay.refundedTipCents,
          // Procedência pro log de reparo (migração 0029): a varredura
          // noturna, sem operador presente.
          source: 'reconciler_sweep',
        });
        if (ok) {
          reparados.push(row.txid);
          if (deltaGorjeta !== 0) mexeramNaGorjeta.push({ txid: row.txid, deltaCents: deltaGorjeta, periodo });
        } else {
          // A linha mudou entre a leitura e o claim, ou sumiu. Contado — uma
          // escrita de dinheiro que vira no-op sem testemunha é como a
          // degradação silenciosa começa (inegociável #7) — mas como CORRIDA,
          // não como falha: quem venceu sabia mais.
          corridasPerdidas.push(row.txid);
          process.stderr.write(`[reconcile] reparo da linha ${row.txid} não pegou: a linha mudou desde a leitura\n`);
        }
      } catch (e) {
        /**
         * NÃO SEI SE ESCREVEU — e é isso que o relatório tem que dizer.
         *
         * A RPC pode ter feito COMMIT e a resposta ter se perdido: socket
         * resetado, timeout no retorno, a Vercel matando o fetch. A linha foi
         * escrita e este `catch` roda. Classificar isso como "falhou" produzia
         * uma afirmação FALSA na direção contrária — "a projeção segue atrás do
         * razão" sobre uma linha que acabou de ser projetada — e mandava o
         * operador caçar um travamento que não existe. Pior: o
         * `payment_tip_base_repaired` vive no ramo do sucesso, então
         * `refunded_tip_cents` (a base da folha, CLT art. 462) podia se mover
         * com testemunha NENHUMA.
         *
         * Então a gorjeta é registrada aqui também, e o achado próprio diz a
         * verdade: pode ter escrito, pode não ter. (HIGH-1 da revisão de
         * segurança de 2026-09-09.)
         */
        /**
         * SQLSTATE quer dizer que o servidor RESPONDEU — logo, rollback.
         *
         * "Não dá pra classificar o lance" é falso pra uma classe grande: se o
         * Postgres devolveu um código, a transação foi desfeita e NADA foi
         * escrito. Tratar isso como "pode ter escrito" afirmava um movimento na
         * base da folha que provadamente não houve — com centavos e mês, e sob
         * causa sistemática (grant revogado, assinatura trocada) até 200 linhas
         * por casa, toda noite. Falso na direção oposta ao HIGH-1, na mesma
         * coluna. (MEDIUM-1 da revisão de segurança de 2026-09-09.)
         */
        if (recusaProvada(e && e.pgCode)) {
          rejeitados.push(row.txid);
          process.stderr.write(`[reconcile] reparo da linha ${row.txid} RECUSADO pelo banco (${e.pgCode}), nada escrito: ${String(e && e.message).slice(0, 120)}\n`);
        } else {
          // `e && e.message`: uma rejeição com valor não-objeto estourava um
          // TypeError DE DENTRO do catch, e aí sim a varredura caía (LOW-5).
          ackPerdido.push({ txid: row.txid, deltaCents: deltaGorjeta, periodo });
          process.stderr.write(`[reconcile] reparo da linha ${row.txid}: resposta perdida — pode ter escrito: ${String(e && e.message).slice(0, 120)}\n`);
        }
      }
    }
  }
  pia.skipped = naoOlhadas;
  return resumoDoReparo(pia);
}

async function reconcileVenue(store, venueId, opts = {}) {
  let inputs = await store.listChecksForReconcile(venueId);
  /**
   * A ESCRITA É OPT-IN. Quem não pede, não escreve.
   *
   * Era `opts.repair === false` pra desligar — e portanto LIGADA por omissão.
   * Consertei o `/api/house/admin`, esqueci o `/api/panel`, e afirmei que "o
   * cron é o único que repara". A rota do painel seguiu escrevendo em linha de
   * dinheiro (inclusive `confirmed_tip_cents`, base da folha), autenticada como
   * dono, recarregando a cada 4s, sem prazo, e mostrando "tudo bate" na mesma
   * carga. Dois consertos pontuais e dois esquecimentos: o problema não era a
   * rota, era o PADRÃO.
   *
   * Agora só `reconcileAllVenues` — a varredura noturna, que tem prazo, teto e
   * testemunha no relatório — pede a escrita. Qualquer chamador novo nasce
   * lendo. Achado pela revisão de compliance de 2026-09-09 (CRITICAL-1).
   */
  // O SUMIDOURO é criado AQUI e passado adiante: quem chamou `reconcileVenue`
  // pode lê-lo pelo mesmo objeto, mesmo que esta função exploda no meio.
  const pia = opts.witness || {};
  const reparo = opts.repair === true
    ? await repararLinhasAtrasadas(store, inputs, { ...opts, witness: pia })
    : { reparadas: 0, corridas: 0, ackPerdidos: 0, rejeitados: 0, achados: [] };
  /**
   * A RELEITURA falha sem derrubar a casa.
   *
   * Ela só acontece nas noites em que houve escrita, é uma ida a mais ao banco,
   * e estava crua: um 5xx transitório nela — a classe exata de transitório que
   * este reparo existe pra consertar — virava `venue_reconcile_threw` e a casa
   * inteira saía como "não deu pra conciliar". Releitura que falha quer dizer
   * que o RELATÓRIO está velho, não que o restaurante é inconciliável.
   *
   * E vale pra corrida perdida também: numa noite em que só houve corrida, a
   * outra escrita PEGOU, e julgar sobre a leitura antiga acusa `refund_mismatch`
   * numa linha que já está certa. (HIGH-1 e MEDIUM-1 da revisão de segurança de
   * 2026-09-09.)
   */
  if (reparo.reparadas > 0 || reparo.ackPerdidos > 0 || reparo.corridas > 0 || reparo.rejeitados > 0) {
    try { inputs = await store.listChecksForReconcile(venueId); }
    catch (e) {
      process.stderr.write(`[reconcile] releitura pós-reparo falhou (relatório fica velho): ${String(e.message).slice(0, 120)}\n`);
    }
  }
  /**
   * O AGREGADO ENTRA NA PIA ANTES DO `map`.
   *
   * `daCasa` só precisa de `inputs`. Calculado depois do `inputs.map(...)`, um
   * lance dentro do `reconcileCheck` — o cenário do `reduce()` que a pia foi
   * construída pra cobrir — perdia o achado de agregado outra vez.
   */
  const daCasa = acharServicoNuncaArrecadado(inputs);
  pia.venueFindings = daCasa;
  const results = inputs.map(reconcileCheck);
  /**
   * OS ACHADOS DE AGREGADO ENTRAM NO SUMIDOURO — uma fonte, não duas.
   *
   * O `catch` de quem chama passou a montar os achados de `resumo.achados`, que
   * é só do reparo. Antes ele usava `checks.venueFindings`, que é
   * `[...daCasa, ...reparo.achados]` — então o `service_never_collected` sumiu
   * do caminho de erro. Medido: com a perna da casa estourando, o `82511a3`
   * relatava `venue_reconcile_threw` + `service_never_collected`; o `fe9c845`
   * relatava só o primeiro.
   *
   * O estrago é o de sempre: uma noite em que o restaurante está perdendo 10%
   * em toda conta vira uma linha que diz "supabase 503". E `venues[]` descarta
   * `findings`, então nem do JSON dá pra recuperar.
   *
   * Pela pia, não por um `||` no chamador: dois jeitos de montar a mesma lista
   * é exatamente o que a pia existe pra impedir. (HIGH-1 da revisão de
   * segurança de 2026-09-09.)
   */
  const severityRank = { critical: 3, high: 2, info: 1 };
  /**
   * FALHOU é achado ACIONÁVEL, não achado qualquer.
   *
   * Um Pix pago a menor produz um achado `info` — pedido ≠ recebido, um fato
   * do negócio (ver `underpayment` acima). Contá-lo como falha faria o
   * `/api/house/admin` reportar a casa como não-ok, e todo painel que mostra
   * "N contas com problema" mostraria contas onde nada está errado. O canário
   * diário já não fica vermelho com `info`; esta contagem passa a concordar
   * com ele.
   */
  const acionavel = (r) => r.findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  const failed = results.filter(acionavel);
  const worst = [...results.flatMap((r) => r.findings), ...daCasa, ...reparo.achados]
    .reduce((max, f) => Math.max(max, severityRank[f.severity] || 0), 0);
  return {
    venueId,
    // Achados do RESTAURANTE, não de uma conta: eles só existem no agregado.
    // Os do REPARO entram aqui de propósito: é por `venueFindings` que
    // `reconcileOneVenue` já leva achado pro relatório e pro alerta do fundador.
    venueFindings: [...daCasa, ...reparo.achados],
    /** Quantas linhas a varredura reprojetou do razão nesta passada. */
    rowsRepaired: reparo.reparadas,
    /**
     * CORRIDA PERDIDA e SEM RESPOSTA — as outras duas saídas.
     *
     * O contador de corrida morria nesta fronteira: `repararLinhasAtrasadas` o
     * produzia e `reconcileVenue` não o devolvia, então o achado `info` era
     * criado e jogado fora pelo relatório. Um comentário que diz "fica dito" e
     * um número que não atravessa a função é pior que não contar.
     *
     * E "falhou" não é saída: não dá pra distinguir um erro de um commit cuja
     * resposta se perdeu, então o contador que só sabia dizer zero deu lugar a
     * `rowsRepairAckLost`, que carrega a dúvida em vez de resolvê-la.
     */
    rowsRepairRaced: reparo.corridas,
    rowsRepairAckLost: reparo.ackPerdidos,
    rowsRepairRejected: reparo.rejeitados,
    checksChecked: results.length,
    checksFailed: failed.length,
    totalDriftCents: results.reduce((s, r) => s + Math.abs(r.driftCents), 0),
    worstSeverity: ['ok', 'info', 'high', 'critical'][worst],
    failed,
  };
}

/**
 * House-account cross-check: the append-only ledger (reduced) vs the
 * operational balances the locked RPCs maintain (supabase). `stored: null`
 * (memory store) skips the column comparison — there is nothing independent
 * to compare. PURE and TOTAL.
 */
function reconcileHouseAccount({ accountId, events, stored }) {
  const findings = [];
  const add = (severity, code, msg, extra = {}) =>
    findings.push({ severity, code, message: msg, ...extra });

  let state;
  try {
    state = houseState.reduce(events || []);
  } catch (err) {
    add('critical', 'house_reduce_threw', `house ledger could not be reduced: ${err.message}`);
    return { accountId, ok: false, findings, state: null };
  }

  for (const a of state ? state.anomalies : []) {
    add('high', 'house_log_anomaly', `house-ledger anomaly: ${a.reason}`, { seq: a.seq, type: a.type });
  }

  if (state && stored) {
    if (stored.principalCents !== state.principalCents) {
      add('critical', 'house_principal_drift',
        `principal: stored ${stored.principalCents}¢ vs ledger ${state.principalCents}¢`,
        { driftCents: stored.principalCents - state.principalCents });
    }
    const storedBySeq = new Map((stored.lots || []).map((l) => [l.seq, l]));
    for (const lot of state.lots) {
      const s = storedBySeq.get(lot.seq);
      if (!s) {
        // A lot the ledger granted but the lots table lost — only meaningful
        // if the ledger still has bonus left in it.
        if (lot.remainingCents > 0) {
          add('critical', 'house_lot_missing',
            `bonus lot seq ${lot.seq} in ledger (${lot.remainingCents}¢ left) but not stored`);
        }
        continue;
      }
      if (s.remainingCents !== lot.remainingCents) {
        add('critical', 'house_lot_drift',
          `bonus lot seq ${lot.seq}: stored ${s.remainingCents}¢ vs ledger ${lot.remainingCents}¢`);
      }
      storedBySeq.delete(lot.seq);
    }
    for (const [seq, s] of storedBySeq) {
      if (s.remainingCents > 0) {
        add('critical', 'house_lot_unknown',
          `stored bonus lot seq ${seq} (${s.remainingCents}¢) has no granting ledger event`);
      }
    }
  }

  return { accountId, ok: findings.length === 0, findings, state };
}

/**
 * Venue-level house reconciliation: per-account checks PLUS the redeem ↔
 * payments-row chain (account ledger REDEEMED txids must be confirmed
 * house_account payment rows, and vice versa — together with reconcileCheck
 * this closes the loop account ledger ↔ payments ↔ check ledger).
 */
async function reconcileVenueHouse(store, venueId) {
  const accounts = await store.listHouseAccountsForReconcile(venueId);
  const results = accounts.map(reconcileHouseAccount);
  const venueFindings = [];

  const checkInputs = await store.listChecksForReconcile(venueId);
  const housePayRows = new Map();
  // Every txid that actually LANDED on a check ledger — the disambiguator
  // between the two mid-redeem crash permutations (review finding: the old
  // single message prescribed "re-credit" even when the check WAS paid,
  // which would hand the customer the meal AND the balance).
  const checkLedgerTxids = new Set();
  for (const ci of checkInputs) {
    for (const p of ci.payments || []) {
      if (p.method === 'house_account') housePayRows.set(p.txid, p);
    }
    let st = null;
    try { st = reduce(ci.events || []); } catch { st = null; }
    for (const txid of Object.keys(st ? st.payments : {})) checkLedgerTxids.add(txid);
  }

  const redeemTxids = new Set();
  for (const r of results) {
    if (!r.state) continue;
    for (const [txid, rd] of Object.entries(r.state.redeems)) {
      if (rd.reversed) continue; // compensated — correctly absent everywhere
      redeemTxids.add(txid);
      if (!housePayRows.has(txid)) {
        if (checkLedgerTxids.has(txid)) {
          venueFindings.push({
            severity: 'critical', code: 'house_redeem_missing_payment_row_paid',
            message: `redeem ${txid} paid the check but has no payments row — BACKFILL the row; do NOT re-credit account ${r.accountId}`,
            txid, accountId: r.accountId,
          });
        } else {
          venueFindings.push({
            severity: 'critical', code: 'house_redeem_missing_payment_row',
            message: `redeem ${txid} debited account ${r.accountId} but never reached the check — re-credit the customer (or replay the redeem)`,
            txid, accountId: r.accountId,
          });
        }
      }
    }
  }
  for (const [txid, row] of housePayRows) {
    if (row.status === 'confirmado' && !redeemTxids.has(txid)) {
      venueFindings.push({
        severity: 'critical', code: 'house_payment_row_without_redeem',
        message: `house payment row ${txid} has no REDEEMED ledger event (credit paid a check without a debit)`,
        txid,
      });
    }
  }

  const failed = results.filter((r) => !r.ok).map(({ state, ...rest }) => rest);
  return {
    venueId,
    accountsChecked: results.length,
    accountsFailed: failed.length,
    findings: venueFindings,
    failed,
    ok: failed.length === 0 && venueFindings.length === 0,
  };
}

module.exports = {
  acharServicoNuncaArrecadado, repararLinhasAtrasadas, resumoDoReparo, recusaProvada, reconcileCheck, reconcileVenue, reconcileHouseAccount, reconcileVenueHouse };
