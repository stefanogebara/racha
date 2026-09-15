'use strict';

/**
 * Check state machine — event-sourced, pure, and TOTAL.
 *
 * The append-only event log is the source of truth (rows in check_events);
 * this module derives state by folding events in seq order. Nothing here does
 * I/O. Money bugs must be replayable: given the same events, reduce() always
 * returns the same state.
 *
 * TOTALITY (review finding, 2026-07-17): reduce() NEVER throws on a stored
 * log. A raced or malformed event must not make real money unreadable — it is
 * recorded in state.anomalies and skipped. Strict validation happens at
 * APPEND time (validateEvent, called by the API before append_check_event,
 * which serializes appends per check with an advisory lock).
 *
 * Event types:
 *   OPENED             { totalCents }
 *   ADJUSTED           { totalCents }
 *   PAYMENT_CONFIRMED  { txid, amountCents, tipCents, method }   (at-least-once!)
 *   PAYMENT_REFUNDED   { txid, amountCents, tipCents }           (Pix devolução / MED)
 *   CLOSED             {}
 *
 * Money rules encoded:
 * - PAYMENT_CONFIRMED is idempotent by txid; a replay with DIFFERENT amounts
 *   is flagged (anomaly 'divergent_txid'), never absorbed silently.
 * - Consumption (amountCents) and tips (tipCents) are tracked SEPARATELY:
 *   tips are employee remuneration (Lei 13.419/2017); the payroll report
 *   reads them from here.
 * - Refunds reference the original txid and can never exceed what that txid
 *   paid (excess → anomaly, ignored).
 * - Overpayment is flagged (overpaidCents), recomputed on every money event
 *   including after CLOSED. Payments after CLOSED are recorded (late:true)
 *   and counted; status never regresses.
 */

const STATUS = Object.freeze({
  ABERTA: 'aberta',
  PARCIAL: 'parcial',
  PAGA: 'paga',
  FECHADA: 'fechada',
});

const EVENT_TYPES = Object.freeze([
  'OPENED', 'ADJUSTED', 'PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'CLOSED',
  // Uma disputa NÃO é um estorno. O dinheiro fica retido enquanto o esquema
  // decide, e o cliente pode perder — então marcar como PAYMENT_REFUNDED
  // reabriria a conta por causa de uma reclamação que talvez não proceda.
  //
  // Mas ela É um evento de dinheiro, e o inegociável #6 diz que estado de
  // pagamento é event-sourced: se a disputa não entra no log, o estorno que
  // aparece noventa dias depois não tem antecedente nenhum. Então ela entra,
  // sem mover saldo, e marca a conta pra alguém olhar.
  //
  // O Bizum abriu essa necessidade: 120 dias de janela, contra a janela curta
  // do MED do Pix.
  'PAYMENT_DISPUTED',
  /**
   * O estorno que NÃO aconteceu.
   *
   * A Stripe incrementa `amount_refunded` quando o estorno é CRIADO, então o
   * `charge.refunded` chega e o razão grava PAYMENT_REFUNDED. Se o
   * `refund.failed` vier depois — e no Bizum o estorno é assíncrono, então vem
   * — o dinheiro voltou pro saldo e o cliente ficou sem.
   *
   * Antes disto não havia como representar isso: a decisão registrada era
   * "não inventar evento", e ela está certa pro caso síncrono e INVERTIDA pro
   * assíncrono. O estorno já estava no razão; faltava poder desfazê-lo.
   *
   * O resultado era o pior possível: o cliente com dinheiro a receber, os dois
   * registros nossos dizendo que ele foi pago, e a conciliação comparando os
   * dois entre si, achando que concordam, e reportando VERDE. Um cliente lesado
   * e um canário calado.
   *
   * Devolve o saldo ao estado de pago E marca anomalia: o dinheiro é do
   * restaurante de novo, mas alguém tem que reembolsar por outro caminho.
   * Achado pela revisão de compliance de 2026-09-08 (CDC art. 6º III e art.
   * 42, § único).
   */
  'PAYMENT_REFUND_REVERSED',
  /**
   * A disputa ACABOU.
   *
   * O `PAYMENT_DISPUTED` põe uma anomalia na conta, e anomalia não se resolve
   * sozinha: uma disputa que a casa GANHOU deixava a conta vermelha na
   * conciliação pra sempre. Um canário que grita sem parar é o modo de falha
   * que o inegociável #8 descreve — depois de duas semanas ninguém olha mais,
   * e a próxima disputa de verdade passa junto.
   *
   * O log continua íntegro (inegociável #6): o `PAYMENT_DISPUTED` fica lá, com
   * data e motivo. O que este evento faz é dizer como terminou, e a PROJEÇÃO
   * deixa de acusar. Perdida vira estorno de verdade (evento separado) e esta
   * marca também sai, porque o desfecho passou a estar no saldo.
   */
  'PAYMENT_DISPUTE_CLOSED',
  /**
   * Uma anomalia que o sistema REGISTRA em vez de recusar.
   *
   * Existe pro caso fora de ordem: uma reversão de estorno que chega antes do
   * estorno não pode ser aplicada (seria inventar dinheiro) e não deve ser
   * recusada (409 → reenvio → endpoint desabilitado, e se os reenvios se
   * esgotarem a reversão some pra sempre). Registrar é a terceira saída: alto
   * no NOSSO sistema, e não no contador de falhas do PSP.
   *
   * Não move saldo. Só marca a conta pra alguém olhar.
   */
  'PAYMENT_ANOMALY',
  /**
   * Alguém RESOLVEU uma pendência de dinheiro, por fora.
   *
   * Existe pro estorno que falhou: o dinheiro voltou pro restaurante e o
   * cliente ficou sem, então a conta fica marcada até que alguém reembolse por
   * outro caminho (Pix na mão, dinheiro, o que for). Sem este evento a marca é
   * PERMANENTE, e uma casa que nunca fica verde é uma casa que para de olhar —
   * o mesmo defeito que o fecho de disputa corrigiu, do outro lado.
   *
   * O log continua íntegro: a falha do estorno fica lá com data e valor. O que
   * muda é a projeção parar de acusar.
   *
   * Quem dispara é o dono, pela rota `resolve-issue` — chamada à mão: nenhuma
   * tela a usa pra falha de estorno (a tela só manda a resposta escopada do
   * pago-depois-de-fechar). Registra QUEM e POR QUÊ, porque
   * "resolvido" sem autor é uma marca que qualquer um pode apagar.
   */
  'PAYMENT_ISSUE_RESOLVED',
]);

