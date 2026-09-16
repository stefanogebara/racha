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
      /**
       * Não se pode desfazer mais estorno do que existe. Um `refund.failed` que
       * chega duas vezes, ou pra um estorno que nunca entrou, é divergência —
       * alto, não absorvido.
       *
       * E o "que existe" NÃO INCLUI CHARGEBACK. Uma reversão desfaz um estorno
       * que FALHOU; uma disputa perdida não é um objeto `Refund` e não pode
       * falhar assim (`dispute_won` é outro evento). Com o chargeback somado
       * aqui, ele virava folga: uma reversão maior do que tudo o que o
       * adquirente estornou passava por esta guarda usando dinheiro que a rede
       * levou, e o razão devolvia pra conta — com a gorjeta junto, inflando a
       * base de cálculo da folha (Lei 13.419/2017; compliance HIGH-1 da rodada
       * onze).
       */
      if ((p.amountCents ?? 0) > (rev.refundedPeloTrilhoAmountCents || 0)) {
        invalid(`reversal exceeds refunded amount for txid ${p.txid}`);
      }
      if ((p.tipCents ?? 0) > (rev.refundedPeloTrilhoTipCents || 0)) {
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
  // A data do evento, quando o store a traz (`created_at` no Postgres e no
  // dublê). Opcional: um razão antigo, ou um teste que monta eventos à mão,
  // segue funcionando — quem lê trata `null` como "não sei".
  const quando = evt && typeof evt.created_at === 'string' ? evt.created_at : null;
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
        /**
         * Quanto do estornado veio de CHARGEBACK, e não de estorno.
         *
         * Os dois saem do mesmo `PAYMENT_REFUNDED` — é dinheiro saindo nos dois
         * casos — e por isso somam no mesmo acumulado. Mas o `amount_refunded`
         * que a Stripe manda em `charge.refunded` conta OBJETOS `Refund`, e uma
         * disputa não é um: ela nunca incrementa aquele número.
         *
         * Comparar o acumulado do adquirente com o NOSSO acumulado total, com
         * um chargeback dentro, é comparar duas coisas que não medem o mesmo.
         * Depois de um chargeback parcial o nosso ficava permanentemente à
         * frente, e todo estorno de verdade que viesse depois era classificado
         * como reentrega e ENGOLIDO — sem anomalia, sem log: o cliente com o
         * dinheiro de volta e o razão dizendo que a casa ainda o tem, com o
         * serviço dele na base de cálculo da folha (segurança HIGH-4 da rodada
         * dez; Lei 13.419/2017, inegociável #8).
         */
        /**
         * Quanto deste pagamento o ADQUIRENTE estornou — e ainda está estornado.
         *
         * `refunded*Cents` soma as três procedências (estorno, chargeback e a
         * devolução que o dono registrou no caixa) porque as três são dinheiro
         * saindo. Este par conta só a primeira, que é a única que o
         * `charge.amount_refunded` da Stripe conta — e a única que um
         * `refund.failed` pode desfazer.
         *
         * SOBE no estorno do trilho e DESCE na reversão. Contado ao contrário
         * (só o que veio de disputa, sem descer) ele ficava negativo depois de
         * uma reversão, e a régua do estorno cumulativo passava a engolir
         * estorno de verdade como reentrega (segurança HIGH-2 da rodada onze).
         */
        refundedPeloTrilhoAmountCents: 0,
        refundedPeloTrilhoTipCents: 0,
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
        /**
         * O MEIO, que o razão sempre recebeu e o redutor jogava fora.
         *
         * Ele decide o prazo do trilho de devolução (Pix, 90 dias; cartão, o do
         * adquirente) — e quem precisava dele ia buscar na LINHA de `payments`,
         * a projeção que a própria rota trata como melhor-esforço. Linha não
         * projetada, ou um 5xx passageiro do Supabase, e um Pix de 200 dias era
         * mandado de volta pro trilho que o BACEN fechou aos 90 (segurança e
         * compliance MEDIUM-4 de ec86b37). A fonte é o razão (inegociável #6).
         */
        method: typeof p.method === 'string' ? p.method : null,
        /**
         * QUANDO o dinheiro entrou — do EVENTO, que é imutável.
         *
         * É a data que decide se o trilho de devolução ainda está aberto (Pix,
         * 90 dias; cartão, 180). Ela vinha só da linha de `payments`, que a
         * própria rota trata como melhor-esforço: linha não projetada, ou um
         * 5xx passageiro, e a resposta virava "não sei a idade" — a marca
         * `critical` eterna pela porta da indisponibilidade. E sem ela no razão,
         * o `railImpossible: 'pix_90d'` gravado ali não podia ser re-derivado
         * por uma auditoria (compliance MEDIUM-4 de d7f2683).
         */
        confirmedAt: quando,
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
      // O que passou pelo ADQUIRENTE sobe também no acumulado do trilho — ver
      // `refundedPeloTrilhoAmountCents`. Chargeback e devolução do dono ficam de
      // fora, pelo predicado único (`estornoDoTrilho`).
      //
      // Dois campos e não um total: quem pergunta "quanto deste pagamento o
      // adquirente estornou" precisa da resposta por BALDE — é com ela que o
      // teto da reversão é calculado, que o rateio proporcional é feito e que a
      // validação da reversão decide.
      if (estornoDoTrilho({ type: 'PAYMENT_REFUNDED', payload: p })) {
        pay.refundedPeloTrilhoAmountCents = (pay.refundedPeloTrilhoAmountCents || 0) + amount;
        pay.refundedPeloTrilhoTipCents = (pay.refundedPeloTrilhoTipCents || 0) + tip;
      }
      next.paidCents -= amount;
      next.tipCents -= tip;
      // O estorno que ENFIM saiu abate o saldo revertido em aberto: a
      // testemunha do trilho impossível vale o que ainda não voltou.
      /**
       * O ABATE É POR BALDE, e o que passa de um NÃO come o outro.
       *
       * Antes o total era abatido pela soma e cada balde aparado em zero: um
       * estorno legítimo de OUTRO motivo — a mesa pedindo a remoção dos 10%,
       * inegociável #3 — zerava o total da testemunha de um estorno de consumo
       * que tinha falhado, e a rota passava a responder `nothing_to_restitute`
       * a um cliente a quem a casa devia R$ 20,00 (segurança HIGH-1 e
       * compliance HIGH-4 de 95f72a9). O razão afirmava o contrário do fato.
       *
       * O excedente de um balde vira ANOMALIA, não desconto no outro: o
       * adquirente não diz qual lançamento é qual, e engolir a diferença em
       * silêncio é a degradação que o inegociável #7 proíbe.
       */
      // SÓ QUANDO HÁ TESTEMUNHA EM ABERTO. Sem esta guarda, todo estorno comum
      // — que tem os baldes em zero — "passava do balde" e virava anomalia.
      if (!(pay.reversedOpenCents > 0)) return recompute(next);
      // ANTES do abate: o abate pode encerrar o episódio e apagar a marca de
      // testemunho, e é ela que decide a gravidade do aviso.
      const eraTestemunhado = pay.reversedOpenTestemunhado === true;
      const antesA = pay.reversedOpenAmountCents || 0;
      const antesT = pay.reversedOpenTipCents || 0;
      const sobrouA = Math.max(0, amount - (pay.reversedOpenAmountCents || 0));
      const sobrouT = Math.max(0, tip - (pay.reversedOpenTipCents || 0));
      pay.reversedOpenAmountCents = Math.max(0, (pay.reversedOpenAmountCents || 0) - amount);
      pay.reversedOpenTipCents = Math.max(0, (pay.reversedOpenTipCents || 0) - tip);
      pay.reversedOpenCents = pay.reversedOpenAmountCents + pay.reversedOpenTipCents;
      // EPISÓDIO ENCERRADO limpa a marca de testemunho: ela é dele, não do
      // pagamento (segurança HIGH-2 de 11a0904).
      if (pay.reversedOpenCents === 0) delete pay.reversedOpenTestemunhado;
      // A anomalia sai MESMO com o balde exaurido — é justamente aí que o
      // excedente some se ninguém falar. A guarda que eu tinha escrito exigia
      // saldo restante e calava o único caso que importa.
      // SÓ NO BALDE QUE A TESTEMUNHA DESCREVE. Com testemunha de consumo aberta,
      // todo estorno de GORJETA — a mesa exercendo a remoção dos 10%,
      // inegociável #3 — virava "além da testemunha": ruído por estorno, num
      // campo que a tela do cliente conta (segurança LOW-1 de 11a0904).
      const excedeuOBalde = (sobrouA > 0 && (antesA > 0)) || (sobrouT > 0 && (antesT > 0));
      if (excedeuOBalde) {
        /**
         * `high` quando a testemunha foi AFIRMADA: aí o adquirente contradisse
         * o que nós dissemos que ele disse — é o único sinal de que o casamento
         * pegou o lançamento errado, e `info` não acende o canário
         * (compliance MEDIUM-3 de 11a0904, inegociável #8).
         */
        return withAnomaly(recompute(next), seq, 'PAYMENT_ANOMALY',
          `estorno de ${p.txid} entregue além da testemunha daquele balde `
          + `(consumo +${sobrouA}, serviço +${sobrouT})`, p.txid,
          eraTestemunhado ? 'high' : 'info');
      }
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
      /**
       * E O ACUMULADO DO TRILHO DESCE JUNTO.
       *
       * Uma reversão desfaz um estorno que o adquirente tentou e não conseguiu —
       * sempre um do trilho (chargeback e devolução do dono não podem falhar
       * assim). Sem este decremento, o acumulado do trilho só subia: depois de
       * uma reversão ele afirmava um estorno vivo que não existe mais, e a régua
       * do estorno cumulativo passava a engolir estorno de VERDADE como
       * reentrega — cliente com o dinheiro de volta e o razão dizendo que a casa
       * o tem (segurança HIGH-2 da rodada onze).
       *
       * Não fica negativo: o `validateEvent` já recusa uma reversão maior do que
       * o acumulado do trilho, balde a balde — e essa guarda tem teste PRÓPRIO
       * no redutor desde a rodada doze, construído à mão em vez de passar pelo
       * tratador (que já a torna redundante, e por isso a escondia).
       *
       * SOBRE O RAZÃO JÁ GRAVADO: apertar este teto pode recusar, no replay,
       * uma reversão que o teto antigo aceitou — e aí uma conta vira de `paga`
       * pra `parcial` no instante do deploy. Medido em produção antes de subir:
       *
       *   with disputados as (
       *     select distinct payload->>'txid' as txid from check_events
       *     where type in ('PAYMENT_DISPUTED', 'PAYMENT_DISPUTE_CLOSED')
       *   )
       *   select
       *     (select count(*) from check_events where type = 'PAYMENT_REFUND_REVERSED') as reversoes,
       *     (select count(*) from check_events where type = 'PAYMENT_REFUNDED')        as estornos,
       *     (select count(*) from check_events where type = 'PAYMENT_REFUNDED'
       *          and (payload->>'offRail')::boolean is true)                           as fora_do_trilho,
       *     (select count(*) from disputados)                                          as pagamentos_disputados,
       *     (select count(*) from check_events e where e.type = 'PAYMENT_REFUNDED'
       *          and e.payload->>'txid' in (select txid from disputados)
       *          and not (e.payload ? 'disputeId') and not (e.payload ? 'deDisputa'))  as disputa_sem_marca;
       *
       * Em 2026-09-16: reversoes 0, estornos 1, fora_do_trilho 0,
       * pagamentos_disputados 0, disputa_sem_marca 0. Raio de alcance zero.
       *
       * A PRIMEIRA VERSÃO DESTA CONSULTA MEDIA VÁCUO. Ela filtrava
       * `payload->>'method' = 'dispute'`, e `method` NUNCA é gravado num payload
       * de `PAYMENT_REFUNDED` — o construtor só o acrescenta em
       * `PAYMENT_CONFIRMED`. O filtro era `NULL` pra toda linha que este código
       * já escreveu, então ela devolveria zero com um milhão de linhas sujas no
       * banco — e esse zero estava citado aqui como a evidência que autoriza
       * apertar o teto (segurança HIGH-3 da rodada treze). A versão acima acha a
       * procedência pelo único lugar onde ela existe de verdade no razão antigo:
       * os eventos de DISPUTA do mesmo txid. `pagamentos_disputados = 0` é o que
       * torna o `disputa_sem_marca = 0` uma medição e não um artefato.
       *
       * Se um dia não for zero, o número sai daqui ANTES do deploy, e não da
       * primeira mesa que reclamar.
       */
      pay.refundedPeloTrilhoAmountCents = (pay.refundedPeloTrilhoAmountCents || 0) - amount;
      pay.refundedPeloTrilhoTipCents = (pay.refundedPeloTrilhoTipCents || 0) - tip;
      next.paidCents += amount;
      next.tipCents += tip;
      // O VALOR entra na anomalia: é o que o cliente tem a receber, e a tela
      // dele deriva o número daqui. Sem ele o aviso saía com o saldo NÃO
      // estornado do pagamento — num estorno de R$ 50 sobre R$ 100 que falha,
      // o telefone dizia "você tem R$ 100 a receber". Um número errado é pior
      // que nenhum: manda a pessoa discutir no caixa por uma quantia que
      // ninguém deve. Achado pela revisão de segurança de 2026-09-08.
      /**
       * O SALDO REVERTIDO EM ABERTO — o fato, não o aviso, e com TAMANHO.
       *
       * A anomalia é a PROJEÇÃO: ela existe pra tela do cliente e some quando
       * alguém resolve a pendência. Mas "o estorno deste pagamento falhou" é um
       * fato do razão, e era ele que autorizava a devolução por fora. Resolver a
       * pendência primeiro — a ordem natural, porque é a marca mais barulhenta e
       * a que o cliente vê — apagava a testemunha e trancava a devolução PRA
       * SEMPRE, com a recusa mandando usar um trilho que já tinha falhado
       * (compliance HIGH-1 de ec86b37).
       *
       * A primeira versão disto era um `true` que nunca saía, e isso abria a
       * porta do outro lado: uma reversão de dez centavos sobre um estorno de
       * cem reais destrancava a atestação do pagamento INTEIRO, pra sempre,
       * mesmo depois de o estorno ser refeito com sucesso pelo adquirente
       * (compliance MEDIUM-1 de d7f2683). Agora o campo tem tamanho e o
       * `PAYMENT_REFUNDED` seguinte o abate: a testemunha vale exatamente o que
       * o adquirente deixou de devolver.
       */
      pay.reversedOpenAmountCents = (pay.reversedOpenAmountCents || 0) + amount;
      pay.reversedOpenTipCents = (pay.reversedOpenTipCents || 0) + tip;
      pay.reversedOpenCents = pay.reversedOpenAmountCents + pay.reversedOpenTipCents;
      /**
       * E A REPARTIÇÃO FOI TESTEMUNHADA, ou é palpite nosso?
       *
       * O `refund.failed` traz um TOTAL. Quando o webhook consegue casar esse
       * total com UM lançamento do razão, os baldes são o que aquele lançamento
       * de fato usou — aí a testemunha manda no rateio da devolução por fora.
       * Quando não casa, a repartição é `allocateProportional`, e um palpite
       * nosso não pode ter autoridade de adquirente pra tirar dinheiro da base
       * da folha (compliance HIGH-1 de 95f72a9). Um razão ANTIGO não tem o
       * campo: `undefined` é tratado como não testemunhado, que é o lado seguro.
       */
      /**
       * DO EPISÓDIO, não do pagamento.
       *
       * Era um AND sobre a vida inteira do pagamento: a primeira reversão não
       * testemunhada cravava `false` PRA SEMPRE, e uma reversão genuinamente
       * casada meses depois — já com o saldo do episódio anterior zerado — caía
       * no proporcional. Medido: R$ 8,26 de serviço que VOLTOU ao cliente
       * ficando na base da folha, por causa de um episódio encerrado (segurança
       * HIGH-2 de 11a0904). O campo é zerado junto com os baldes, no abate.
       */
      pay.reversedOpenTestemunhado = p.testemunhado === true
        && (pay.reversedOpenTestemunhado !== false);
      // EM DOIS BALDES, e o total DERIVADO deles.
      //
      // Colapsado num número só, a devolução por fora de um pagamento pontual
      // caía no rateio proporcional: um estorno de R$ 50 só de CONSUMO que falha
      // tirava R$ 4,55 da base da folha sobre dinheiro que nunca foi gorjeta — e
      // o espelho deixava R$ 9,09 de serviço na folha depois de ele ter voltado
      // ao cliente (compliance HIGH-2 de a95e15c; Lei 13.419/2017, STJ Tema 1102
      // e CLT art. 462, que não deixa descontar depois).
      //
      // O total tinha aritmética PRÓPRIA, e os três números derivavam entre si:
      // um estorno que passasse de um balde corroía o outro pelo total, e aí
      // `estornoFalhou` (que lê o total) dizia "não há estorno em aberto"
      // enquanto o balde ainda dizia que havia. Ver o abate, abaixo.
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
/**
 * ESTE ESTORNO PASSOU PELO ADQUIRENTE?
 *
 * Três coisas viram `PAYMENT_REFUNDED` porque as três são dinheiro saindo: o
 * estorno do adquirente, o CHARGEBACK (`dispute_lost`) e a devolução que o DONO
 * registrou no caixa (`offRail`). Só a primeira é um objeto `Refund` da Stripe.
 *
 * A diferença não é acadêmica: `charge.amount_refunded` — o acumulado que o
 * adquirente manda — conta objetos `Refund` e nada mais. Toda régua nossa que
 * for comparada com aquele número, ou que perguntar "quanto deste pagamento o
 * adquirente estornou", tem que usar ESTE predicado. Houve três cópias
 * divergentes dele nesta série, cada uma cobrindo um subconjunto diferente, e
 * cada uma custou um achado ALTO (rodadas dez e onze). Agora é um só, e quem
 * precisa importa.
 */
/**
 * ESTE ESTORNO VEIO DE UMA DISPUTA? — a outra metade da mesma pergunta.
 *
 * Derivada, não copiada. A quarta cópia inline deste predicado nasceu na
 * conciliação (`(deDisputa === true || disputeId)`) no mesmo commit em que o
 * parágrafo abaixo dizia "houve três cópias divergentes, cada uma custou um
 * achado ALTO; agora é um só, e quem precisa importa". Medido: apagar o ramo do
 * `deDisputa` da cópia não quebrava nenhum teste, e com ele apagado um
 * chargeback fechado SEM `dp_` — o cinto cego — deixava de contar como disputa,
 * e a conciliação mandava o dono dar baixa no prejuízo inteiro (segurança
 * MEDIUM-2 da rodada catorze).
 *
 * `offRail` fica de fora dos dois lados: a devolução que o dono registrou no
 * caixa não é do trilho NEM é disputa — é a terceira procedência.
 */
function marcadoComoDisputa(e) {
  if (!e || e.type !== 'PAYMENT_REFUNDED' || !e.payload) return false;
  if (e.payload.offRail === true) return false;
  return !estornoDoTrilho(e);
}

function estornoDoTrilho(e) {
  if (!e || e.type !== 'PAYMENT_REFUNDED' || !e.payload) return false;
  if (e.payload.offRail === true) return false;
  // `deDisputa` é a marca derivada do KIND; `disputeId` é o `dp_` quando ele
  // veio. As duas respondem a mesma pergunta, e a primeira responde também
  // quando o adquirente fechou a disputa sem id — o caso do "cinto cego".
  if (e.payload.deDisputa === true) return false;
  if (e.payload.disputeId) return false;
  return true;
}

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
 * `sempreDevido`: a parte do pagamento que a SOBRA DA CONTA cobre é duplicidade
 * — o razão já mostrava a conta quitada e este pagamento entrou por cima — e o
 * serviço PROPORCIONAL a ela é a devolver de qualquer jeito, não uma pergunta
 * sobre o caixa (`ceil(servico * d / l)`, a favor de quem pagou). Vale na
 * duplicidade PARCIAL também; a versão anterior deste texto dizia "consumo
 * inteiro", que era a regra de antes (compliance MEDIUM-2 de 41d1244, redação
 * LOW-1 de ec86b37).
 *
 * E ATENÇÃO ao que ele NÃO cobre: a mesa que pagou NO CAIXA não produz sobra
 * nenhuma no razão (o Racha não registra o caixa), então ali `sempreDevido` é
 * zero e a marca inteira é `pergunta`. Ver `refund-allocation.js`.
 *
 * RESPONDIDO sai: `PAYMENT_ISSUE_RESOLVED` ESCOPADO (`scope: 'paid_after_close'`)
 * marca `lateResolved` — a mesa não pagou no caixa. Sem resposta, a pergunta fica.
 */
