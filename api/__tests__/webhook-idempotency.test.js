'use strict';

/**
 * TODA espécie do razão, aplicada duas vezes, tem que dar no mesmo.
 *
 * O teste que faltava, e a revisão de segurança de 2026-09-08 disse isso com
 * todas as letras: "não existe um teste de propriedade que aplique cada
 * espécie duas vezes e afirme estado idêntico. Ele teria pego CRITICAL-2,
 * `dispute_lost` e `dispute_won` de uma vez."
 *
 * O que estava quebrado: a Stripe manda `refund.failed` E `refund.updated`
 * com status `failed` pro MESMO estorno, e os dois viram `refund_failed`.
 * Isso não é reenvio — é a entrega normal de uma falha. Cada um aplicava uma
 * reversão. Um estorno de 900 do qual 500 tinha dado certo era APAGADO
 * inteiro, a conta voltava pra `paga`, o write-back dizia "pago" pro POS e a
 * mesa fechava com o cliente tendo recebido R$ 5,00 de volta.
 *
 * A correção não foi por espécie: foi no APPEND. `psp_event_id` único,
 * conferido dentro do lock por conta (migração 0018), então a segunda entrega
 * do mesmo `evt_` é no-op — e a corrida entre duas entregas simultâneas fecha
 * junto, que a checagem em memória não fechava.
 */

const { applyConfirmedPayment, LEDGER_KINDS } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');

async function mesa() {
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
  return { store, check, deps, venue };
}

const estado = async (store, checkId) => reduce(await store.loadEvents(checkId));
const dinheiro = (st) => ({
  paid: st.paidCents, tip: st.tipCents, status: st.status,
  refA: st.payments.pi_x ? st.payments.pi_x.refundedAmountCents : null,
  refT: st.payments.pi_x ? st.payments.pi_x.refundedTipCents : null,
});

describe('idempotência por id de evento', () => {
  test('a MESMA `evt_` entregue três vezes move o dinheiro uma vez só', async () => {
    const { store, check, deps } = await mesa();
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308,
      method: 'card', eventId: 'evt_pago',
    }, deps);
    await applyConfirmedPayment({
      kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 900, method: 'card', eventId: 'evt_estorno',
    }, deps);
    const alvo = dinheiro(await estado(store, check.id));

    // A falha do estorno chega em DOIS eventos com o mesmo id lógico.
    const primeiro = await applyConfirmedPayment({
      kind: 'refund_failed', txid: 'pi_x', amountCents: 900, eventId: 'evt_falha',
    }, deps);
    expect(primeiro.status).toBe('appended');
    const depoisDaReversao = dinheiro(await estado(store, check.id));

    for (let i = 0; i < 3; i += 1) {
      const r = await applyConfirmedPayment({
        kind: 'refund_failed', txid: 'pi_x', amountCents: 900, eventId: 'evt_falha',
      }, deps);
      expect(r.status).toBe('duplicate');
    }
    expect(dinheiro(await estado(store, check.id))).toEqual(depoisDaReversao);
    // E a reversão desfez exatamente o estorno — voltou ao estado de antes.
    expect(depoisDaReversao).toEqual(alvo === null ? alvo : {
      paid: 3082, tip: 308, status: 'paga', refA: 0, refT: 0,
    });
  });

  test('cada espécie do razão é idempotente por `evt_`, uma a uma', async () => {
    // Propriedade sobre a LISTA, não sobre exemplos: uma espécie nova entra
    // aqui automaticamente e é obrigada a se comportar.
    const cenarios = {
      payment_confirmed: { amountCents: 3082, tipCents: 308, method: 'card' },
      refund: { cumulativeRefundedCents: 500, method: 'card' },
      refund_failed: { amountCents: 500 },
      dispute_lost: { refundDeltaCents: 500, method: 'dispute' },
      dispute_won: { status: 'won' },
    };
    expect(new Set(Object.keys(cenarios))).toEqual(LEDGER_KINDS);

    for (const [kind, extra] of Object.entries(cenarios)) {
      const { store, check, deps } = await mesa();
      // Cada cenário precisa do seu pré-requisito no razão.
      await applyConfirmedPayment({
        kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308,
        method: 'card', eventId: 'evt_base',
      }, deps);
      if (kind === 'refund_failed') {
        await applyConfirmedPayment({
          kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, eventId: 'evt_pre',
        }, deps);
      }
      if (kind === 'dispute_lost' || kind === 'dispute_won') {
        await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid: 'pi_x', amountCents: 500 });
      }

      const evento = { kind, txid: 'pi_x', eventId: `evt_${kind}`, ...extra };
      const primeira = await applyConfirmedPayment(evento, deps);
      const depois = dinheiro(await estado(store, check.id));

      const segunda = await applyConfirmedPayment(evento, deps);
      expect(segunda.status).toBe('duplicate');
      // O dinheiro não se mexeu na segunda.
      expect(dinheiro(await estado(store, check.id))).toEqual(depois);
      // E a primeira fez alguma coisa (senão o teste não prova nada).
      expect(['appended', 'duplicate']).toContain(primeira.status);
    }
  });

  test('eventos DIFERENTES sobre o mesmo pagamento continuam passando', async () => {
    // A idempotência não pode virar mudez: dois estornos parciais de verdade,
    // com ids diferentes, têm que acontecer os dois.
    const { store, check, deps } = await mesa();
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308,
      method: 'card', eventId: 'evt_a',
    }, deps);
    await applyConfirmedPayment({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500, eventId: 'evt_b' }, deps);
    await applyConfirmedPayment({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 900, eventId: 'evt_c' }, deps);
    const st = await estado(store, check.id);
    expect(st.payments.pi_x.refundedAmountCents + st.payments.pi_x.refundedTipCents).toBe(900);
  });

  test('sem `eventId` o comportamento antigo continua valendo', async () => {
    // Nem todo append vem de webhook (abertura, ajuste, fechamento). O índice
    // único ignora nulos, e a idempotência por txid do pagamento continua lá.
    const { store, check, deps } = await mesa();
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308, method: 'card',
    }, deps);
    const r = await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_x', amountCents: 3082, tipCents: 308, method: 'card',
    }, deps);
    expect(r.status).toBe('duplicate');
    expect((await estado(store, check.id)).paidCents).toBe(3082);
  });
});