// Money accumulations must stay in exact-integer territory.
const MAX_CENTS = Number.MAX_SAFE_INTEGER;

class EventValidationError extends Error {}

function invalid(msg) {
  throw new EventValidationError(`check-state: ${msg}`);
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) invalid(`${name} must be a non-negative integer, got ${v}`);
}

/**
 * Strict validation for the APPEND path: the API calls this against current
 * state before appending. Throws EventValidationError on any violation.
 * (The reducer reuses it but converts throws into anomalies — totality.)
 */
function validateEvent(evt, prevState) {
  if (!evt || !EVENT_TYPES.includes(evt.type)) invalid(`unknown event type: ${evt && evt.type}`);
  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      if (prevState) invalid('OPENED must be the first event');
      assertCents(p.totalCents, 'OPENED.totalCents');
      break;
    case 'ADJUSTED':
      if (!prevState) invalid('ADJUSTED before OPENED');
      if (prevState.status === STATUS.FECHADA) invalid('cannot ADJUST a closed check');
      assertCents(p.totalCents, 'ADJUSTED.totalCents');
      break;
    case 'PAYMENT_CONFIRMED':
      if (!prevState) invalid('PAYMENT_CONFIRMED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_CONFIRMED.txid required');
      assertCents(p.amountCents, 'PAYMENT_CONFIRMED.amountCents');
      assertCents(p.tipCents ?? 0, 'PAYMENT_CONFIRMED.tipCents');
      if (p.amountCents === 0 && (p.tipCents ?? 0) === 0) invalid('zero-value payment');
      break;
    case 'PAYMENT_REFUNDED': {
      if (!prevState) invalid('PAYMENT_REFUNDED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_REFUNDED.txid required');
      assertCents(p.amountCents ?? 0, 'PAYMENT_REFUNDED.amountCents');
      assertCents(p.tipCents ?? 0, 'PAYMENT_REFUNDED.tipCents');
      if ((p.amountCents ?? 0) === 0 && (p.tipCents ?? 0) === 0) invalid('zero-value refund');
      const pay = prevState.payments[p.txid];
      if (!pay) invalid(`refund for unknown txid ${p.txid}`);
      if (pay.refundedAmountCents + (p.amountCents ?? 0) > pay.amountCents) {
        invalid(`refund exceeds paid amount for txid ${p.txid}`);
      }
      if (pay.refundedTipCents + (p.tipCents ?? 0) > pay.tipCents) {
        invalid(`tip refund exceeds paid tip for txid ${p.txid}`);
      }
      break;
    }
    case 'PAYMENT_REFUND_REVERSED': {
      if (!prevState) invalid('PAYMENT_REFUND_REVERSED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_REFUND_REVERSED.txid required');
      assertCents(p.amountCents ?? 0, 'PAYMENT_REFUND_REVERSED.amountCents');
      assertCents(p.tipCents ?? 0, 'PAYMENT_REFUND_REVERSED.tipCents');
      if ((p.amountCents ?? 0) === 0 && (p.tipCents ?? 0) === 0) invalid('zero-value reversal');
      const rev = prevState.payments[p.txid];
      if (!rev) invalid(`reversal for unknown txid ${p.txid}`);
      // Não se pode desfazer mais estorno do que existe. Um `refund.failed`
      // que chega duas vezes, ou pra um estorno que nunca entrou, é
      // divergência — alto, não absorvido.
      if ((p.amountCents ?? 0) > rev.refundedAmountCents) {
        invalid(`reversal exceeds refunded amount for txid ${p.txid}`);
      }
      if ((p.tipCents ?? 0) > rev.refundedTipCents) {
        invalid(`reversal exceeds refunded tip for txid ${p.txid}`);
      }
      break;
    }
    case 'PAYMENT_ISSUE_RESOLVED': {
      if (!prevState) invalid('PAYMENT_ISSUE_RESOLVED before OPENED');
      if (typeof p.txid !== 'string' || !p.txid) invalid('PAYMENT_ISSUE_RESOLVED.txid required');
      if (typeof p.note !== 'string' || p.note.trim().length < 3) {
        // Sem o porquê, "resolvido" é só a marca sumindo.
        invalid('PAYMENT_ISSUE_RESOLVED.note required');
      }
      // O txid tem que EXISTIR nesta conta.
      //
      // Sem isto, era uma atestação sem limite: qualquer texto no lugar do
      // txid limpava anomalias que não existiam, ou nenhuma, e o log ficava
      // com um "resolvido" que não aponta pra nada. O evento tira uma marca de
      // dinheiro da projeção — a marca que faz a casa aparecer vermelha na
      // conciliação — então ele precisa dizer de QUAL pagamento está falando.
      // Conhecido é estar no razão como PAGAMENTO **ou** como ANOMALIA.
      //
      // Só `payments` era estreito demais e criava a marca inencerrável: um Pix
      // pago cuja confirmação se perdeu, seguido de um cancelamento parcial,
      // deixa uma anomalia CRÍTICA num txid que o razão nunca viu confirmar —
      // e o `resolve-issue` respondia 400 pra sempre. Uma casa que nunca fica
      // verde é uma casa que para de olhar, que é o defeito que este evento
      // existe pra evitar.
      const conhecido = Boolean(prevState.payments[p.txid])
        || (prevState.anomalies || []).some((a) => a && a.txid === p.txid);
      if (!conhecido) {
        invalid(`PAYMENT_ISSUE_RESOLVED para txid desconhecido ${p.txid}`);
      }
      // A resposta ESCOPADA do pago-depois-de-fechar só vale onde há pergunta
      // aberta — e nunca pro serviço de uma duplicidade, que é a devolver de
      // qualquer jeito (compliance MEDIUM-2 de 41d1244).
      if (p.scope !== undefined) {
        if (p.scope !== 'paid_after_close') invalid(`PAYMENT_ISSUE_RESOLVED.scope desconhecido: ${p.scope}`);
        const entradas = paidAfterClose(prevState).filter((x) => x.txid === p.txid);
        if (!entradas.some((x) => !x.sempreDevido)) {
          if (entradas.length) invalid(`PAYMENT_ISSUE_RESOLVED: o que resta de ${p.txid} é serviço de pagamento em duplicidade — devolva pelo adquirente`);
          invalid(`PAYMENT_ISSUE_RESOLVED: ${p.txid} não tem pergunta de pago-depois-de-fechar aberta`);
        }
      }
      break;
    }
    case 'PAYMENT_ANOMALY': {
      if (!prevState) invalid('PAYMENT_ANOMALY before OPENED');
      if (typeof p.reason !== 'string' || !p.reason) invalid('PAYMENT_ANOMALY.reason required');
      // A GRAVIDADE é do vocabulário da conciliação (`severityRank`), não texto
      // livre: um `severity: 'urgente'` cairia no rank 0 e a pior anomalia do
      // sistema sairia ABAIXO de uma informativa.
      if (p.severity !== undefined && !ANOMALY_SEVERITIES.includes(p.severity)) {
        invalid(`PAYMENT_ANOMALY.severity inválida: ${p.severity}`);
      }
      break;
    }
    case 'PAYMENT_DISPUTE_CLOSED': {
      if (!prevState) invalid('PAYMENT_DISPUTE_CLOSED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_DISPUTE_CLOSED.txid required');
      if (!['won', 'lost', 'warning_closed'].includes(p.outcome)) {
        invalid(`PAYMENT_DISPUTE_CLOSED.outcome inválido: ${p.outcome}`);
      }
      if (!prevState.payments[p.txid]) invalid(`dispute close for unknown txid ${p.txid}`);
      break;
    }
    case 'PAYMENT_DISPUTED': {
      if (!prevState) invalid('PAYMENT_DISPUTED before OPENED');
      if (typeof p.txid !== 'string' || p.txid.length < 1) invalid('PAYMENT_DISPUTED.txid required');
      assertCents(p.amountCents ?? 0, 'PAYMENT_DISPUTED.amountCents');
      // Disputa de um txid que não existe é um sinal de que o webhook e o
      // ledger discordam — alto, não silencioso.
      if (!prevState.payments[p.txid]) invalid(`dispute for unknown txid ${p.txid}`);
      break;
    }
    case 'CLOSED':
      if (!prevState) invalid('CLOSED before OPENED');
      if (prevState.status === STATUS.FECHADA) invalid('already closed');
      break;
    default:
      invalid(`unhandled type ${evt.type}`);
  }
}

