'use strict';

/**
 * A REVERSÃO DE ESTORNO, MEDIDA — quatro consertos da rodada de 53c9ff0 que
 * tinham prosa e não tinham teste.
 *
 * Os quatro são da mesma família: o caminho da reversão decide coisas caras (se
 * a testemunha do adquirente é verdadeira, se a entrega é nova ou repetida) e
 * cada decisão era invisível de fora. Um deles — a anomalia "sem id do estorno"
 * — estava MORTO em 100% das execuções por um `ReferenceError` na zona morta
 * temporal engolido por um `catch {}`, e a suíte inteira ficava verde, porque
 * nenhum teste perguntava se a anomalia existia (segurança HIGH-1 e compliance
 * HIGH-1 de 53c9ff0).
 *
 * Aqui a pergunta é sempre de SAÍDA: o que ficou no razão.
 */

const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');

/** Uma conta rachada entre dois pagadores em partes IGUAIS — o caso normal. */
async function mesaRachada() {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 6000 }]);
  const deps = {
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    // A REPARAÇÃO precisa destes dois: sem eles `repairRowFromLedger` sai calado
    // na primeira linha, e um teste que os omite prova que o reparo "funciona"
    // sem nunca chamá-lo.
    getPayment: store.getPayment.bind(store),
    repairPaymentRow: store.repairPaymentRow.bind(store),
  };
  for (const txid of ['pi_ana', 'pi_bruno']) {
    await store.registerCharge({
      checkId: check.id, txid, amountCents: 3000, tipCents: 300, payerLabel: null, method: 'card',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid, amountCents: 3000, tipCents: 300, method: 'card', eventId: `evt_pago_${txid}`,
    }, deps);
  }
  return { store, check, deps };
}

const eventos = async (store, checkId) => store.loadEvents(checkId);
const reversoes = (evs, txid) => evs.filter((e) => e.type === 'PAYMENT_REFUND_REVERSED'
  && e.payload && e.payload.txid === txid);
const anomalias = (evs) => evs.filter((e) => e.type === 'PAYMENT_ANOMALY').map((e) => e.payload);

test('a reversão de um pagador não consome a testemunha do outro', async () => {
  const { store, check, deps } = await mesaRachada();
  // Os dois são estornados pelo MESMO valor — partes iguais, é o que acontece.
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_bruno', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_bruno',
  }, deps);

  // A falha da Ana chega primeiro, e casa sozinha: testemunha VERDADEIRA.
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f_ana', refundId: 're_ana',
  }, deps);
  // A do Bruno chega depois. O lançamento dele é o único daquele valor NO
  // PAGAMENTO DELE — nada foi consumido. Sem o filtro por txid, a reversão da
  // Ana zerava o contador do Bruno e a testemunha dele virava `false`: o rateio
  // proporcional entrando no lugar do que o adquirente afirmou, e a devolução
  // por fora perdendo a autorização pra tirar da base da folha (Lei 13.419).
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_bruno', amountCents: 1100, eventId: 'evt_f_bruno', refundId: 're_bruno',
  }, deps);

  const evs = await eventos(store, check.id);
  expect(reversoes(evs, 'pi_ana').map((e) => e.payload.testemunhado)).toEqual([true]);
  expect(reversoes(evs, 'pi_bruno').map((e) => e.payload.testemunhado)).toEqual([true]);
  // E o dinheiro dos dois voltou ao que era antes do estorno.
  const st = reduce(evs);
  expect(st.payments.pi_ana.refundedAmountCents + st.payments.pi_ana.refundedTipCents).toBe(0);
  expect(st.payments.pi_bruno.refundedAmountCents + st.payments.pi_bruno.refundedTipCents).toBe(0);
});

test('reversão SEM id do estorno entra e GRITA — a anomalia existe mesmo', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  const r = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f_ana', refundId: null,
  }, deps);
  expect(r.status).toBe('appended');

  const alta = anomalias(await eventos(store, check.id))
    .filter((a) => a.severity === 'high' && /sem id do estorno/.test(a.reason || ''));
  // Uma, com o VALOR dentro: é o número que alguém confere no painel do
  // adquirente. Era ele que estourava na zona morta temporal.
  expect(alta.length).toBe(1);
  expect(alta[0].reason).toMatch(/1100/);
  expect(alta[0].txid).toBe('pi_ana');
});

