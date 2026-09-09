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
 * A LINHA QUE FICOU ATRÁS DO RAZÃO — reparada aqui, e não deixada pra ninguém.
 *
 * Toda escrita de dinheiro faz dois passos: o razão (a verdade) e a linha de
 * `payments` (uma projeção). Entre os dois cabe uma falha, e até agora o único
 * dono desse conserto era a reentrega do webhook (`repairRowFromLedger`) — que
 * nunca chega numa restituição feita FORA do trilho, porque não há PSP pra
 * reenviar nada.
 *
 * O resultado era o pior possível: um 5xx transitório no meio de uma devolução
 * corretamente paga virava `refund_mismatch` + `ledger_drift` CRÍTICOS
 * PERMANENTES, e o alerta noturno passava a dizer "drift 90,00" pra sempre.
 * O cabeçalho do `reconcile-daily` diz, com razão, que ele não conserta — mas
 * ninguém consertava, e um canário que grita pra sempre morre.
 *
 * Então a conciliação passa a fechar a própria detecção: onde ela vê a linha
 * ATRÁS do razão, ela reprojeta. Claim CONDICIONAL com o erro conferido
 * (inegociável #7, migração 0023) — se a linha mudou desde a leitura, não
 * escreve e não mente. E só na direção segura: a linha é projeção do razão,
 * então escrever o que o razão diz não pode inventar dinheiro.
 *
 * Achado pela revisão de segurança de 2026-09-09 (HIGH-1).
 */
async function repararLinhasAtrasadas(store, inputs) {
  if (typeof store.repairPaymentRow !== 'function') return 0;
  let reparadas = 0;
  for (const inp of inputs) {
    const estado = reduce(inp.events || []);
    for (const row of inp.payments || []) {
      const pay = estado && estado.payments[row.txid];
      if (!pay) continue;
      const naLinha = (row.refundedAmountCents || 0) + (row.refundedTipCents || 0);
      const noRazao = pay.refundedAmountCents + pay.refundedTipCents;
      // Só quando a linha está ATRÁS: à frente é outra história (o razão é que
      // perdeu um evento) e reprojetar apagaria a evidência.
      if (naLinha >= noRazao) continue;
      const total = pay.refundedAmountCents === pay.amountCents
        && pay.refundedTipCents === pay.tipCents;
      try {
        const ok = await store.repairPaymentRow({
          txid: row.txid,
          expectedStatus: row.status,
          expectedRefundedAmountCents: row.refundedAmountCents || 0,
          expectedRefundedTipCents: row.refundedTipCents || 0,
          status: total ? 'devolvido' : 'confirmado',
          confirmedAmountCents: pay.amountCents,
          confirmedTipCents: pay.tipCents,
          refundedAmountCents: pay.refundedAmountCents,
          refundedTipCents: pay.refundedTipCents,
        });
        if (ok) reparadas += 1;
      } catch (e) {
        // Reparo é oportunista: falhar aqui não pode derrubar a varredura.
        process.stderr.write(`[reconcile] reparo da linha ${row.txid} falhou: ${String(e.message).slice(0, 120)}\n`);
      }
    }
  }
  return reparadas;
}

async function reconcileVenue(store, venueId) {
  let inputs = await store.listChecksForReconcile(venueId);
  // Repara ANTES de julgar, e relê: senão a varredura acusa a divergência que
  // ela mesma acabou de fechar, e a casa aparece vermelha por uma noite.
  const reparadas = await repararLinhasAtrasadas(store, inputs);
  if (reparadas > 0) inputs = await store.listChecksForReconcile(venueId);
  const results = inputs.map(reconcileCheck);
  const daCasa = acharServicoNuncaArrecadado(inputs);
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
  const worst = [...results.flatMap((r) => r.findings), ...daCasa]
    .reduce((max, f) => Math.max(max, severityRank[f.severity] || 0), 0);
  return {
    venueId,
    // Achados do RESTAURANTE, não de uma conta: eles só existem no agregado.
    venueFindings: daCasa,
    /** Quantas linhas a varredura reprojetou do razão nesta passada. */
    rowsRepaired: reparadas,
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
  acharServicoNuncaArrecadado, repararLinhasAtrasadas, reconcileCheck, reconcileVenue, reconcileHouseAccount, reconcileVenueHouse };