function initialState() {
  return null; // no OPENED yet
}

/** payments map uses a null-prototype object: txids are external strings. */
function emptyPayments() {
  return Object.create(null);
}

/**
 * Fold one event into state — TOTAL. Invalid events return the previous state
 * with an anomaly appended (except a valid duplicate PAYMENT_CONFIRMED, which
 * is a clean idempotent no-op). Pure; returns a NEW state object.
 */
function applyEvent(state, evt, seq = null) {
  // Idempotent replay short-circuit must run BEFORE strict validation so a
  // duplicate webhook is a no-op, not an anomaly.
  if (state && evt && evt.type === 'PAYMENT_CONFIRMED') {
    const p = evt.payload || {};
    const existing = typeof p.txid === 'string' ? state.payments[p.txid] : undefined;
    if (existing) {
      if (existing.amountCents === p.amountCents && existing.tipCents === (p.tipCents ?? 0)) {
        return state; // clean at-least-once replay
      }
      // Same txid, different money: never absorb silently (review finding).
      return withAnomaly(state, seq, 'divergent_txid',
        `txid ${p.txid} replayed with different amounts`);
    }
  }

  try {
    validateEvent(evt, state);
  } catch (err) {
    if (err instanceof EventValidationError) {
      // Totality: a stored log must always reduce. Raced duplicates
      // (CLOSED,CLOSED), adjust-after-close, malformed payloads → anomaly.
      if (state === null) {
        // Pre-OPENED garbage: keep a bootstrap anomaly holder.
        return {
          ...emptyOpenState(0),
          status: STATUS.ABERTA,
          bootstrapped: true,
          anomalies: [{ seq, type: evt && evt.type, reason: err.message }],
        };
      }
      // A resposta ESCOPADA que chegou depois de a pergunta fechar — uma corrida
      // com o estorno do adquirente, ou dois cliques — não é defeito de
      // dinheiro: é informação. Como `high` e sem txid, virava uma marca que
      // nada limpava (segurança LOW-2 e compliance LOW-A de 57c0d2e).
      const respostaTardia = evt && evt.type === 'PAYMENT_ISSUE_RESOLVED'
        && evt.payload && evt.payload.scope === 'paid_after_close';
      return withAnomaly(state, seq, evt && evt.type, err.message,
        respostaTardia ? (evt.payload.txid || null) : null, respostaTardia ? 'info' : 'high');
    }
    throw err; // programmer errors stay loud
  }

  const p = evt.payload || {};
  switch (evt.type) {
    case 'OPENED':
      return emptyOpenState(p.totalCents);
    case 'ADJUSTED':
      return recompute({ ...cloneState(state), totalCents: p.totalCents });
    case 'PAYMENT_CONFIRMED': {
      const next = cloneState(state);
      const tip = p.tipCents ?? 0;
      guardCap(next.paidCents, p.amountCents);
      guardCap(next.tipCents, tip);
      next.payments[p.txid] = {
        amountCents: p.amountCents,
        tipCents: tip,
        refundedAmountCents: 0,
        refundedTipCents: 0,
        disputedAmountCents: 0,
        /**
         * Quanto DESTE pagamento entrou a mais — DERIVADO, não recebido.
         *
         * O excedente fica no consumo (ver `parseCharge`) e a devolução dele
         * sai todo do consumo (ver `allocateRestitution`), então o razão
         * precisa saber de qual pagamento a sobra veio: numa conta rachada,
         * `state.overpaidCents` é da CONTA e usá-lo fazia a sobra de quem
         * pagou a mais reger o estorno de quem pagou exato.
         *
         * A primeira versão CARREGAVA o número, vindo do adaptador. Três
         * buracos, todos medidos:
         *
         *  - o campo não chegava pelo caminho da CONCILIAÇÃO (o objeto era
         *    remontado à mão e o campo ficava de fora), que é justamente o
         *    caminho que existe porque o webhook pode não chegar;
         *  - todo pagamento gravado ANTES deste campo replayava com zero, e a
         *    reserva histórica que eu tinha escrito era código morto — o
         *    próprio redutor normalizava o campo, então a guarda nunca podia
         *    disparar (inegociável #7);
         *  - e só o adaptador do Pagar.me o produzia. Duas pessoas pagando a
         *    conta cheia cada uma, um pagamento atrasado numa conta já paga,
         *    uma conta reduzida no POS, ou qualquer coisa pela Stripe/carteira
         *    da casa: sobra de verdade, excedente zero.
         *
         * Derivar fecha os três de uma vez: é o quanto este pagamento passou
         * do que ainda faltava quitar QUANDO ele entrou. O razão é a fonte, e
         * o razão sempre soube disso. Achado pelas revisões de 2026-09-08.
         */
        excessCents: Math.max(0, p.amountCents - Math.max(0, state.totalCents - state.paidCents)),
        late: state.status === STATUS.FECHADA,
      };
      /**
       * E o que o adaptador DISSE fica como conferência.
       *
       * Se o PSP reporta um excedente diferente do que a conta deriva, uma das
       * duas medições está errada — e as duas viram dinheiro. Anomalia
       * informativa: não muda nada no saldo (o derivado é quem manda), e
       * aparece antes de virar divergência de verdade.
       */
      const dito = Number.isSafeInteger(p.excessCents) ? p.excessCents : null;
      const derivado = next.payments[p.txid].excessCents;
      next.paidCents += p.amountCents;
      next.tipCents += tip;
      if (dito !== null && dito !== derivado) {
        return withAnomaly(recompute(next), seq, 'PAYMENT_CONFIRMED',
          `excedente divergente em ${p.txid}: PSP diz ${dito}¢, a conta deriva ${derivado}¢`,
          p.txid, 'info');
      }
      return recompute(next);
    }
    case 'PAYMENT_REFUNDED': {
      const next = cloneState(state);
      const amount = p.amountCents ?? 0;
      const tip = p.tipCents ?? 0;
      const pay = next.payments[p.txid];
      pay.refundedAmountCents += amount;
      pay.refundedTipCents += tip;
      // O ID DA DISPUTA que produziu este estorno, quando veio de uma.
      //
      // É a chave de idempotência certa pra um chargeback: a rede permite duas
      // disputas na mesma cobrança, então "este pagamento já perdeu uma
      // disputa" não distingue a reentrega da SEGUNDA derrota — e engolir a
      // segunda é perder de vista dinheiro que saiu de verdade.
      if (typeof p.disputeId === 'string' && p.disputeId) {
        pay.disputeIdsClosed = [...(pay.disputeIdsClosed || []), p.disputeId];
      }
      next.paidCents -= amount;
      next.tipCents -= tip;
      return recompute(next);
    }
    case 'PAYMENT_REFUND_REVERSED': {
      // O espelho exato do PAYMENT_REFUNDED, e uma anomalia por cima: o
      // dinheiro é do restaurante de novo, mas o cliente continua com um
      // reembolso a receber por outro caminho. Sem a anomalia, a conta volta a
      // parecer normal — o que era justamente o buraco.
      const next = cloneState(state);
      const amount = p.amountCents ?? 0;
      const tip = p.tipCents ?? 0;
      const pay = next.payments[p.txid];
      pay.refundedAmountCents -= amount;
      pay.refundedTipCents -= tip;
      next.paidCents += amount;
      next.tipCents += tip;
      // O VALOR entra na anomalia: é o que o cliente tem a receber, e a tela
      // dele deriva o número daqui. Sem ele o aviso saía com o saldo NÃO
      // estornado do pagamento — num estorno de R$ 50 sobre R$ 100 que falha,
      // o telefone dizia "você tem R$ 100 a receber". Um número errado é pior
      // que nenhum: manda a pessoa discutir no caixa por uma quantia que
      // ninguém deve. Achado pela revisão de segurança de 2026-09-08.
      return withAnomaly(recompute(next), seq, 'PAYMENT_REFUND_REVERSED',
        `estorno de ${p.txid} FALHOU: dinheiro voltou pro restaurante e o cliente ficou sem`,
        p.txid, 'high', amount + tip);
    }
    case 'PAYMENT_DISPUTED': {
      // Não mexe em `paidCents`: o dinheiro ainda é do restaurante até o
      // esquema decidir. Marca o pagamento e registra uma anomalia, que é o
      // que faz a conta aparecer vermelha na conciliação em vez de parecer
      // normal enquanto alguém contesta.
      const next = cloneState(state);
      const pay = next.payments[p.txid];
      /**
       * A disputa já ACABOU? Então esta abertura chegou atrasada.
       *
       * A Stripe não garante ordem. `charge.dispute.closed` com `won` chegando
       * ANTES do `charge.dispute.created` fazia o fecho não achar nada pra
       * limpar, e depois a abertura gravava o prazo — e a conciliação passava a
       * gritar `dispute_evidence_due` e depois `dispute_evidence_overdue`
       * CRÍTICO, pra sempre, sobre uma disputa já ganha. O canário que o
       * `PAYMENT_DISPUTE_CLOSED` existe pra calar, ressuscitado pela ordem de
       * entrega. Achado pela revisão de segurança de 2026-09-08.
       *
       * O evento entra no log de qualquer jeito (inegociável #6: a abertura
       * aconteceu e tem data e motivo). O que ele NÃO faz é reabrir uma disputa
       * que o próprio log já diz encerrada.
       */
      const jaEncerrada = pay && ['won', 'lost', 'warning_closed'].includes(pay.disputeStatus);
      if (jaEncerrada) return recompute(next);
      if (pay) {
        pay.disputedAmountCents = (pay.disputedAmountCents || 0) + (p.amountCents ?? 0);
        // O PRAZO DE PROVA, no estado. É a coisa mais cara do evento: 40 dias
        // corridos no Bizum, e perder o prazo é perder o dinheiro por inação.
        // Antes ele era jogado fora no adaptador e a defesa inteira era uma
        // notificação best-effort.
        if (p.dueBy) pay.disputeDueBy = p.dueBy;
        pay.disputeStatus = p.status || 'open';
      }
      return withAnomaly(recompute(next), seq, 'PAYMENT_DISPUTED',
        `disputa aberta em ${p.txid}${p.reason ? ` (${p.reason})` : ''}`
        + `${p.dueBy ? ` — prova até ${p.dueBy}` : ''}`, p.txid);
    }
    case 'PAYMENT_DISPUTE_CLOSED': {
      const next = cloneState(state);
      const pay = next.payments[p.txid];
      if (pay) {
        pay.disputedAmountCents = 0;
        pay.disputeStatus = p.outcome;
        delete pay.disputeDueBy;
      }
      // A anomalia daquele txid SAI da projeção. O log fica; o que muda é o
      // que a conciliação vê — e uma disputa resolvida não é uma pendência.
      const resolved = recompute(next);
      // Casa por CAMPO, não por texto: só a anomalia de disputa DAQUELE txid
      // sai. Uma anomalia de outro pagamento que citasse o mesmo id na frase
      // ficava sendo removida junto na primeira versão disto.
      resolved.anomalies = resolved.anomalies.filter(
        (a) => !(a.type === 'PAYMENT_DISPUTED' && a.txid === p.txid),
      );
      // Perdida já virou estorno no saldo; ganha não mexe em dinheiro. Nos dois
      // casos a marca sai, e o desfecho fica registrado em `disputeStatus`.
      if (p.outcome === 'lost') {
        // INFORMAÇÃO, não pendência: o dinheiro já saiu e está registrado no
        // estorno. Não há nada a fazer, e uma pendência permanente aqui é o
        // canário que grita pra sempre — o mesmo defeito que o fecho de
        // disputa foi escrito pra corrigir, reintroduzido do outro lado.
        return withAnomaly(resolved, seq, 'PAYMENT_DISPUTE_CLOSED',
          `disputa PERDIDA em ${p.txid} — o dinheiro foi`, p.txid, 'info');
      }
      return resolved;
    }
    case 'PAYMENT_ANOMALY':
      // Não mexe em dinheiro nenhum: só deixa a marca. A gravidade vem de quem
      // registra — "dinheiro saiu e não sabemos quanto" não é do mesmo tamanho
      // que uma divergência de centavos, e o padrão `high` achatava as duas.
      return withAnomaly(recompute(cloneState(state)), seq, 'PAYMENT_ANOMALY',
        p.reason, p.txid || null, p.severity || 'high');
    case 'PAYMENT_ISSUE_RESOLVED': {
      // ESCOPADO: responde SÓ a pergunta do pago-depois-de-fechar — a mesa não
      // pagou no caixa. Não toca anomalia nenhuma e não acrescenta nenhuma: o
      // botão do painel escrevia o evento sem escopo e, com ele, apagava junto a
      // falha de um estorno e o aviso "você tem a receber" do cliente
      // (compliance HIGH-1 e segurança LOW-4 de 41d1244). O log fica com o evento.
      if (p.scope === 'paid_after_close') {
        const next = cloneState(state);
        if (next.payments[p.txid]) next.payments[p.txid] = { ...next.payments[p.txid], lateResolved: true };
        return recompute(next);
      }
      // Tira da PROJEÇÃO as pendências daquele txid. O log fica: a falha do
      // estorno continua lá, com data e valor, e agora com o registro de quem
      // resolveu e por quê. NÃO responde a pergunta do pago-depois-de-fechar —
      // cada resposta limpa só a sua marca.
      const next = cloneState(state);
      const RESOLVIVEIS = new Set(['PAYMENT_REFUND_REVERSED', 'PAYMENT_ANOMALY']);
      next.anomalies = next.anomalies.filter(
        (a) => !(RESOLVIVEIS.has(a.type) && a.txid === p.txid),
      );
      return withAnomaly(recompute(next), seq, 'PAYMENT_ISSUE_RESOLVED',
        `pendência de ${p.txid} resolvida: ${p.note}`, p.txid, 'info');
    }
    case 'CLOSED':
      return recompute({ ...cloneState(state), closed: true });
    default:
      return withAnomaly(state, seq, evt.type, 'unhandled type');
  }
}