/**
 * QUANTO A CONTA NÃO PRECISOU de cada pagamento atrasado, em centavos de
 * CONSUMO BRUTO — a medida de duplicidade que não evapora quando o principal é
 * devolvido.
 *
 * As três rodadas de revisão mediram três buracos, e todos eram o mesmo: a
 * duplicidade estava sendo lida de um número que congela (`excessCents`, de
 * quando o pagamento entrou) ou que some (`d`, a fatia da sobra VIVA, que vira
 * zero quando o líquido vira zero).
 *
 *  · congelado: um pagamento que VIRA duplicado depois — um estorno que falha
 *    devolve dinheiro à conta depois do fecho — tinha excedente zero, e o
 *    serviço dele caía como pergunta com botão (compliance HIGH-1 de 41b188a);
 *  · vivo: devolvido o principal, `d` zera e o serviço devido sumia junto
 *    (compliance HIGH-1 de d7f2683); e a lembrança que eu somei pra consertar
 *    isso era limitada pelo congelado, que é zero justamente na população que
 *    ela existia pra cobrir — então a MESMA dupla de fatos em ordem trocada dava
 *    R$ 6,00 de diferença (segurança HIGH-1 de 089e8a2).
 *
 * Aqui a pergunta é outra, e não depende de ordem nem de estorno: quanto do
 * consumo deste pagamento a conta PRECISOU? O que os outros pagamentos já
 * cobrem (líquido) atende a conta primeiro; os atrasados cobrem o que faltar, do
 * MAIS VELHO pro mais novo — quem chegou por último é quem duplicou. O que
 * sobra do bruto de cada um é o que não foi preciso, tenha voltado ou não.
 *
 * E a mesa que pagou NO CAIXA continua sem duplicidade nenhuma, corretamente: o
 * razão não registra o caixa, então a conta "precisou" daquele pagamento.
 */
