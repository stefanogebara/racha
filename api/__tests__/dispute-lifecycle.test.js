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
    seenPspEvent: store.seenPspEvent.bind(store),
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
    seenPspEvent: store.seenPspEvent.bind(store),
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

describe('reentrega de disputa perdida', () => {
  test('não estorna duas vezes — nem quando a disputa é parcial', async () => {
    // O único caminho de razão que reporta um DELTA e não um acumulado. Sem
    // dedupe, a reentrega do `charge.dispute.closed` (a Stripe é
    // at-least-once) aplicava o estorno de novo. No chargeback do valor
    // inteiro a segunda entrega já era recusada por exceder o que sobrou — mas
    // uma disputa PARCIAL cabia no saldo restante, e a conta reabria por
    // dinheiro que saiu uma vez só.
    const { store, check, deps } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid: 'pi_x', amountCents: 1000 });

    const r1 = await applyConfirmedPayment({
      kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 1000, method: 'dispute',
    }, deps);
    expect(r1.status).toBe('appended');
    await store.appendEvent(check.id, 'PAYMENT_DISPUTE_CLOSED', { txid: 'pi_x', outcome: 'lost' });

    const depois = await estado(store, check.id);
    const estornado = depois.payments.pi_x.refundedAmountCents + depois.payments.pi_x.refundedTipCents;
    expect(estornado).toBe(1000);

    // Três reentregas do mesmo evento.
    for (let i = 0; i < 3; i += 1) {
      const r = await applyConfirmedPayment({
        kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 1000, method: 'dispute',
      }, deps);
      expect(r.status).toBe('duplicate');
    }
    const fim = await estado(store, check.id);
    expect(fim.payments.pi_x.refundedAmountCents + fim.payments.pi_x.refundedTipCents).toBe(1000);
    // E o saldo só perdeu os 1000, uma vez.
    expect(fim.paidCents).toBe(3082 - fim.payments.pi_x.refundedAmountCents);
  });
});

describe('entrega FORA DE ORDEM', () => {
  test('o fecho chegando antes da abertura não deixa prazo fantasma', async () => {
    // A Stripe não garante ordem. `dispute.closed` com `won` antes do
    // `dispute.created`: o fecho não achava nada pra limpar, a abertura
    // gravava o prazo depois, e a conciliação passava a gritar
    // `dispute_evidence_overdue` CRÍTICO pra sempre — sobre uma disputa já
    // GANHA. O canário que o fecho existe pra calar, ressuscitado pela ordem
    // de entrega. Achado pela revisão de segurança de 2026-09-08.
    const { store, check, deps } = await mesaPaga();

    // 1) o fecho chega primeiro
    const fecho = await applyConfirmedPayment({ kind: 'dispute_won', txid: 'pi_x', status: 'won' }, deps);
    expect(fecho.status).toBe('appended');

    // 2) a abertura chega depois, com prazo já vencido
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', {
      txid: 'pi_x', amountCents: 3390, reason: 'fraudulent',
      dueBy: new Date(Date.now() - 5 * DIA).toISOString(),
    });

    const st = await estado(store, check.id);
    // A abertura ENTRA no log — ela aconteceu, tem data e motivo.
    const log = await store.loadEvents(check.id);
    expect(log.some((e) => e.type === 'PAYMENT_DISPUTED')).toBe(true);
    // Mas não reabre o que o próprio log já diz encerrado.
    expect(st.payments.pi_x.disputeStatus).toBe('won');
    expect(st.payments.pi_x.disputedAmountCents).toBe(0);
    expect(st.payments.pi_x.disputeDueBy).toBeUndefined();
    expect(st.anomalies).toEqual([]);

    const r = reconcileCheck({
      checkId: check.id, events: log,
      payments: [{ txid: 'pi_x', amountCents: 3082, tipCents: 308, status: 'confirmado', method: 'card' }],
    });
    expect(r.findings.some((f) => String(f.code).startsWith('dispute_evidence'))).toBe(false);
    expect(r.ok).toBe(true);
  });

  test('a ordem NORMAL continua funcionando — o fecho ainda limpa', async () => {
    const { store, check, deps } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', {
      txid: 'pi_x', amountCents: 3390, dueBy: new Date(Date.now() + 3 * DIA).toISOString(),
    });
    expect((await estado(store, check.id)).anomalies.length).toBe(1);
    await applyConfirmedPayment({ kind: 'dispute_won', txid: 'pi_x', status: 'won' }, deps);
    expect((await estado(store, check.id)).anomalies).toEqual([]);
  });
});