function emptyOpenState(totalCents) {
  return {
    status: STATUS.ABERTA,
    totalCents,
    paidCents: 0,
    tipCents: 0,
    overpaidCents: 0,
    closed: false,
    payments: emptyPayments(),
    anomalies: [],
  };
}

function cloneState(state) {
  const payments = emptyPayments();
  for (const txid of Object.keys(state.payments)) {
    payments[txid] = { ...state.payments[txid] };
  }
  return { ...state, payments, anomalies: [...state.anomalies] };
}

/**
 * Uma anomalia, opcionalmente ATRELADA a um txid.
 *
 * O `txid` é campo, não texto dentro da frase. A primeira versão do
 * `PAYMENT_DISPUTE_CLOSED` procurava o txid DENTRO de `reason` pra saber qual
 * anomalia resolver, e isso é frágil de dois jeitos: uma anomalia de outro
 * pagamento que por acaso citasse o mesmo txid seria removida junto, e mudar a
 * redação da mensagem quebraria a resolução em silêncio — o pior tipo de
 * quebra, porque o sintoma é uma conta que continua vermelha e ninguém
 * associa à mudança de uma string.
 */
/** As gravidades que a conciliação sabe ordenar (`severityRank`). */
const ANOMALY_SEVERITIES = ['critical', 'high', 'info'];

