'use strict';

/**
 * Estorno PARCIAL, e por que ele é um teste de folha de pagamento.
 *
 * Dois defeitos que a revisão de compliance de 2026-09-08 achou juntos:
 *
 * 1. O adaptador rateava com `Math.min(tipCents, refunded)`, devolvendo a
 *    GORJETA INTEIRA antes de tocar o consumo. A gorjeta é remuneração do
 *    empregado (Lei 13.419/2017 + STJ Tema 1102) e o total dela é a base da
 *    folha, então escolher quem perde primeiro num estorno é decisão sobre o
 *    salário de alguém — e estava sendo tomada por ordem de subtração.
 * 2. `charge.amount_refunded` é ACUMULADO, e era lido como se fosse o valor
 *    daquele estorno. O segundo estorno parcial reapresentava o total, o
 *    `validateEvent` recusava, a rota devolvia 409, a Stripe reenviava e depois
 *    DESABILITAVA o endpoint — levando um `refund.failed` junto.
 */

const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');
const { reconcileCheck } = require('../_lib/checks/reconcile');

async function mesaPaga() {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 3082 }]);
  const deps = {
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
  };
  await store.registerCharge({
    checkId: check.id, txid: 'pi_x', amountCents: 3082, tipCents: 308,
    payerLabel: null, method: 'card',
  });
  // Consumo 3082 + gorjeta 308 = 3390 pagos.
  const r = await applyConfirmedPayment({
    kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308, method: 'card',
  }, deps);
  expect(r.status).toBe('appended');
  return { store, check, deps };
}

const estado = async (store, checkId) => reduce(await store.loadEvents(checkId));

describe('estorno parcial', () => {
  test('rateia proporcional: a gorjeta não é raspada primeiro', async () => {
    const { store, check, deps } = await mesaPaga();
    // R$ 5,00 de 33,90. A gorjeta é 9,08% do pago, então devolve ~45¢ dela.
    const r = await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, method: 'card',
    }, deps);
    expect(r.status).toBe('appended');

    const st = await estado(store, check.id);
    const pay = st.payments.pi_x;
    expect(pay.refundedTipCents).toBe(45);
    expect(pay.refundedAmountCents).toBe(455);
    // Exato: as duas partes somam o estorno, sem centavo criado nem perdido.
    expect(pay.refundedAmountCents + pay.refundedTipCents).toBe(500);
    // O comportamento ANTIGO devolvia 308 de gorjeta — o serviço todo. O
    // garçom fica com 263¢ que o código velho tirava dele.
    expect(pay.refundedTipCents).toBeLessThan(308);
    // E o total de gorjeta que a folha lê caiu só o proporcional.
    expect(st.tipCents).toBe(308 - 45);
  });

  test('o SEGUNDO estorno parcial funciona, em vez de virar 409 e derrubar o endpoint', async () => {
    const { store, check, deps } = await mesaPaga();
    await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, method: 'card',
    }, deps);
    // A Stripe manda o ACUMULADO: 500 + 400 = 900. O código antigo tratava 900
    // como um estorno novo de 900 sobre um pagamento que só tinha 400 de
    // gorjeta sobrando — `validateEvent` recusava e a rota devolvia 409.
    const r = await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 900, method: 'card',
    }, deps);
    expect(r.status).toBe('appended');

    const st = await estado(store, check.id);
    const pay = st.payments.pi_x;
    expect(pay.refundedAmountCents + pay.refundedTipCents).toBe(900);
    expect(st.paidCents).toBe(3082 - pay.refundedAmountCents);
    expect(st.anomalies).toEqual([]);
  });

  test('reenvio do mesmo acumulado é no-op, não estorno em dobro', async () => {
    const { store, check, deps } = await mesaPaga();
    await applyConfirmedPayment({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, method: 'card' }, deps);
    for (let i = 0; i < 3; i += 1) {
      const r = await applyConfirmedPayment({
        kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, method: 'card',
      }, deps);
      expect(r.status).toBe('duplicate');
    }
    const st = await estado(store, check.id);
    expect(st.payments.pi_x.refundedAmountCents + st.payments.pi_x.refundedTipCents).toBe(500);
  });

  test('estorno total devolve exatamente consumo e gorjeta', async () => {
    const { store, check, deps } = await mesaPaga();
    const r = await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 3390, method: 'card',
    }, deps);
    expect(r.status).toBe('appended');
    const st = await estado(store, check.id);
    expect(st.payments.pi_x.refundedAmountCents).toBe(3082);
    expect(st.payments.pi_x.refundedTipCents).toBe(308);
    expect(st.paidCents).toBe(0);
    expect(st.tipCents).toBe(0);
  });

  test('PSP dizendo ter devolvido mais do que recebeu é RECUSADO, não arredondado', async () => {
    const { deps } = await mesaPaga();
    const r = await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 5000, method: 'card',
    }, deps);
    expect(r.status).toBe('rejected');
    expect(r.reason).toMatch(/exceeds paid/);
  });
});

