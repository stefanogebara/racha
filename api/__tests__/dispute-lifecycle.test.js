'use strict';

/**
 * A DISPUTA, do começo ao fim.
 *
 * A revisão de compliance de 2026-09-08 enumerou a família inteira e mostrou
 * que só duas pontas eram lidas. Cada omissão custava algo:
 *
 *  - `evidence_details.due_by` era jogado fora. 40 dias corridos no Bizum, e
 *    perder o prazo é perder o dinheiro por INAÇÃO. A defesa inteira do prazo
 *    era um alerta best-effort que degrada pra stderr.
 *  - `dispute.closed` com `won` era ignorado, então a anomalia nunca saía e a
 *    conta ficava vermelha pra sempre — por uma disputa que a casa GANHOU. Um
 *    canário que grita sem parar é o modo de falha do inegociável #8.
 *  - a disputa PERDIDA virava estorno com `tipCents: 0`, deixando a gorjeta
 *    nos livros como paga com o dinheiro já ido (Lei 13.419).
 */

const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');
const { reconcileCheck } = require('../_lib/checks/reconcile');

const DIA = 86400000;

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
  };
  await store.registerCharge({
    checkId: check.id, txid: 'pi_x', amountCents: 3082, tipCents: 308, payerLabel: null, method: 'card',
  });
  await applyConfirmedPayment({
    kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308, method: 'card',
  }, deps);
  return { store, check, deps };
}

const estado = async (store, checkId) => reduce(await store.loadEvents(checkId));

describe('ciclo de vida da disputa', () => {
  test('o prazo de prova entra no razão e VIRA ACHADO na conciliação', async () => {
    const { store, check } = await mesaPaga();
    const dueBy = new Date(Date.now() + 3 * DIA).toISOString();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', {
      txid: 'pi_x', amountCents: 3390, reason: 'fraudulent', dueBy, status: 'needs_response',
    });

    const st = await estado(store, check.id);
    expect(st.payments.pi_x.disputeDueBy).toBe(dueBy);
    // O saldo NÃO se move: o dinheiro é do restaurante até o esquema decidir.
    expect(st.paidCents).toBe(3082);

    const r = reconcileCheck({
      checkId: check.id,
      events: await store.loadEvents(check.id),
      payments: [{ txid: 'pi_x', amountCents: 3082, tipCents: 308, status: 'confirmado', method: 'card' }],
    });
    const achado = r.findings.find((f) => f.code === 'dispute_evidence_due');
    expect(achado).toBeDefined();
    expect(achado.severity).toBe('high');
    expect(achado.dueBy).toBe(dueBy);
  });

  test('prazo VENCIDO é crítico — perder por inação é o pior jeito de perder', async () => {
    const { store, check } = await mesaPaga();
    const dueBy = new Date(Date.now() - 2 * DIA).toISOString();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', {
      txid: 'pi_x', amountCents: 3390, reason: 'fraudulent', dueBy,
    });
    const r = reconcileCheck({
      checkId: check.id,
      events: await store.loadEvents(check.id),
      payments: [{ txid: 'pi_x', amountCents: 3082, tipCents: 308, status: 'confirmado', method: 'card' }],
    });
    const achado = r.findings.find((f) => f.code === 'dispute_evidence_overdue');
    expect(achado).toBeDefined();
    expect(achado.severity).toBe('critical');
    expect(r.ok).toBe(false);
  });

  test('um prazo LONGE não é achado — canário que grita sempre ninguém olha', async () => {
    const { store, check } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', {
      txid: 'pi_x', amountCents: 3390, dueBy: new Date(Date.now() + 30 * DIA).toISOString(),
    });
    const r = reconcileCheck({
      checkId: check.id,
      events: await store.loadEvents(check.id),
      payments: [{ txid: 'pi_x', amountCents: 3082, tipCents: 308, status: 'confirmado', method: 'card' }],
    });
    expect(r.findings.some((f) => String(f.code).startsWith('dispute_evidence'))).toBe(false);
  });

  test('disputa GANHA limpa a marca — a conta para de aparecer vermelha', async () => {
    const { store, check, deps } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', {
      txid: 'pi_x', amountCents: 3390, reason: 'fraudulent',
      dueBy: new Date(Date.now() + 3 * DIA).toISOString(),
    });
    let st = await estado(store, check.id);
    expect(st.anomalies.some((a) => a.type === 'PAYMENT_DISPUTED')).toBe(true);

    const r = await applyConfirmedPayment({ kind: 'dispute_won', txid: 'pi_x', status: 'won' }, deps);
    expect(r.status).toBe('appended');

    st = await estado(store, check.id);
    // A anomalia SAI da projeção — e o log continua com o PAYMENT_DISPUTED
    // lá, com data e motivo (inegociável #6: nada sobrescreve história).
    expect(st.anomalies).toEqual([]);
    expect(st.payments.pi_x.disputedAmountCents).toBe(0);
    expect(st.payments.pi_x.disputeStatus).toBe('won');
    expect(st.payments.pi_x.disputeDueBy).toBeUndefined();
    const log = await store.loadEvents(check.id);
    expect(log.some((e) => e.type === 'PAYMENT_DISPUTED')).toBe(true);
    // E o dinheiro fica: a casa ganhou.
    expect(st.paidCents).toBe(3082);
    expect(st.tipCents).toBe(308);
    // O prazo deixa de ser achado, porque não há mais prova a apresentar.
    const rec = reconcileCheck({
      checkId: check.id,
      events: log,
      payments: [{ txid: 'pi_x', amountCents: 3082, tipCents: 308, status: 'confirmado', method: 'card' }],
    });
    expect(rec.findings.some((f) => String(f.code).startsWith('dispute_evidence'))).toBe(false);
  });

  test('disputa PERDIDA leva a gorjeta na proporção, não deixa ela nos livros', async () => {
    const { store, check, deps } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid: 'pi_x', amountCents: 3390 });

    // Chargeback do valor inteiro.
    const r = await applyConfirmedPayment({
      kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 3390, method: 'dispute',
    }, deps);
    expect(r.status).toBe('appended');
    await store.appendEvent(check.id, 'PAYMENT_DISPUTE_CLOSED', { txid: 'pi_x', outcome: 'lost' });

    const st = await estado(store, check.id);
    // O comportamento antigo mandava `tipCents: 0`, então a gorjeta continuava
    // "paga" com o dinheiro já ido — e a folha leria um número que não existe.
    expect(st.payments.pi_x.refundedAmountCents).toBe(3082);
    expect(st.payments.pi_x.refundedTipCents).toBe(308);
    expect(st.paidCents).toBe(0);
    expect(st.tipCents).toBe(0);
    // A marca de disputa sai (o desfecho está no saldo agora), mas fica
    // registrado que foi PERDIDA — não é a mesma coisa que nunca ter havido.
    expect(st.payments.pi_x.disputedAmountCents).toBe(0);
    expect(st.payments.pi_x.disputeStatus).toBe('lost');
    expect(st.anomalies.some((a) => a.type === 'PAYMENT_DISPUTE_CLOSED')).toBe(true);
  });

  test('a linha de pagamento de uma disputa perdida fica DEVOLVIDO, não confirmado', async () => {
    // Os dois stores faziam `kind === 'refund' ? 'devolvido' : 'confirmado'`.
    // Com a família da disputa lida de verdade, `dispute_lost` caía no `else` e
    // a linha ficava `confirmado` com o dinheiro já ido.
    const { store, check, deps } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid: 'pi_x', amountCents: 3390 });
    await applyConfirmedPayment({
      kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 3390, method: 'dispute',
    }, deps);
    const rows = await store.listChecksForReconcile((await store.getVenueForCheck(check.id)).id);
    const row = rows.flatMap((c) => c.payments).find((pp) => pp.txid === 'pi_x');
    expect(row.status).toBe('devolvido');
  });

  test('disputa GANHA deixa a linha CONFIRMADA — a casa manteve o dinheiro', async () => {
    const { store, check, deps } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid: 'pi_x', amountCents: 3390 });
    await applyConfirmedPayment({ kind: 'dispute_won', txid: 'pi_x', status: 'won' }, deps);
    const rows = await store.listChecksForReconcile((await store.getVenueForCheck(check.id)).id);
    const row = rows.flatMap((c) => c.payments).find((pp) => pp.txid === 'pi_x');
    expect(row.status).toBe('confirmado');
  });
});