function naoNecessarioDosAtrasados(state) {
  const fora = new Map();
  if (!state) return fora;
  const liquido = (p) => Math.max(0, p.amountCents - (p.refundedAmountCents || 0));
  /**
   * O QUE ESTÁ RETIDO POR UM ESTORNO QUE FALHOU NÃO COBRE A CONTA.
   *
   * O `PAYMENT_REFUND_REVERSED` devolve o valor a `paidCents` E grava a
   * testemunha. Os mesmos centavos viravam, ao mesmo tempo, sobra da conta
   * (endereçada ao atrasado mais novo) e "você tem a receber" do pagador
   * original — dois endereços, e a casa pagando R$ 120 sobre R$ 60 de sobra,
   * cada ação justificada pelo que a tela mostrava (compliance HIGH-1 de
   * a95e15c). Dinheiro que já tem dono não cobre conta de ninguém.
   */
  // O CONSUMO da testemunha, só. `liquido`, `falta` e o pote da sobra são
  // grandezas de CONSUMO — `overpaidCents` é `paidCents - totalCents`, e gorjeta
  // nunca entra em `paidCents`. Descontando o total (consumo + serviço), uma
  // reversão de GORJETA comia sobra de consumo de outro pagador: a duplicidade
  // dele encolhia e o serviço `sempreDevido` caía junto (segurança MEDIUM-1 e
  // compliance HIGH-3 de 95f72a9). O lado da gorjeta já é servido pelo teto.
  /**
   * E AQUI O BALDE ENTRA MESMO SEM TESTEMUNHO — de propósito, com o lado do erro
   * escolhido.
   *
   * Quando a reversão não casou com um lançamento, o balde é a repartição
   * proporcional: palpite nosso. Ele não manda no RATEIO de uma devolução (isso
   * é `reversedOpenTestemunhado`), mas entra aqui, e por aqui chega ao
   * `servicoDevido`. A divergência é a fração de gorjeta do que já foi estornado
   * — da ordem de R$ 0,91 em R$ 10,00 — e ela cai para o lado de DEIXAR serviço
   * na folha, não de tirar. É o lado defensável: a CLT art. 462 não deixa
   * descontar depois, então errar para menos é o erro que se conserta
   * (compliance MEDIUM-1 de 11a0904).
   */
  const cobre = (p) => Math.max(0, liquido(p) - Math.max(0, p.reversedOpenAmountCents || 0));
  // TODOS os pagamentos, na ordem do razão — não só os atrasados. A sobra de uma
  // conta REDUZIDA no PDV, ou de uma duplicidade anterior ao fecho, também
  // precisa de endereço: sem ele o painel dizia "a devolver" sem nenhuma
  // cobrança embaixo (segurança MEDIUM-2 de a95e15c).
  const todos = Object.entries(state.payments);
  let falta = Math.max(0, state.totalCents || 0);
  // Do MAIS VELHO pro mais novo: a ordem de `Object.entries` é a de inserção, e
  // o redutor insere na ordem do razão.
  for (const [txid, p] of todos) {
    // BRUTO pra medir ESTE, o que COBRE pra descontar.
    //
    // O bruto é o que faz a duplicidade sobreviver à devolução do principal. Mas
    // quem COBRE a conta é o que ainda está lá: descontando o bruto dos outros,
    // um atrasado que já devolveu quase tudo "consumia" a necessidade da conta e
    // empurrava a duplicidade pro seguinte — que passava a dever serviço sobre
    // dinheiro que a conta precisava. Medido pela propriedade 2 da suíte.
    const bruto = Math.max(0, p.amountCents || 0);
    fora.set(txid, Math.max(0, bruto - falta));
    falta -= Math.min(cobre(p), falta);
  }
  return fora;
}