describe('estorno que FALHOU', () => {
  test('desfaz o lançamento e deixa a conta VERMELHA, em vez de verde e errada', async () => {
    // O pior estado possível, e era o estado real: a Stripe incrementa
    // `amount_refunded` quando o estorno é CRIADO, então o `charge.refunded`
    // já tinha entrado e o razão já dizia "estornado". Quando o
    // `refund.failed` chegava, o dinheiro tinha voltado pro restaurante e o
    // cliente ficado sem — e não havia como desfazer, porque a decisão
    // registrada era "não inventar evento".
    //
    // Resultado: cliente com dinheiro a receber, os DOIS registros nossos
    // dizendo que ele foi pago, e a conciliação comparando um com o outro,
    // concordando, e reportando VERDE. Um cliente lesado e um canário calado.
    // CDC art. 6º III e art. 42, § único.
    const { store, check, deps } = await mesaPaga();
    await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, method: 'card',
    }, deps);
    let st = await estado(store, check.id);
    expect(st.paidCents).toBe(3082 - 455);

    const r = await applyConfirmedPayment({
      kind: 'refund_failed', txid: 'pi_x', amountCents: 500, status: 'failed',
    }, deps);
    expect(r.status).toBe('appended');

    st = await estado(store, check.id);
    // O saldo volta ao que era: o dinheiro é do restaurante de novo.
    expect(st.paidCents).toBe(3082);
    expect(st.tipCents).toBe(308);
    expect(st.payments.pi_x.refundedAmountCents).toBe(0);
    expect(st.payments.pi_x.refundedTipCents).toBe(0);
    // E a conta fica MARCADA: sem isso ela voltaria a parecer normal, que é
    // exatamente o buraco. Alguém tem que reembolsar por outro caminho.
    expect(st.anomalies.length).toBe(1);
    expect(st.anomalies[0].type).toBe('PAYMENT_REFUND_REVERSED');
    expect(st.anomalies[0].reason).toMatch(/cliente ficou sem/);
  });

  test('a ida e a volta usam o MESMO rateio, então não divergem', async () => {
    const { store, check, deps } = await mesaPaga();
    await applyConfirmedPayment({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 777 }, deps);
    const meio = await estado(store, check.id);
    const tirado = {
      amount: meio.payments.pi_x.refundedAmountCents,
      tip: meio.payments.pi_x.refundedTipCents,
    };
    await applyConfirmedPayment({ kind: 'refund_failed', txid: 'pi_x', amountCents: 777 }, deps);
    const fim = await estado(store, check.id);
    // Devolveu exatamente o que tirou, centavo por centavo.
    expect(tirado.amount + tirado.tip).toBe(777);
    expect(fim.payments.pi_x.refundedAmountCents).toBe(0);
    expect(fim.payments.pi_x.refundedTipCents).toBe(0);
    expect(fim.paidCents).toBe(3082);
    expect(fim.tipCents).toBe(308);
  });

  test('reversão ANTES do estorno é REGISTRADA, não recusada nem aplicada', async () => {
    // Este teste mudou de sentido, e a mudança é o achado.
    //
    // Reverter o que não existe continua sendo inventar dinheiro, então não se
    // aplica (inegociável #6). Mas RECUSAR também estava errado: a Stripe não
    // garante ordem, `refund.failed` pode chegar antes do `charge.refunded`, e
    // 409 vira reenvio — que normalmente converge, mas se os reenvios se
    // esgotarem a reversão some PRA SEMPRE e o razão fica dizendo "estornado"
    // pra um dinheiro que voltou. E 409 repetido desabilita o endpoint.
    //
    // A terceira saída: registra a anomalia e devolve 200. Alto no NOSSO
    // sistema, não no contador de falhas da Stripe. Achado pela revisão de
    // segurança de 2026-09-08.
    const { store, check, deps } = await mesaPaga();
    const r = await applyConfirmedPayment({ kind: 'refund_failed', txid: 'pi_x', amountCents: 500 }, deps);
    expect(r.status).toBe('out_of_order');

    const st = await estado(store, check.id);
    // O dinheiro NÃO se mexeu — nada foi inventado.
    expect(st.paidCents).toBe(3082);
    expect(st.tipCents).toBe(308);
    expect(st.payments.pi_x.refundedAmountCents).toBe(0);
    // Mas a conta ficou marcada pra alguém olhar.
    expect(st.anomalies.some((a) => a.type === 'PAYMENT_ANOMALY' && a.txid === 'pi_x')).toBe(true);
  });

  test('reversão de txid desconhecido é recusada', async () => {
    const { deps } = await mesaPaga();
    const r = await applyConfirmedPayment({ kind: 'refund_failed', txid: 'pi_nunca', amountCents: 500 }, deps);
    expect(r.status).toBe('rejected');
  });
});