function withAnomaly(state, seq, type, reason, txid = null, severity = 'high', amountCents = null) {
  const next = cloneState(state);
  next.anomalies.push({
    seq, type: type || 'UNKNOWN', reason, severity, ...(txid ? { txid } : {}),
    ...(Number.isSafeInteger(amountCents) ? { amountCents } : {}),
  });
  return next;
}

function guardCap(current, add) {
  if (current + add > MAX_CENTS) invalid('money accumulation exceeds safe integer range');
}

/**
 * Derive status + overpaid from totals. FECHADA (closed flag) wins and never
 * regresses; overpaidCents is recomputed on EVERY money event, including
 * post-close payments (review finding: it used to go stale).
 */
function recompute(state) {
  const overpaidCents = Math.max(0, state.paidCents - state.totalCents);
  let status;
  if (state.closed) status = STATUS.FECHADA;
  else if (state.paidCents === 0) status = STATUS.ABERTA;
  else if (state.paidCents < state.totalCents) status = STATUS.PARCIAL;
  else status = STATUS.PAGA;
  return { ...state, status, overpaidCents };
}

/**
 * Reduce a full event log (seq-ordered) to current state. TOTAL: never throws
 * on stored data; inspect state.anomalies (reconciliation alerts on any).
 * @param {Array<{type:string, payload:object, seq?:number}>} events
 */
