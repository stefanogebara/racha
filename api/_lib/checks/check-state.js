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
    case 'PAYMENT_ANOMALY': {
      if (!prevState) invalid('PAYMENT_ANOMALY before OPENED');
      if (typeof p.reason !== 'string' || !p.reason) invalid('PAYMENT_ANOMALY.reason required');
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
      return withAnomaly(state, seq, evt && evt.type, err.message);
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
        late: state.status === STATUS.FECHADA,
      };
      next.paidCents += p.amountCents;
      next.tipCents += tip;
      return recompute(next);
    }
    case 'PAYMENT_REFUNDED': {
      const next = cloneState(state);
      const amount = p.amountCents ?? 0;
      const tip = p.tipCents ?? 0;
      const pay = next.payments[p.txid];
      pay.refundedAmountCents += amount;
      pay.refundedTipCents += tip;
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
      return withAnomaly(recompute(next), seq, 'PAYMENT_REFUND_REVERSED',
        `estorno de ${p.txid} FALHOU: dinheiro voltou pro restaurante e o cliente ficou sem`,
        p.txid);
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
        return withAnomaly(resolved, seq, 'PAYMENT_DISPUTE_CLOSED',
          `disputa PERDIDA em ${p.txid} — o dinheiro foi`, p.txid);
      }
      return resolved;
    }
    case 'PAYMENT_ANOMALY':
      // Não mexe em dinheiro nenhum: só deixa a marca.
      return withAnomaly(recompute(cloneState(state)), seq, 'PAYMENT_ANOMALY', p.reason, p.txid || null);
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
function withAnomaly(state, seq, type, reason, txid = null) {
  const next = cloneState(state);
  next.anomalies.push({ seq, type: type || 'UNKNOWN', reason, ...(txid ? { txid } : {}) });
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

module.exports = {
  STATUS, EVENT_TYPES, EventValidationError,
  reduce, applyEvent, validateEvent, remainingCents, lateTxids, initialState,
};