describe('a resolução casa por CAMPO, não por texto', () => {
  test('fechar a disputa de um txid não mexe na anomalia de outro', async () => {
    // A primeira versão disto procurava o txid DENTRO da frase da anomalia.
    // Frágil de dois jeitos: uma anomalia de OUTRO pagamento que citasse o
    // mesmo id sairia junto, e mudar a redação quebraria a resolução em
    // silêncio — o pior tipo de quebra, porque o sintoma é uma conta que fica
    // vermelha e ninguém liga à mudança de uma string.
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 0, pspRecipientId: 'rcpt_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 6000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
    };
    // Dois pagamentos na mesma conta, os dois disputados.
    for (const txid of ['pi_a', 'pi_b']) {
      await store.registerCharge({
        checkId: check.id, txid, amountCents: 3000, tipCents: 0, payerLabel: null, method: 'card',
      });
      await applyConfirmedPayment({
        kind: 'payment_confirmed', txid, amountCents: 3000, tipCents: 0, method: 'card',
      }, deps);
      await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid, amountCents: 3000 });
    }
    let st = await estado(store, check.id);
    expect(st.anomalies.filter((a) => a.type === 'PAYMENT_DISPUTED').length).toBe(2);
    // Cada anomalia carrega o txid como CAMPO.
    expect(st.anomalies.map((a) => a.txid).sort()).toEqual(['pi_a', 'pi_b']);

    await applyConfirmedPayment({ kind: 'dispute_won', txid: 'pi_a', status: 'won' }, deps);
    st = await estado(store, check.id);
    const abertas = st.anomalies.filter((a) => a.type === 'PAYMENT_DISPUTED');
    expect(abertas.length).toBe(1);
    expect(abertas[0].txid).toBe('pi_b');
    // E o dinheiro dos dois continua lá: ganhar não move saldo.
    expect(st.paidCents).toBe(6000);
  });
});