function reduce(events) {
  if (!Array.isArray(events)) invalid('events must be an array');
  let state = initialState();
  events.forEach((evt, i) => {
    state = applyEvent(state, evt, evt.seq ?? i + 1);
  });
  return state;
}

/** Remaining consumption to collect (never negative). */
function remainingCents(state) {
  if (!state) invalid('no state');
  return Math.max(0, state.totalCents - state.paidCents);
}

/** Late payments (post-close), for reconciliation/refund workflows. */
function lateTxids(state) {
  if (!state) return [];
  return Object.keys(state.payments).filter((t) => state.payments[t].late);
}

/**
 * PAGO DEPOIS DE FECHAR — a parte que o `overpaidCents` NÃO vê.
 *
 * O Racha não registra o que o caixa recebe. Um Pix iniciado antes de o QR
 * girar e confirmado depois de a equipe cobrar a mesa no caixa e fechar a conta
 * completa a conta até o total: o razão não vê sobra nenhuma — e a mesa pagou
 * duas vezes. (Compliance HIGH-1 de 40d5c50, CDC art. 42.)
 *
 * O VALOR é contado contra a sobra ATUAL da conta, não contra o excedente que
 * cada pagamento carregava quando entrou: o excedente fica congelado no
 * pagamento, e a sobra é recalculada. Com o congelado, estornar um pagamento
 * atrasado sem excedente encolhia a sobra e o excedente do OUTRO continuava fora
 * da marca — o dinheiro sumia dos dois lugares, e o tamanho dependia da ordem
 * de chegada (segurança MEDIUM-1 de 41d1244). Agora: o consumo líquido dos
 * atrasados não respondidos, menos a sobra atual (descontada do mais novo pro
 * mais velho), mais o SERVIÇO líquido de cada um. Invariante, em qualquer
 * ordem: soma das marcas + `overpaidCents` = dinheiro atrasado líquido.
 *
 * `sempreDevido`: quando a sobra cobre o consumo inteiro de um pagamento, ele é
 * duplicidade — e o serviço dele é a devolver de qualquer jeito, não uma
 * pergunta sobre o caixa (compliance MEDIUM-2 de 41d1244).
 *
 * RESPONDIDO sai: `PAYMENT_ISSUE_RESOLVED` ESCOPADO (`scope: 'paid_after_close'`)
 * marca `lateResolved` — a mesa não pagou no caixa. Sem resposta, a pergunta fica.
 */