/**
 * A SOBRA QUE CADA PAGAMENTO AINDA DEVE — por txid, em centavos.
 *
 * É a resposta para "qual cobrança eu estorno, e de quanto?", e havia QUATRO
 * lugares respondendo isso por conta própria, todos pelo excedente CONGELADO: o
 * teto da devolução por fora, o `overpaidTxids` dos dois stores (a linha que o
 * painel desenha embaixo da mesa) e o relógio da conciliação. Na duplicidade que
 * nasce DEPOIS — um estorno que falha e devolve dinheiro à conta — o congelado é
 * zero, e o resultado era: o painel mostrando "a devolver R$ 60,00" sem nenhuma
 * cobrança embaixo (com o runbook mandando devolver "pelo valor ao lado da
 * cobrança"), o teto saindo R$ 6,00 para uma dívida de R$ 66,00, e a dívida
 * envelhecendo pela data errada (compliance HIGH-1 de 089e8a2).
 *
 * Aqui os dois se juntam: o congelado responde pelo pagamento que entrou com
 * excedente (o cliente digitou um número maior no app do banco), e o vivo — o
 * que a conta não precisou, menos o que já voltou — responde pelo atrasado que
 * duplicou. Limitado ao líquido do pagamento e à sobra ATUAL da conta, que é o
 * que a casa de fato tem a mais.
 */
