'use strict';

/**
 * O número que vai pra FOLHA vem do dinheiro que existe.
 *
 * Achado pela revisão de compliance de 2026-09-08. `registerCharge` grava o
 * valor PEDIDO; `recordPayment` nunca tocava os valores. O painel somava as
 * linhas, então numa divergência — pedimos 3390, o PSP confirmou 2450 — o dono
 * lia 3390 de faturamento e a gorjeta PEDIDA, enquanto o card da conta na
 * MESMA tela mostrava o confirmado. Duas verdades sobre o mesmo dinheiro, e a
 * rotulada "gorjeta" era a errada (Lei 13.419/2017 + STJ Tema 1102).
 *
 * A correção óbvia — sobrescrever os valores no `recordPayment` — destruiria o
 * detector: é comparar o pedido com o log que produz `amount_mismatch` e
 * `ledger_drift`. Por isso colunas separadas (migração 0015).
 */

const { confirmedMoney } = require('../_lib/store/confirmed-money');
const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');
const { reconcileCheck } = require('../_lib/checks/reconcile');

describe('confirmedMoney', () => {
  test('usa o confirmado quando existe', () => {
    expect(confirmedMoney({
      amountCents: 3390, tipCents: 308, confirmedAmountCents: 2450, confirmedTipCents: 0,
    })).toEqual({ amountCents: 2450, tipCents: 0 });
  });

  test('cai no registrado quando o confirmado é nulo — pendente ou histórico', () => {
    expect(confirmedMoney({ amountCents: 3390, tipCents: 308 }))
      .toEqual({ amountCents: 3390, tipCents: 308 });
    expect(confirmedMoney({ amountCents: 3390, tipCents: 308, confirmedAmountCents: null }))
      .toEqual({ amountCents: 3390, tipCents: 308 });
  });

  test('zero confirmado é ZERO, não ausência', () => {
    // A distinção que um `||` teria destruído: uma gorjeta confirmada de 0 é
    // um fato (o cliente tirou o serviço), não um campo faltando.
    expect(confirmedMoney({ amountCents: 3390, tipCents: 308, confirmedTipCents: 0 }).tipCents).toBe(0);
  });
});

describe('painel numa divergência', () => {
  test('soma o CONFIRMADO, e a conciliação continua vendo a divergência', async () => {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 3390 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    };
    // Pedimos 3082 + 308 de serviço; o PSP confirmou 2450 e nenhuma gorjeta.
    await store.registerCharge({
      checkId: check.id, txid: 'pi_x', amountCents: 3082, tipCents: 308, payerLabel: null, method: 'pix',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_x', amountCents: 2450, tipCents: 0, method: 'pix',
    }, deps);

    const panel = await store.getPanelView(venue.id);
    // O que o dono lê agora: o dinheiro que existe.
    expect(panel.today.confirmedCents).toBe(2450);
    // E a GORJETA — o número que vai pra folha — é 0, não 308.
    expect(panel.today.tipsCents).toBe(0);

    // E o detector continua de pé: a conciliação vê o pedido contra o log.
    const r = reconcileCheck({
      checkId: check.id,
      events: await store.loadEvents(check.id),
      payments: (await store.listChecksForReconcile(venue.id))[0].payments,
    });
    expect(r.findings.some((f) => f.code === 'amount_mismatch')).toBe(true);
    expect(r.driftCents).not.toBe(0);
  });

  test('sem divergência, painel e conciliação concordam e nada é achado', async () => {
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
      checkId: check.id, txid: 'pi_y', amountCents: 3082, tipCents: 308, payerLabel: null, method: 'pix',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'pi_y', amountCents: 3082, tipCents: 308, method: 'pix',
    }, deps);

    const panel = await store.getPanelView(venue.id);
    expect(panel.today.confirmedCents).toBe(3082);
    expect(panel.today.tipsCents).toBe(308);
    const r = reconcileCheck({
      checkId: check.id,
      events: await store.loadEvents(check.id),
      payments: (await store.listChecksForReconcile(venue.id))[0].payments,
    });
    expect(r.driftCents).toBe(0);
    expect(r.findings).toEqual([]);
  });

  test('a série semanal usa o confirmado também', async () => {
    const { buildAtivacao } = require('../_lib/checks/ativacao');
    const hoje = new Date().toISOString();
    const a = buildAtivacao([
      { amountCents: 3082, tipCents: 308, confirmedAmountCents: 2450, confirmedTipCents: 0, checkId: 'c1', confirmedAt: hoje, method: 'pix' },
    ]);
    expect(a.semana.valorCents).toBe(2450);
    // A linha de gorjeta da semana é a base da folha; somava a pedida.
    expect(a.semana.gorjetaCents).toBe(0);
  });
});