test('sem id, a REENTREGA é pega pelo consumo — não reverte duas vezes', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: null,
  }, deps);
  // A casa estorna de novo, agora 1200 — outro lançamento, outro valor. Com ele
  // `jaEstornado` deixa de ser 0, e o ramo "reversão antes do estorno" não
  // segura mais nada. O que segura é o CONSUMO: o único lançamento de 1100 já
  // foi revertido, e a segunda entrega da mesma falha não tem com o que casar.
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1200, method: 'card', eventId: 'evt_est_ana_2',
  }, deps);
  // A LINHA DIVERGE do razão — é para isto que o reparo existe. Como ela
  // divergiu não importa (perda de escrita entre duas entregas em voo é o caso
  // real); o que importa é que a entrega repetida não passa por cima em
  // silêncio. Sem `repairRowFromLedger` neste ramo, a linha ficava `devolvido`
  // pra sempre e o painel contava como devolvido um dinheiro que está na casa.
  await store.recordPayment({ txid: 'pi_ana', status: 'devolvido' });
  expect((await store.getPayment('pi_ana')).status).toBe('devolvido');

  const segunda = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f2', refundId: null,
  }, deps);
  expect(segunda.status).toBe('duplicate');

  const evs = await eventos(store, check.id);
  expect(reversoes(evs, 'pi_ana').length).toBe(1);
  // O razão diz que sobrou dinheiro no pagamento; a linha voltou a dizer o mesmo.
  const st = reduce(evs);
  expect(st.payments.pi_ana.refundedAmountCents + st.payments.pi_ana.refundedTipCents).toBe(1200);
  expect((await store.getPayment('pi_ana')).status).toBe('confirmado');
});

test('a janela do deploy tem NOME: reversão com id sobre uma sem id do mesmo valor', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  // A primeira entrega é de ANTES do deploy: sem `re_` no razão, e não há como
  // preencher depois.
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: null,
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana_2',
  }, deps);
  // A segunda chega DEPOIS do deploy, com id. Reentrega ou falha nova? Não dá
  // pra saber — então aplica e grita, com valor e txid.
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f2', refundId: 're_novo',
  }, deps);

  const ambigua = anomalias(await eventos(store, check.id))
    .filter((a) => /reentrega ou falha nova/.test(a.reason || ''));
  expect(ambigua.length).toBe(1);
  expect(ambigua[0].severity).toBe('high');
  expect(ambigua[0].reason).toMatch(/1100/);
});

test('reversão ANTES do estorno é anomalia ALTA — ninguém reentrega um 200', async () => {
  const { store, check, deps } = await mesaRachada();
  const r = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: 're_x',
  }, deps);
  expect(r.status).toBe('out_of_order');
  const fora = anomalias(await eventos(store, check.id))
    .filter((a) => /antes do estorno/.test(a.reason || ''));
  expect(fora.length).toBe(1);
  // `info` mantinha em silêncio uma reversão DESCARTADA: dinheiro do cliente
  // sem dono no razão, com as duas projeções contando a mesma mentira.
  expect(fora[0].severity).toBe('high');
});

test('a segunda entrega do MESMO `re_` também reconcilia a linha', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: 're_x',
  }, deps);
  // `refund.failed` e `refund.updated` com status `failed` são a entrega NORMAL
  // da Stripe: dois `evt_`, o mesmo `re_`. A segunda é atalho, e o atalho também
  // é um lugar onde a linha pode estar velha.
  await store.recordPayment({ txid: 'pi_ana', status: 'devolvido' });
  const segunda = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f2', refundId: 're_x',
  }, deps);
  expect(segunda.status).toBe('duplicate');
  expect(reversoes(await eventos(store, check.id), 'pi_ana').length).toBe(1);
  expect((await store.getPayment('pi_ana')).status).toBe('confirmado');
});
