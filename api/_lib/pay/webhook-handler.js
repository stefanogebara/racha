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
async function applyConfirmedPayment(parsed, { loadEvents, appendEvent, recordPayment, findCheckByTxid, fallback }) {
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
   * Reversão: desfaz o que ESTE estorno tirou, na mesma proporção.
   *
   * O `refund.failed` traz o valor do estorno que falhou. Rateá-lo contra o
   * que já foi estornado devolve exatamente as partes que foram tiradas —
   * pelo mesmo `allocateRefund`, então a ida e a volta não podem divergir.
   */
  let reversalAllocated = null;
  if (type === 'PAYMENT_REFUND_REVERSED') {
    const pay = state && state.payments[parsed.txid];
    if (!pay) return { status: 'rejected', reason: `reversal for unknown txid ${parsed.txid}` };
    const jaEstornado = pay.refundedAmountCents + pay.refundedTipCents;
    const falhou = Number.isSafeInteger(parsed.amountCents) ? parsed.amountCents : jaEstornado;
    if (jaEstornado === 0) {
      // O estorno nunca entrou no razão. Reverter o que não existe não é
      // desfazer, é inventar — recusa alta, que é o que o inegociável #6 pede.
      return { status: 'rejected', reason: `reversal with no refund on record for txid ${parsed.txid}` };
    }
    const aReverter = Math.min(falhou, jaEstornado);
    reversalAllocated = allocateRefund(pay.refundedAmountCents, pay.refundedTipCents, aReverter);
  }

  let refundAllocated = null;
  // Disputa perdida traz um DELTA (o valor disputado), não um acumulado. Rateia
  // proporcional pelo mesmo `allocateRefund`: um chargeback leva a gorjeta
  // junto, e deixá-la nos livros como "paga" mentiria pra folha (Lei 13.419).
  if (type === 'PAYMENT_REFUNDED' && Number.isSafeInteger(parsed.refundDeltaCents)) {
    const pay = state && state.payments[parsed.txid];
    if (!pay) return { status: 'rejected', reason: `refund for unknown txid ${parsed.txid}` };
    const sobra = (pay.amountCents - pay.refundedAmountCents) + (pay.tipCents - pay.refundedTipCents);
    if (parsed.refundDeltaCents > sobra) {
      return {
        status: 'rejected',
        reason: `refund ${parsed.refundDeltaCents} exceeds outstanding ${sobra} for txid ${parsed.txid}`,
      };
    }
    refundAllocated = allocateRefund(
      pay.amountCents - pay.refundedAmountCents,
      pay.tipCents - pay.refundedTipCents,
      parsed.refundDeltaCents,
    );
  }
  if (type === 'PAYMENT_REFUNDED' && Number.isSafeInteger(parsed.cumulativeRefundedCents)) {
    const pay = state && state.payments[parsed.txid];
    if (!pay) {
      return { status: 'rejected', reason: `refund for unknown txid ${parsed.txid}` };
    }
    const jaEstornado = pay.refundedAmountCents + pay.refundedTipCents;
    const delta = parsed.cumulativeRefundedCents - jaEstornado;
    if (delta <= 0) {
      // Reenvio do mesmo estorno, ou um acumulado mais velho que o que já
      // temos. Nada a fazer, e nada de anomalia: é o caso normal.
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
    refundAllocated = allocateRefund(
      pay.amountCents - pay.refundedAmountCents,
      pay.tipCents - pay.refundedTipCents,
      delta,
    );
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
  };

  if (type === 'PAYMENT_CONFIRMED' && state && state.payments[parsed.txid]) {
    const existing = state.payments[parsed.txid];
    if (existing.amountCents === parsed.amountCents && existing.tipCents === parsed.tipCents) {
      return { status: 'duplicate', checkId: check.id }; // clean at-least-once replay
    }
    // Divergent replay: append so the anomaly is durable and alertable.
    const seq = await appendEvent(check.id, type, payload);
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

  const seq = await appendEvent(check.id, type, payload);
  if (recordPayment) {
    await recordPayment({
      checkId: check.id,
      txid: parsed.txid,
      amountCents: parsed.amountCents,
      tipCents: parsed.tipCents,
      kind: parsed.kind,
      // O status vem RESOLVIDO daqui. O store não decide dinheiro.
      status: ROW_STATUS_FOR_KIND[parsed.kind] || 'confirmado',
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
      pspPayloadMasked: maskPixPayload(parsed.raw), // ONLY the masked subset is storable
      confirmedAt: new Date().toISOString(),
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
]);

function createWebhookHandler({ loadEvents, appendEvent, recordPayment, psp, findCheckByTxid, fallback }) {
  if (!loadEvents || !appendEvent || !psp || !findCheckByTxid) {
    throw new Error('createWebhookHandler: missing dependencies');
  }
  const deps = { loadEvents, appendEvent, recordPayment, findCheckByTxid, fallback };

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