describe('valores impossíveis são recusa, não exceção', () => {
  test('valor negativo não vira 500 — vira 409 com motivo', async () => {
    // O `allocateRefund` estoura em valor negativo, de propósito: é o motor de
    // dinheiro e não deve inventar número. Mas uma exceção não tratada aqui
    // vira 500 `internal`, que a Stripe reenvia até DESABILITAR o endpoint —
    // levando os eventos que importam junto. Um valor impossível merece 409
    // com motivo, e o razão intocado.
    const { store, check, deps } = await mesaPaga();
    await applyConfirmedPayment({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500 }, deps);

    for (const amountCents of [-1, -500, 0]) {
      const r = await applyConfirmedPayment({ kind: 'refund_failed', txid: 'pi_x', amountCents }, deps);
      expect(r.status).toBe('rejected');
      expect(r.reason).toMatch(/inválido/);
    }
    for (const refundDeltaCents of [-1, -3390]) {
      const r = await applyConfirmedPayment({
        kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents, method: 'dispute',
      }, deps);
      expect(r.status).toBe('rejected');
      expect(r.reason).toMatch(/inválido/);
    }
    // ZERO mudou de sentido, e a mudança é o achado: a Stripe emite
    // `dispute.closed` de valor zero no encerramento de algumas consultas
    // prévias. Recusar isso virava 409 → reenvio → endpoint desabilitado, pela
    // coisa mais inofensiva que ela manda. Agora é no-op.
    const zero = await applyConfirmedPayment({
      kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 0, method: 'dispute',
    }, deps);
    expect(zero.status).toBe('duplicate');
    // E o razão não se mexeu em nenhuma das seis tentativas.
    const st = await estado(store, check.id);
    expect(st.payments.pi_x.refundedAmountCents + st.payments.pi_x.refundedTipCents).toBe(500);
  });
});

describe('o estorno parcial visto pelo RESTO do sistema', () => {
  /**
   * A regressão que eu mesmo criei ao consertar o estorno parcial, achada pela
   * revisão de compliance de 2026-09-08.
   *
   * O razão ficou certo — rateio proporcional, acumulado virando delta. Mas o
   * status da linha é tri-estado e não sabe dizer "parcialmente estornado".
   * Marcar `devolvido` num estorno de R$ 5,00 sobre R$ 33,90 fazia a
   * conciliação gritar pra sempre E o pagamento inteiro sumir do faturamento e
   * da gorjeta — desfazendo, no relatório, a correção feita no razão.
   */
  async function comEstornoParcial() {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 3082 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    };
    await store.registerCharge({
      checkId: check.id, txid: 'pi_x', amountCents: 3082, tipCents: 308, payerLabel: null, method: 'card',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308, method: 'card',
    }, deps);
    await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, method: 'card',
    }, deps);
    return { store, venue, check };
  }

  test('a conciliação NÃO acusa nada: a soma bate dos dois lados', async () => {
    const { store, venue, check } = await comEstornoParcial();
    const rows = (await store.listChecksForReconcile(venue.id))[0].payments;
    const r = reconcileCheck({
      checkId: check.id, events: await store.loadEvents(check.id), payments: rows,
    });
    // Antes: `status_lag` ALTO e `ledger_drift` CRÍTICO de −2890¢, pra sempre,
    // sem nada faltando de verdade. Um alerta que dispara em comportamento
    // correto está morto em duas semanas.
    expect(r.driftCents).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('a linha continua CONFIRMADA e diz quanto foi estornado', async () => {
    const { store, venue } = await comEstornoParcial();
    const row = (await store.listChecksForReconcile(venue.id))[0].payments.find((p) => p.txid === 'pi_x');
    expect(row.status).toBe('confirmado');
    expect(row.refundedAmountCents).toBe(455);
    expect(row.refundedTipCents).toBe(45);
  });

  test('o painel desconta só o estornado — a gorjeta cai 45¢, não 308¢', async () => {
    const { store, venue } = await comEstornoParcial();
    const panel = await store.getPanelView(venue.id);
    expect(panel.today.confirmedCents).toBe(3082 - 455);
    // O número que vai pra folha. Antes o pagamento sumia inteiro e a gorjeta
    // caía os 308¢ — desfazendo o rateio proporcional no relatório.
    expect(panel.today.tipsCents).toBe(308 - 45);
  });

  test('estorno TOTAL aí sim vira devolvido, e some do faturamento', async () => {
    const { store, venue, check } = await comEstornoParcial();
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    };
    await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 3390, method: 'card',
    }, deps);
    const row = (await store.listChecksForReconcile(venue.id))[0].payments.find((p) => p.txid === 'pi_x');
    expect(row.status).toBe('devolvido');
    const panel = await store.getPanelView(venue.id);
    expect(panel.today.confirmedCents).toBe(0);
    expect(panel.today.tipsCents).toBe(0);
    const r = reconcileCheck({
      checkId: check.id,
      events: await store.loadEvents(check.id),
      payments: (await store.listChecksForReconcile(venue.id))[0].payments,
    });
    expect(r.findings).toEqual([]);
  });
});