describe('pendência de dinheiro pode ser encerrada', () => {
  test('o estorno que falhou deixa a casa vermelha ATÉ alguém resolver', async () => {
    // A outra metade do inegociável #8, e eu tinha reintroduzido o defeito que
    // acabara de corrigir: a marca do estorno que falhou era PERMANENTE, então
    // a casa nunca mais ficava verde — e casa que nunca fica verde é casa que
    // para de olhar. Achado pela revisão de compliance de 2026-09-08.
    const { store, check, deps } = await mesaPaga();
    await applyConfirmedPayment({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500 }, deps);
    await applyConfirmedPayment({ kind: 'refund_failed', txid: 'pi_x', amountCents: 500 }, deps);

    const pagamentos = [{ txid: 'pi_x', amountCents: 3082, tipCents: 308, status: 'confirmado', method: 'card' }];
    let r = reconcileCheck({ checkId: check.id, events: await store.loadEvents(check.id), payments: pagamentos });
    // Vermelha: o cliente tem dinheiro a receber por outro caminho.
    expect(r.findings.some((f) => f.severity === 'high')).toBe(true);

    // O dono registra que reembolsou por fora — com o PORQUÊ.
    await store.appendEvent(check.id, 'PAYMENT_ISSUE_RESOLVED', {
      txid: 'pi_x', note: 'devolvido em dinheiro no caixa', by: 'dono@bar.com',
    });

    const st = await estado(store, check.id);
    expect(st.anomalies.some((a) => a.type === 'PAYMENT_REFUND_REVERSED')).toBe(false);
    r = reconcileCheck({ checkId: check.id, events: await store.loadEvents(check.id), payments: pagamentos });
    expect(r.findings.some((f) => f.severity === 'high' || f.severity === 'critical')).toBe(false);

    // E o log continua íntegro: a falha do estorno está lá, com a resolução
    // ao lado e com o autor.
    const log = await store.loadEvents(check.id);
    expect(log.some((e) => e.type === 'PAYMENT_REFUND_REVERSED')).toBe(true);
    const resolucao = log.find((e) => e.type === 'PAYMENT_ISSUE_RESOLVED');
    expect(resolucao.payload.by).toBe('dono@bar.com');
    expect(resolucao.payload.note).toMatch(/dinheiro no caixa/);
  });

  test('resolver sem dizer o porquê é recusado', async () => {
    // "Resolvido" sem motivo é só a marca sumindo do painel.
    const { store, check, deps } = await mesaPaga();
    await applyConfirmedPayment({ kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 500 }, deps);
    await applyConfirmedPayment({ kind: 'refund_failed', txid: 'pi_x', amountCents: 500 }, deps);
    // Pelo caminho que a ROTA usa — o `store.appendEvent` cru não valida, e é
    // justamente por isso que existe o `appendValidated`: os appends diretos da
    // rota passavam por fora da validação e um evento inválido virava anomalia
    // do redutor em vez de recusa limpa.
    const { appendValidated } = require('../_lib/checks/append-validated');
    await expect(appendValidated(store, check.id, 'PAYMENT_ISSUE_RESOLVED', { txid: 'pi_x', note: 'ok' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'event_invalid' });
    // E um evento válido passa.
    await expect(appendValidated(store, check.id, 'PAYMENT_ISSUE_RESOLVED', {
      txid: 'pi_x', note: 'devolvido em dinheiro', by: 'dono@bar.com',
    })).resolves.toBeGreaterThan(0);
  });

  test('a disputa PERDIDA é informação, não pendência permanente', async () => {
    // O dinheiro já saiu e está no estorno. Não há nada a fazer, e uma
    // pendência permanente aqui é o canário gritando pra sempre — o mesmo
    // defeito, do outro lado.
    const { store, check, deps } = await mesaPaga();
    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid: 'pi_x', amountCents: 3390 });
    await applyConfirmedPayment({ kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 3390, method: 'dispute' }, deps);
    await store.appendEvent(check.id, 'PAYMENT_DISPUTE_CLOSED', { txid: 'pi_x', outcome: 'lost' });

    const r = reconcileCheck({
      checkId: check.id,
      events: await store.loadEvents(check.id),
      payments: [{ txid: 'pi_x', amountCents: 3082, tipCents: 308, refundedAmountCents: 3082, refundedTipCents: 308, status: 'devolvido', method: 'card' }],
    });
    expect(r.findings.some((f) => f.severity === 'high' || f.severity === 'critical')).toBe(false);
    // Mas o registro continua visível, como informação.
    expect(r.findings.some((f) => f.severity === 'info' && /PERDIDA/.test(f.message))).toBe(true);
  });
});

describe('a casa consegue ver a própria taxa de chargeback', () => {
  test('o painel conta disputas por DESFECHO', async () => {
    // O número pelo qual o adquirente julga a casa — acima de um patamar a
    // bandeira aplica programa de monitoramento. O razão já sabia o desfecho de
    // cada disputa e nada mostrava isso pro dono. Achado pela revisão de
    // compliance de 2026-09-08.
    const { disputeCounts } = require('../_lib/checks/disputes');
    const { store, check, deps } = await mesaPaga();

    // Nada ainda.
    expect(disputeCounts(await estado(store, check.id))).toEqual({ open: 0, lost: 0, won: 0 });

    await store.appendEvent(check.id, 'PAYMENT_DISPUTED', { txid: 'pi_x', amountCents: 3390 });
    expect(disputeCounts(await estado(store, check.id))).toMatchObject({ open: 1, lost: 0, won: 0 });

    await applyConfirmedPayment({ kind: 'dispute_won', txid: 'pi_x', status: 'won' }, deps);
    // Ganha sai de "aberta" e conta como ganha: a casa se defendeu.
    expect(disputeCounts(await estado(store, check.id))).toMatchObject({ open: 0, lost: 0, won: 1 });

    // E o painel agrega isso por conta.
    const venue = await store.getVenueForCheck(check.id);
    const panel = await store.getPanelView(venue.id);
    const linha = panel.checks.find((c) => c.checkId === check.id);
    expect(linha.state.disputes).toEqual({ open: 0, lost: 0, won: 1 });
  });

  test('conta por TRANSAÇÃO, não por valor — é assim que a taxa é medida', async () => {
    const { disputeCounts } = require('../_lib/checks/disputes');
    const st = {
      payments: {
        a: { disputedAmountCents: 100000, disputeStatus: undefined },
        b: { disputedAmountCents: 1, disputeStatus: 'lost' },
        c: { disputedAmountCents: 0, disputeStatus: 'won' },
        d: { disputedAmountCents: 0 },
      },
    };
    // Um chargeback de R$ 0,01 pesa igual a um de R$ 1.000,00 na taxa.
    expect(disputeCounts(st)).toEqual({ open: 1, lost: 1, won: 1 });
  });
});
