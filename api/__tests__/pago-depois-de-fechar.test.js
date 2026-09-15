'use strict';

/**
 * PAGO DEPOIS DE FECHAR — o caso que a frase de girar o QR prometia e o código
 * não entregava.
 *
 * A frase dizia à equipe que o que chegasse depois da cobrança no caixa
 * "aparece aqui como valor a devolver". O Racha não registra o caixa: um Pix
 * iniciado antes de o QR girar, confirmado depois de a mesa pagar no caixa e a
 * conta fechar, só COMPLETA a conta. Excedente zero, `overpaidCents` zero,
 * nenhum achado — e a mesa pagou duas vezes (CDC art. 42). (Compliance HIGH-1
 * de 40d5c50.) E a primeira marca contava só consumo, sumia com o pagamento
 * que cruzava o total, calava sozinha em sete dias sem ter como ser
 * respondida, e cinco dela escondiam o prazo de uma disputa (as duas revisões
 * de 497bf87).
 */

const { reduce, paidAfterClose } = require('../_lib/checks/check-state');
const { reconcileCheck } = require('../_lib/checks/reconcile');
const { formatReconcileAlert } = require('../_lib/checks/reconcile-daily');
const { createMemoryStore } = require('../_lib/store/memory');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a, tip = 0) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: tip, method: 'pix' } });
const closed = () => ({ type: 'CLOSED', payload: {} });
const refunded = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: a, tipCents: tip } });
const resolvido = (txid) => ({ type: 'PAYMENT_ISSUE_RESOLVED', payload: { txid, note: 'a mesa não pagou no caixa', by: 'dono' } });
const row = (txid, a, confirmedAt, tip = 0) => ({
  txid, amountCents: a, tipCents: tip, status: 'confirmado',
  confirmedAmountCents: a, confirmedTipCents: tip, confirmedAt,
  refundedAmountCents: 0, refundedTipCents: 0,
});
const horasAtras = (h) => new Date(Date.now() - h * 3600000).toISOString();

// O CASO DA REVISÃO: conta de 300, dois pagaram 100 pelo Racha, a equipe cobrou
// o terceiro no caixa e fechou; o Pix do terceiro confirma depois.
const MESA = [opened(30000), paid('txA', 10000), paid('txB', 10000), closed(), paid('txC', 10000)];
const linhas = (quandoC) => [row('txA', 10000, horasAtras(0)), row('txB', 10000, horasAtras(0)), row('txC', 10000, quandoC)];
const achados = (r) => r.findings.filter((f) => f.code === 'paid_after_close');

describe('pago depois de fechar — o caso calado', () => {
  test('o redutor completa a conta SEM excedente — e é por isso que ninguém via', () => {
    const st = reduce(MESA);
    expect({ pago: st.paidCents, total: st.totalCents, sobra: st.overpaidCents })
      .toEqual({ pago: 30000, total: 30000, sobra: 0 });
    expect(paidAfterClose(st)).toEqual([{ txid: 'txC', amountCents: 10000 }]);
  });

  test('o SERVIÇO entra: um Pix de 110 com o serviço pré-marcado são 110 a devolver, não 100', () => {
    // (Compliance HIGH-B de 497bf87: estornar os 100 mostrados deixava o
    // cliente sem 10.)
    const st = reduce([opened(30000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000)]);
    expect(paidAfterClose(st)).toEqual([{ txid: 'txC', amountCents: 11000 }]);
    // E o estorno do serviço sai do serviço.
    const parcial = reduce([opened(30000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000), refunded('txC', 0, 1000)]);
    expect(paidAfterClose(parcial)).toEqual([{ txid: 'txC', amountCents: 10000 }]);
  });

  test('o pagamento que CRUZA o total: a parte que não é excedente é marcada, e as duas marcas somam o que entrou', () => {
    // Conta de 300 paga inteira no caixa e fechada com zero no Racha; chegam 100
    // e 250. O de 250 tem 50 de excedente — e os outros 200 sumiam da marca
    // (segurança MEDIUM-2 e compliance MEDIUM-B de 497bf87).
    const st = reduce([opened(30000), closed(), paid('t1', 10000), paid('t2', 25000)]);
    expect(paidAfterClose(st)).toEqual([{ txid: 't1', amountCents: 10000 }, { txid: 't2', amountCents: 20000 }]);
    expect(st.overpaidCents).toBe(5000);
    // O estorno sai PRIMEIRO do excedente, como no `allocateRestitution`.
    const com5 = reduce([opened(30000), closed(), paid('t1', 10000), paid('t2', 25000), refunded('t2', 5000)]);
    expect(paidAfterClose(com5).find((x) => x.txid === 't2')).toEqual({ txid: 't2', amountCents: 20000 });
    const com8 = reduce([opened(30000), closed(), paid('t1', 10000), paid('t2', 25000), refunded('t2', 8000)]);
    expect(paidAfterClose(com8).find((x) => x.txid === 't2')).toEqual({ txid: 't2', amountCents: 17000 });
  });

  test('RESPONDIDA, a pergunta sai — da regra e da conciliação', () => {
    // (Compliance MEDIUM-C de 497bf87: só um estorno pelo Racha a encerrava.)
    const respondida = [...MESA, resolvido('txC')];
    expect(paidAfterClose(reduce(respondida))).toEqual([]);
    expect(achados(reconcileCheck({ checkId: 'c1', events: respondida, payments: linhas(horasAtras(1)) }))).toEqual([]);
  });

  test('a conciliação ACHA até alguém responder: high, e critical depois de 48 h — sem o txid na mensagem', () => {
    const recente = achados(reconcileCheck({ checkId: 'c1', events: MESA, payments: linhas(horasAtras(1)) }));
    expect(recente).toHaveLength(1);
    expect(recente[0]).toMatchObject({ severity: 'high', code: 'paid_after_close', txid: 'txC', amountCents: 10000 });
    // A mensagem sai no alerta por WhatsApp: o id do pagamento fica no campo.
    expect(recente[0].message).not.toMatch(/txC/);
    // Oito dias sem resposta NÃO calam: escalam.
    const velho = achados(reconcileCheck({ checkId: 'c1', events: MESA, payments: linhas(horasAtras(8 * 24)) }));
    expect(velho).toHaveLength(1);
    expect(velho[0].severity).toBe('critical');
    // Sem data de confirmação, sinaliza.
    expect(achados(reconcileCheck({ checkId: 'c1', events: MESA, payments: linhas(null) }))).toHaveLength(1);
  });

  test('com EXCEDENTE inteiro quem grita é o overpaid — não dois achados pro mesmo dinheiro', () => {
    const cheia = [opened(20000), paid('txA', 10000), paid('txB', 10000), closed(), paid('txC', 10000)];
    const codigos = reconcileCheck({ checkId: 'c2', events: cheia, payments: linhas(horasAtras(0)) })
      .findings.map((f) => f.code);
    expect(codigos).toContain('overpaid_pending_restitution');
    expect(codigos).not.toContain('paid_after_close');
  });

  test('pago ANTES de fechar não é marcado, e o que já voltou ao cliente também não', () => {
    expect(paidAfterClose(reduce([opened(30000), paid('txA', 10000), closed()]))).toEqual([]);
    expect(paidAfterClose(reduce([...MESA, refunded('txC', 10000)]))).toEqual([]);
  });

  test('a linha da mesa no painel, pelo store de verdade: marca com o serviço, e some quando respondida', async () => {
    // A versão anterior deste teste era um casamento de texto no código-fonte
    // (segurança de 497bf87): passava com a linha em código morto.
    const s = createMemoryStore();
    const venue = s.seedVenue({ name: 'Linha', servicoBp: 1000, pspRecipientId: 'rcpt_linha' });
    const table = s.seedTable(venue.id, 'L1');
    await s.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 30000 }]);
    const { check } = await s.getCheckByQrToken(table.qrToken);
    await s.appendEvent(check.id, 'PAYMENT_CONFIRMED', { txid: 'txA', amountCents: 10000, tipCents: 1000, method: 'pix' });
    await s.appendEvent(check.id, 'CLOSED', {});
    await s.appendEvent(check.id, 'PAYMENT_CONFIRMED', { txid: 'txC', amountCents: 10000, tipCents: 1000, method: 'pix' });
    const marca = async () => (await s.getPanelView(venue.id)).checks.find((c) => c.checkId === check.id).state.paidAfterClose;
    expect(await marca()).toEqual([{ txid: 'txC', amountCents: 11000 }]);
    await s.appendEvent(check.id, 'PAYMENT_ISSUE_RESOLVED', { txid: 'txC', note: 'a mesa não pagou no caixa', by: 'dono' });
    expect(await marca()).toEqual([]);
  });
});

