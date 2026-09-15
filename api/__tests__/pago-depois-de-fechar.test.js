'use strict';

/**
 * PAGO DEPOIS DE FECHAR — o caso que a frase de girar o QR prometia e o código
 * não entregava.
 *
 * A frase dizia à equipe que o que chegasse depois da cobrança no caixa
 * "aparece aqui como valor a devolver". O Racha não registra o caixa: um Pix
 * iniciado antes de o QR girar, confirmado depois de a mesa pagar no caixa e a
 * conta fechar, só COMPLETA a conta. Excedente zero, `overpaidCents` zero,
 * nenhum achado — e a mesa pagou duas vezes (CDC art. 42). O redutor marcava
 * `late` e ninguém fora dos testes o lia. (Compliance HIGH-1 de 40d5c50.)
 */

const fs = require('node:fs');
const path = require('node:path');
const { reduce, paidAfterClose } = require('../_lib/checks/check-state');
const { reconcileCheck } = require('../_lib/checks/reconcile');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: 0, method: 'pix' } });
const closed = () => ({ type: 'CLOSED', payload: {} });
const refunded = (txid, a) => ({ type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: a, tipCents: 0 } });
const row = (txid, a, confirmedAt) => ({
  txid, amountCents: a, tipCents: 0, status: 'confirmado',
  confirmedAmountCents: a, confirmedTipCents: 0, confirmedAt,
  refundedAmountCents: 0, refundedTipCents: 0,
});
const diasAtras = (d) => new Date(Date.now() - d * 86400000).toISOString();

// O CASO DA REVISÃO: conta de 300, dois pagaram 100 pelo Racha, a equipe cobrou
// o terceiro no caixa e fechou; o Pix do terceiro confirma depois.
const MESA = [opened(30000), paid('txA', 10000), paid('txB', 10000), closed(), paid('txC', 10000)];
const linhas = (quandoC) => [row('txA', 10000, diasAtras(0)), row('txB', 10000, diasAtras(0)), row('txC', 10000, quandoC)];
const achados = (r) => r.findings.filter((f) => f.code === 'paid_after_close');

describe('pago depois de fechar — o caso calado', () => {
  test('o redutor completa a conta SEM excedente — e é por isso que ninguém via', () => {
    const st = reduce(MESA);
    expect({ pago: st.paidCents, total: st.totalCents, sobra: st.overpaidCents })
      .toEqual({ pago: 30000, total: 30000, sobra: 0 });
    expect(paidAfterClose(st)).toEqual([{ txid: 'txC', amountCents: 10000 }]);
  });

  test('a conciliação ACHA: high, com o valor e o txid que o painel formata', () => {
    const f = achados(reconcileCheck({ checkId: 'c1', events: MESA, payments: linhas(diasAtras(0)) }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'high', code: 'paid_after_close', txid: 'txC', amountCents: 10000 });
  });

  test('por SETE dias: passou disso, a pergunta já foi feita; sem data, sinaliza', () => {
    expect(achados(reconcileCheck({ checkId: 'c1', events: MESA, payments: linhas(diasAtras(6.5)) }))).toHaveLength(1);
    expect(achados(reconcileCheck({ checkId: 'c1', events: MESA, payments: linhas(diasAtras(8)) }))).toEqual([]);
    expect(achados(reconcileCheck({ checkId: 'c1', events: MESA, payments: linhas(null) }))).toHaveLength(1);
  });

  test('com EXCEDENTE quem grita é o overpaid — não dois achados pro mesmo dinheiro', () => {
    const cheia = [opened(20000), paid('txA', 10000), paid('txB', 10000), closed(), paid('txC', 10000)];
    const codigos = reconcileCheck({ checkId: 'c2', events: cheia, payments: linhas(diasAtras(0)) })
      .findings.map((f) => f.code);
    expect(codigos).toContain('overpaid_pending_restitution');
    expect(codigos).not.toContain('paid_after_close');
  });

  test('pago ANTES de fechar não é marcado, e o que já voltou ao cliente também não', () => {
    expect(paidAfterClose(reduce([opened(30000), paid('txA', 10000), closed()]))).toEqual([]);
    expect(paidAfterClose(reduce([...MESA, refunded('txC', 10000)]))).toEqual([]);
  });

  test('a linha da mesa no painel carrega a mesma regra — nos DOIS stores', () => {
    // O painel lista toda conta da casa; a conciliação no painel perguntaria sem
    // dizer a mesa. A linha diz qual.
    for (const arq of ['supabase.js', 'memory.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', arq), 'utf8');
      const i = src.indexOf('async getPanelView');
      const corpo = src.slice(i, src.indexOf('\n    async ', i + 10));
      expect({ arq, usa: corpo.includes('paidAfterClose: paidAfterClose(state),') }).toEqual({ arq, usa: true });
    }
  });
});
