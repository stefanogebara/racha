'use strict';

/**
 * A FORMA IMPOSSÍVEL CAI NO LADO SEGURO — defesa em profundidade, com teste.
 *
 * O tratador confere que a repartição que o casador aponta CABE nos baldes
 * vivos; não cabendo, a testemunha cai, sai anomalia e o proporcional entra.
 * Numa versão dessa guarda as duas condições exigiam `Number.isSafeInteger`, e
 * eu removi o mesmo teste do `casaOValor` chamando-o de guarda morta — "apagá-lo
 * não quebra teste nenhum". Nenhum teste quebrar significa que nenhum teste
 * cobre a forma, e uma repartição fracionária passava inteira: `{10.5, 9.5}`
 * casava com `aReverter = 20` e entrava no razão. Centavo fracionário, que é o
 * inegociável #5 (segurança LOW-2 da rodada treze).
 *
 * Não há entrada alcançável hoje — todo lançamento nasce de `allocateRefund`,
 * que é inteiro — e é por isso que este arquivo existe: profundidade sem teste é
 * profundidade que alguém remove no próximo commit com a justificativa errada.
 *
 * O casador é um MÓDULO, então a forma impossível entra por ele. `doMock` antes
 * do `require` do tratador, porque ele desestrutura a função no carregamento e
 * um espião sobre o objeto exportado não alcançaria a referência já ligada.
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');

test('uma repartição fracionária não entra no razão — vira proporcional e grita', async () => {
  let applyConfirmedPayment;
  jest.isolateModules(() => {
    jest.doMock('../_lib/checks/reversal-match', () => {
      const real = jest.requireActual('../_lib/checks/reversal-match');
      return {
        ...real,
        casarReversao: (...a) => {
          const r = real.casarReversao(...a);
          // Só quando ele testemunharia: é o caminho que usa a repartição.
          return r.decisao === 'aplicar' && r.testemunhado === true
            ? { ...r, amountCents: 10.5, tipCents: 9.5 }
            : r;
        },
      };
    });
    ({ applyConfirmedPayment } = require('../_lib/pay/webhook-handler'));
  });

  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Centavo', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  const mesa = await store.seedTable(venue.id, 'Mesa 1');
  const conta = await store.openCheck(mesa.qrToken, [{ id: 'i', name: 'Prato', priceCents: 3000 }]);
  const deps = {
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    getPayment: store.getPayment.bind(store),
    repairPaymentRow: store.repairPaymentRow.bind(store),
  };
  await store.registerCharge({
    checkId: conta.id, txid: 'pi_x', amountCents: 3000, tipCents: 300, payerLabel: null, method: 'card',
  });
  await applyConfirmedPayment({
    kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3000, tipCents: 300, method: 'card', eventId: 'e0',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 20, method: 'card', eventId: 'e1',
  }, deps);
  const r = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 20, eventId: 'e2', refundId: 're_1',
  }, deps);

  expect(r.status).toBe('appended');
  const evs = await store.loadEvents(conta.id);
  const rev = evs.filter((e) => e.type === 'PAYMENT_REFUND_REVERSED')[0];
  // INTEIROS, e não a repartição fracionária que o casador devolveu.
  expect(Number.isSafeInteger(rev.payload.amountCents)).toBe(true);
  expect(Number.isSafeInteger(rev.payload.tipCents)).toBe(true);
  // E sem testemunha: uma forma que o razão não sabe produzir não afirma nada.
  expect(rev.payload.testemunhado).toBe(false);
  expect(evs.some((e) => e.type === 'PAYMENT_ANOMALY'
    && /o adquirente aponta um estorno de/.test(e.payload.reason || ''))).toBe(true);
  // E o dinheiro continua inteiro do outro lado.
  const st = reduce(evs);
  expect(Number.isSafeInteger(st.paidCents)).toBe(true);
  expect(Number.isSafeInteger(st.tipCents)).toBe(true);
});