function sobraPorPagamento(state) {
  const out = new Map();
  if (!state) return out;
  const naoNecessario = naoNecessarioDosAtrasados(state);
  const entradas = Object.entries(state.payments);
  for (const [txid] of entradas) out.set(txid, 0);
  let restante = Math.max(0, state.overpaidCents || 0);
  const liquido = (p) => Math.max(0, (p.amountCents || 0) - Math.max(0, p.refundedAmountCents || 0));
  const dar = (txid, quanto) => {
    const dado = Math.max(0, Math.min(quanto, restante));
    if (dado <= 0) return;
    out.set(txid, (out.get(txid) || 0) + dado);
    restante -= dado;
  };

  /**
   * PRIMEIRO quem teve o estorno falhado: a reversão RECRIOU a sobra, e ela é
   * dele. Depois, do mais NOVO pro mais velho, quem a conta não precisou —
   * a mesma convenção do `paidAfterClose`.
   *
   * E é RATEIO, não teto por pagamento. O `min(..., overpaidCents)` aplicado a
   * cada um separadamente deixava a SOMA passar do que a casa deve: três
   * pagando a conta inteira e um estorno parcial davam R$ 300 de linhas sobre
   * R$ 270 de dívida — e o runbook manda devolver "pelo valor ao lado da
   * cobrança", linha por linha (segurança MEDIUM-1 de a95e15c).
   */
  for (const [txid, p] of entradas) {
    dar(txid, Math.min(Math.max(0, p.reversedOpenAmountCents || 0), liquido(p)));
  }
  for (const [txid, p] of [...entradas].reverse()) {
    const congelado = Math.max(0, (p.excessCents || 0) - Math.max(0, p.refundedAmountCents || 0));
    const vivo = Math.max(0, (naoNecessario.get(txid) || 0) - Math.max(0, p.refundedAmountCents || 0));
    const teto = Math.min(liquido(p), Math.max(congelado, vivo));
    dar(txid, Math.max(0, teto - (out.get(txid) || 0)));
  }
  for (const [txid, valor] of [...out]) if (valor === 0) out.delete(txid);
  return out;
}