function paidAfterClose(state) {
  if (!state) return [];
  // TODOS os atrasados entram no rateio da sobra — os respondidos também. A
  // resposta de uma linha não mexe mais no valor das irmãs, e a parte do serviço
  // que corresponde à duplicidade continua devida depois da resposta (segurança
  // MEDIUM-1 e compliance MEDIUM-C de 57c0d2e).
  const atrasados = Object.entries(state.payments).filter(([, p]) => p.late);
  const liquido = (p) => Math.max(0, p.amountCents - (p.refundedAmountCents || 0));
  const pool = atrasados.reduce((soma, [, p]) => soma + liquido(p), 0);
  let aDescontar = Math.min(Math.max(0, state.overpaidCents || 0), pool);
  const duplicado = new Map();
  for (const [txid, p] of [...atrasados].reverse()) {
    const d = Math.min(liquido(p), aDescontar);
    aDescontar -= d;
    duplicado.set(txid, d);
  }
  const out = [];
  for (const [txid, p] of atrasados) {
    const l = liquido(p);
    const d = duplicado.get(txid);
    const servico = Math.max(0, (p.tipCents || 0) - (p.refundedTipCents || 0));
    // O serviço ACOMPANHA o consumo: a fração dele que corresponde à parte
    // duplicada é devida de qualquer jeito, arredondada a favor de quem pagou.
    // A versão anterior só marcava "devido" quando a duplicidade era EXATA — um
    // estorno de um centavo numa irmã e a resposta honesta apagava o serviço
    // inteiro.
    const servicoDevido = l > 0 ? Math.min(servico, Math.ceil((servico * d) / l)) : 0;
    const pergunta = (l - d) + (servico - servicoDevido);
    if (!p.lateResolved && pergunta > 0) out.push({ txid, amountCents: pergunta });
    if (servicoDevido > 0) out.push({ txid, amountCents: servicoDevido, sempreDevido: true });
  }
  return out;
}

module.exports = {
  ANOMALY_SEVERITIES,
  STATUS, EVENT_TYPES, EventValidationError,
  reduce, applyEvent, validateEvent, remainingCents, lateTxids, paidAfterClose, initialState,
};