describe('o que o dono vê primeiro — nem o painel nem o alerta da noite são sequestrados', () => {
  test('o painel junta os pagos-depois-de-fechar em UM e põe o prazo de disputa na frente', () => {
    // Cinco pagamentos de um centavo depois de fechar enchiam as cinco vagas e
    // escondiam o prazo de prova de uma disputa (segurança LOW-1 e compliance
    // LOW-A de 497bf87). Um critical nunca é deslocado.
    const { projetarAchados } = require('../_app/router');
    const pagos = [1, 2, 3, 4, 5, 6].map((i) => ({ severity: 'high', code: 'paid_after_close', txid: `p${i}`, amountCents: i }));
    const saida = projetarAchados([
      ...pagos,
      { severity: 'high', code: 'dispute_evidence_due', txid: 'd1' },
      { severity: 'critical', code: 'ledger_drift', driftCents: 900 },
    ]);
    expect(saida.map((f) => f.code)).toEqual(['ledger_drift', 'dispute_evidence_due', 'paid_after_close']);
    expect(saida[2]).toEqual({ severity: 'high', code: 'paid_after_close', amountCents: 21, count: 6 });
  });

  test('entre achados HIGH, o prazo de disputa vem primeiro — mesmo sendo o sexto da lista', () => {
    // Sem a prioridade, a ordem era a da varredura (conta mais velha primeiro):
    // cinco `high` de contas antigas empurravam o prazo pra fora das cinco vagas.
    const { projetarAchados } = require('../_app/router');
    const antigos = ['underpayment', 'overpayment', 'tip_mismatch', 'payable_amount_mismatch', 'overpaid_pending_restitution']
      .map((code) => ({ severity: 'high', code, deltaCents: 1 }));
    const saida = projetarAchados([...antigos, { severity: 'high', code: 'dispute_evidence_due', txid: 'd1' }]);
    expect(saida).toHaveLength(5);
    expect(saida[0].code).toBe('dispute_evidence_due');
  });

  test('o alerta da noite nomeia o prazo da disputa, não o pagamento atrasado de outra conta', () => {
    const msg = formatReconcileAlert({
      at: new Date().toISOString(), venuesRed: 1, venuesChecked: 1,
      red: [{
        name: 'Casa da Disputa', severity: 'high', driftCents: 0,
        findings: [
          { severity: 'high', code: 'paid_after_close', message: 'um pagamento de 1¢ chegou depois de a conta fechar' },
          { severity: 'high', code: 'dispute_evidence_due', message: 'prazo de prova da disputa de d1 vence em 3 dia(s)' },
        ],
      }],
    });
    expect(msg).toMatch(/prazo de prova da disputa/);
    expect(msg).not.toMatch(/chegou depois de a conta fechar/);
  });
});