function paidAfterClose(state) {
  if (!state) return [];
  // TODOS os atrasados entram no rateio da sobra — os respondidos também. A
  // resposta de uma linha não mexe mais no valor das irmãs, e a parte do serviço
  // que corresponde à duplicidade continua devida depois da resposta (segurança
  // MEDIUM-1 e compliance MEDIUM-C de 57c0d2e).
  const atrasados = Object.entries(state.payments).filter(([, p]) => p.late);
  const liquido = (p) => Math.max(0, p.amountCents - (p.refundedAmountCents || 0));
  /**
   * A SOBRA DE CADA UM vem do MESMO rateio que endereça a linha do painel.
   *
   * Aqui havia um segundo rateio, próprio, do mais novo pro mais velho sobre os
   * atrasados — e depois que a sobra criada por uma reversão passou a pertencer
   * a quem perdeu o estorno, os dois discordavam: o painel mandava estornar uma
   * cobrança e a marca da mesa descontava de outra (compliance HIGH-1 de
   * a95e15c). Um rateio só, duas leituras.
   */
  const duplicado = sobraPorPagamento(state);
  const naoNecessario = naoNecessarioDosAtrasados(state);
  const out = [];
  for (const [txid, p] of atrasados) {
    const l = liquido(p);
    const d = Math.min(liquido(p), duplicado.get(txid) || 0);
    const servico = Math.max(0, (p.tipCents || 0) - (p.refundedTipCents || 0));
    /**
     * O SERVIÇO ACOMPANHA O CONSUMO — pela duplicidade COMO ELA CHEGOU, não
     * pelo que sobrou dela.
     *
     * A fração devida sai de `excessCents / amountCents`, os dois do momento em
     * que o pagamento entrou, e desconta o que já voltou de gorjeta. A versão
     * anterior usava o LÍQUIDO (`d / l`), e aí a marca se apagava sozinha
     * justamente quando a casa fazia a coisa certa: devolvido o consumo
     * duplicado, `l` e `d` viram zero, `servicoDevido` vira zero, e os 10%
     * que nunca foram serviço prestado deixavam de ser "devidos de qualquer
     * jeito" e viravam PERGUNTA — com botão. Um clique em "não pagou no caixa"
     * apagava dinheiro do cliente e deixava o valor na base da folha (Lei
     * 13.419/2017 + STJ Tema 1102). Medido pela revisão de compliance de
     * d7f2683 (HIGH-1): a ordem dos cliques voltava a decidir dinheiro, agora
     * pelo caminho devolver→responder.
     *
     * Pela duplicidade original a marca sobrevive ao estorno do principal, e só
     * some quando o próprio serviço volta. O invariante da soma não muda: o
     * termo `servicoDevido` se cancela entre a pergunta e a marca.
     */
    const base = Math.max(0, p.amountCents || 0);
    // O que a conta NÃO PRECISOU deste pagamento — ver `naoNecessarioDosAtrasados`.
    const naoPreciso = naoNecessario.get(txid) || 0;
    const devidoBruto = base > 0 ? Math.ceil(((p.tipCents || 0) * naoPreciso) / base) : 0;
    // O que já voltou de gorjeta abate: a marca não pede de volta o que a casa
    // já devolveu. E nunca mais do que ainda há de gorjeta.
    const servicoDevido = Math.max(0, Math.min(servico, devidoBruto - (p.refundedTipCents || 0)));
    const pergunta = (l - d) + (servico - servicoDevido);
    if (!p.lateResolved && pergunta > 0) out.push({ txid, amountCents: pergunta });
    if (servicoDevido > 0) out.push({ txid, amountCents: servicoDevido, sempreDevido: true });
  }
  return out;
}

module.exports = {
  estornoDoTrilho, marcadoComoDisputa,
  ANOMALY_SEVERITIES,
  STATUS, EVENT_TYPES, EventValidationError,
  reduce, applyEvent, validateEvent, remainingCents, lateTxids, paidAfterClose,
  naoNecessarioDosAtrasados, sobraPorPagamento, initialState,
};
