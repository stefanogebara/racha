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

const fs = require('node:fs');
const path = require('node:path');
const { reduce, paidAfterClose, validateEvent } = require('../_lib/checks/check-state');
const { reconcileCheck } = require('../_lib/checks/reconcile');
const { formatReconcileAlert } = require('../_lib/checks/reconcile-daily');
const { createMemoryStore } = require('../_lib/store/memory');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a, tip = 0) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: tip, method: 'pix' } });
const closed = () => ({ type: 'CLOSED', payload: {} });
const refunded = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: a, tipCents: tip } });
// A resposta ESCOPADA, como o botão do painel manda (compliance HIGH-1 de 41d1244).
const resolvido = (txid) => ({ type: 'PAYMENT_ISSUE_RESOLVED', payload: { txid, note: 'a mesa não pagou no caixa', by: 'dono', scope: 'paid_after_close' } });
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

  test('INVARIANTE: marcas + sobra = dinheiro atrasado líquido, em qualquer ordem e com qualquer estorno de irmão', () => {
    // O excedente CONGELADO no pagamento fazia o valor depender da ordem de
    // chegada depois do estorno de um irmão: 200 ou 250 do que eram 250
    // (segurança MEDIUM-1 de 41d1244). Trezentas contas geradas, com e sem
    // pagamento antes de fechar, com estornos parciais pelo Racha.
    // O caso da revisão, explícito e nas DUAS ordens: conta de 300 paga no
    // caixa e fechada com zero; chegam 100 e 250; o de 100 é estornado. O de 250
    // é 250 a devolver — o excedente congelado dizia 200.
    for (const ordem of [['t1', 't2'], ['t2', 't1']]) {
      const valor = { t1: 10000, t2: 25000 };
      const st = reduce([opened(30000), closed(), ...ordem.map((t) => paid(t, valor[t])), refunded('t1', 10000)]);
      expect({ ordem, marcas: paidAfterClose(st) }).toEqual({ ordem, marcas: [{ txid: 't2', amountCents: 25000 }] });
    }
    // O GERADOR em 32 bits EXATOS. A primeira versão multiplicava em ponto
    // flutuante, passava de 2^53, perdia os bits baixos e degenerava — as
    // trezentas contas não tinham UMA em que a fórmula errada diferisse da certa,
    // e a prova de mutação mostrou (o mutante do excedente congelado passou verde).
    let semente = 7;
    const rnd = (n) => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente % n; };
    for (let caso = 0; caso < 300; caso += 1) {
      const total = 1000 + rnd(50000);
      const antes = rnd(3) === 0 ? [paid('pre', 500 + rnd(total))] : [];
      const atrasados = Array.from({ length: 1 + rnd(4) }, (_, i) => ({ txid: `a${i}`, a: 100 + rnd(30000), tip: rnd(3000) }));
      const ev = [opened(total), ...antes, closed(), ...atrasados.map((x) => paid(x.txid, x.a, x.tip))];
      for (const x of atrasados) {
        if (rnd(2) === 0) {
          const r = rnd(x.a + 1); const rt = rnd(x.tip + 1);
          if (r + rt > 0) ev.push(refunded(x.txid, r, rt));
        }
      }
      const st = reduce(ev);
      const liqAmt = (t) => st.payments[t].amountCents - st.payments[t].refundedAmountCents;
      const liqTip = (t) => st.payments[t].tipCents - st.payments[t].refundedTipCents;
      const marcas = paidAfterClose(st).reduce((soma, x) => soma + x.amountCents, 0);
      const pool = atrasados.reduce((soma, x) => soma + liqAmt(x.txid), 0);
      const atrasadoLiquido = pool + atrasados.reduce((soma, x) => soma + liqTip(x.txid), 0);
      // A sobra conta até o que entrou atrasado; o resto dela é de quem pagou antes.
      expect({ caso, soma: marcas + Math.min(st.overpaidCents, pool) }).toEqual({ caso, soma: atrasadoLiquido });
    }
  });

  test('DUPLICIDADE: o serviço é a devolver sem pergunta — marcado, com achado próprio, e a resposta é recusada', () => {
    // A conta já estava paga no Racha: o consumo inteiro do atrasado é sobra, e
    // o serviço dele era a pergunta do caixa — que, respondida com a verdade,
    // apagava 10 que eram a devolver de qualquer jeito (compliance MEDIUM-2 de 41d1244).
    const dup = [opened(20000), paid('txA', 10000), paid('txB', 10000), closed(), paid('txC', 10000, 1000)];
    const st = reduce(dup);
    expect(paidAfterClose(st)).toEqual([{ txid: 'txC', amountCents: 1000, sempreDevido: true }]);
    const pagamentos = [row('txA', 10000, horasAtras(1)), row('txB', 10000, horasAtras(1)), row('txC', 10000, horasAtras(1), 1000)];
    const codigos = reconcileCheck({ checkId: 'c3', events: dup, payments: pagamentos }).findings.map((f) => f.code);
    expect(codigos).toEqual(expect.arrayContaining(['overpaid_pending_restitution', 'paid_after_close_tip']));
    expect(codigos).not.toContain('paid_after_close');
    expect(() => validateEvent(resolvido('txC'), st)).toThrow(/duplicidade/);
  });

  test('a resposta ESCOPADA não apaga a falha de um estorno — e a resposta da falha não responde o caixa', () => {
    // O botão escrevia o evento sem escopo, e com ele sumiam a falha do estorno
    // e o "você tem a receber" do cliente (compliance HIGH-1 e segurança LOW-4 de 41d1244).
    const reverso = { type: 'PAYMENT_REFUND_REVERSED', payload: { txid: 'txC', amountCents: 10000, tipCents: 0 } };
    const base = [...MESA, refunded('txC', 10000), reverso];
    const falha = (st) => st.anomalies.some((a) => a.type === 'PAYMENT_REFUND_REVERSED' && a.txid === 'txC');
    expect(falha(reduce(base))).toBe(true);
    // E a resposta escopada só vale onde há pergunta aberta: txA pagou ANTES de fechar.
    expect(() => validateEvent(resolvido('txA'), reduce(MESA))).toThrow(/pergunta/);
    const escopada = reduce([...base, resolvido('txC')]);
    expect(falha(escopada)).toBe(true);
    expect(paidAfterClose(escopada)).toEqual([]);
    const daFalha = reduce([...base, { type: 'PAYMENT_ISSUE_RESOLVED', payload: { txid: 'txC', note: 'reembolsado por fora', by: 'dono' } }]);
    expect(falha(daFalha)).toBe(false);
    expect(paidAfterClose(daFalha)).toEqual([{ txid: 'txC', amountCents: 10000 }]);
  });

  test('a linha da mesa usa a MESMA regra no store de PRODUÇÃO — o Supabase', () => {
    // Só o gêmeo em memória era exercitado; apagar a linha no Supabase passava
    // verde (segurança LOW-1 de 41d1244).
    const src = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'supabase.js'), 'utf8');
    const i = src.indexOf('async getPanelView');
    const corpo = src.slice(i, src.indexOf('\n    async ', i + 10));
    expect(corpo).toContain('paidAfterClose: paidAfterClose(state),');
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
    await s.appendEvent(check.id, 'PAYMENT_ISSUE_RESOLVED', { txid: 'txC', note: 'a mesa não pagou no caixa', by: 'dono', scope: 'paid_after_close' });
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

  test('um pago-depois-de-fechar que envelheceu pra CRITICAL não passa na frente de um prazo de disputa', () => {
    // (Compliance LOW-1 de 41d1244.)
    const msg = formatReconcileAlert({
      at: new Date().toISOString(), venuesRed: 1, venuesChecked: 1,
      red: [{
        name: 'Casa Velha', severity: 'critical', driftCents: 0,
        findings: [
          { severity: 'critical', code: 'paid_after_close', message: 'um pagamento de 1¢ chegou depois de a conta fechar há 3 dia(s)' },
          { severity: 'high', code: 'dispute_evidence_due', message: 'prazo de prova da disputa de d1 vence em 2 dia(s)' },
        ],
      }],
    });
    expect(msg).toMatch(/prazo de prova da disputa/);
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
