'use strict';

/**
 * A DEVOLUÇÃO POR FORA DO TRILHO, e a devolução em três baldes.
 *
 * Duas regras que a revisão de 3eea5f3 pediu, e que estavam no mesmo ponto
 * cego: o serviço de um pagamento que duplicou o caixa é do cliente (Lei
 * 13.419/2017 + STJ Tema 1102 — só o serviço prestado é remuneração do time),
 * e quem tira dinheiro da base da folha tem de ter uma testemunha.
 *
 *  1. `record-restitution` alcançava a marca do pago-depois-de-fechar SEMPRE.
 *     Bastava ao dono declarar "devolvi por fora" pra fazer o serviço sumir da
 *     folha por atestação, com o estorno pelo adquirente ali, aberto, à mão
 *     (segurança MEDIUM-2, compliance MEDIUM-1). Agora só quando o trilho é
 *     IMPOSSÍVEL: o estorno falhou e voltou, ou é Pix passados os 90 dias.
 *  2. A devolução se repartia em dois baldes (excedente, depois proporcional),
 *     e o serviço devido caía no proporcional — devolver R$ 110 de uma
 *     duplicação de R$ 100 + R$ 10 deixava na folha um resto de serviço que
 *     ninguém prestou (compliance MEDIUM-2).
 */

const { reduce } = require('../_lib/checks/check-state');
const { tetoDaRestituicao } = require('../_lib/checks/restitution');
const { alocarDevolucaoDoPagamento, servicoDevidoDoAtrasado } = require('../_lib/checks/refund-allocation');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a, tip = 0) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: tip, method: 'pix' } });
const closed = () => ({ type: 'CLOSED', payload: {} });
const refunded = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: a, tipCents: tip } });
const revertido = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUND_REVERSED', payload: { txid, amountCents: a, tipCents: tip } });
const resolvido = (txid) => ({ type: 'PAYMENT_ISSUE_RESOLVED', payload: { txid, note: 'estorno refeito por fora', by: 'u-1' } });
const diasAtras = (d) => new Date(Date.now() - d * 86400000).toISOString();

// A mesa pagou no caixa; o Pix de 100 + 10 de serviço confirma depois.
const ATRASADO = [opened(30000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000)];

describe('o teto da devolução por fora', () => {
  test('com o trilho ABERTO, a marca do atrasado não entra: devolva pelo adquirente', () => {
    const t = tetoDaRestituicao(reduce(ATRASADO), 'txC', { confirmedAt: diasAtras(1), method: 'pix' });
    expect({ tardio: t.tardio, teto: t.teto, impossivel: t.trilhoImpossivel })
      .toEqual({ tardio: 0, teto: 0, impossivel: false });
  });

  test('o estorno que FALHOU e voltou abre o caminho — e fechar aquela pendência o fecha de novo', () => {
    const falhou = reduce([...ATRASADO, refunded('txC', 10000, 1000), revertido('txC', 10000, 1000)]);
    expect(tetoDaRestituicao(falhou, 'txC', { confirmedAt: diasAtras(1), method: 'pix' }))
      .toMatchObject({ trilhoImpossivel: true, tardio: 11000 });
    // Resolvida a pendência do estorno, a testemunha some junto: o dono que já
    // devolveu registra ANTES de resolver, não depois.
    const resolvida = reduce([...ATRASADO, refunded('txC', 10000, 1000), revertido('txC', 10000, 1000), resolvido('txC')]);
    expect(tetoDaRestituicao(resolvida, 'txC', { confirmedAt: diasAtras(1), method: 'pix' }))
      .toMatchObject({ trilhoImpossivel: false, tardio: 0 });
  });

  test('o Pix passados 90 dias abre o caminho; o CARTÃO não — lá o trilho não fecha por idade', () => {
    const st = reduce(ATRASADO);
    expect(tetoDaRestituicao(st, 'txC', { confirmedAt: diasAtras(91), method: 'pix' }))
      .toMatchObject({ trilhoImpossivel: true, tardio: 11000 });
    expect(tetoDaRestituicao(st, 'txC', { confirmedAt: diasAtras(89), method: 'pix' }))
      .toMatchObject({ trilhoImpossivel: false, tardio: 0 });
    expect(tetoDaRestituicao(st, 'txC', { confirmedAt: diasAtras(400), method: 'card' }))
      .toMatchObject({ trilhoImpossivel: false, tardio: 0 });
    // Sem a linha do pagamento (data perdida), nada de trilho impossível.
    expect(tetoDaRestituicao(st, 'txC', {})).toMatchObject({ trilhoImpossivel: false, tardio: 0 });
  });

  test('o EXCEDENTE nunca dependeu do trilho: sobra é sobra, e devolve-se sempre', () => {
    // Conta de 300, um pagamento de 350: 50 de sobra, e nenhum atraso.
    const st = reduce([opened(30000), paid('tx1', 35000)]);
    expect(tetoDaRestituicao(st, 'tx1', {})).toMatchObject({ excesso: 5000, teto: 5000 });
  });
});

describe('a devolução em três baldes', () => {
  const pg = (estado, txid) => estado.payments[txid];

  test('o serviço devido sai INTEIRO da gorjeta, não em fatia proporcional', () => {
    const st = reduce([opened(20000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000)]);
    // O atrasado duplicou 100 de consumo; o serviço devido são os 10 sobre ele.
    expect(servicoDevidoDoAtrasado(st, 'txC')).toBe(1000);
    const partes = alocarDevolucaoDoPagamento(st, 'txC', pg(st, 'txC'), 11000);
    expect(partes).toEqual({ amountCents: 10000, tipCents: 1000 });
    // A conta sem a regra: proporcional sobre 100+10 devolveria 10000/1000 —
    // igual aqui porque devolve tudo. O caso que separa é o PARCIAL, abaixo.
  });

  test('devolvendo só o consumo duplicado, o serviço devido continua devido — e não vem junto', () => {
    const st = reduce([opened(20000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000)]);
    const partes = alocarDevolucaoDoPagamento(st, 'txC', pg(st, 'txC'), 10000);
    // Proporcional teria tirado ~909 da gorjeta junto; o balde 1 é só consumo.
    expect(partes).toEqual({ amountCents: 10000, tipCents: 0 });
  });

  test('sem pagamento atrasado, a regra é a de sempre — proporcional', () => {
    const st = reduce([opened(20000), paid('tx1', 10000, 1000)]);
    const partes = alocarDevolucaoDoPagamento(st, 'tx1', pg(st, 'tx1'), 5500);
    expect(partes.amountCents + partes.tipCents).toBe(5500);
    expect(partes.tipCents).toBe(500);
  });

  test('o que passa dos dois baldes vira estorno comum, proporcional sobre o que sobrou', () => {
    const st = reduce([opened(20000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000)]);
    const partes = alocarDevolucaoDoPagamento(st, 'txC', pg(st, 'txC'), 11000);
    expect(partes.amountCents + partes.tipCents).toBe(11000);
  });

  /**
   * A PROPRIEDADE, gerada: devolver exatamente `excedente + serviço devido`
   * deixa a gorjeta menor em exatamente o serviço devido. É o número que vai
   * pra folha — e o mutante que este teste existe pra pegar é a regra antiga,
   * de dois baldes.
   *
   * PRNG de 32 bits com `Math.imul`: um LCG em float passa 2^53, perde os bits
   * baixos e gera casos que não distinguem nada (a lição de 57c0d2e).
   */
  test('propriedade: o serviço devido sai exato, em 300 contas geradas', () => {
    let s = 20260915 >>> 0;
    const proximo = (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
    let distinguem = 0;
    for (let i = 0; i < 300; i += 1) {
      const total = (proximo(400) + 20) * 100;
      const noCaixa = (proximo(Math.floor(total / 100)) + 1) * 100;
      const atrasado = (proximo(300) + 10) * 100;
      const servico = Math.round(atrasado * (proximo(15) + 1) / 100) * 1;
      const st = reduce([
        opened(total),
        ...(noCaixa < total ? [paid('txA', total - noCaixa)] : []),
        closed(),
        paid('txC', atrasado, servico),
      ]);
      const pagamento = st.payments.txC;
      const devido = servicoDevidoDoAtrasado(st, 'txC');
      const excedente = Math.min(pagamento.excessCents || 0, pagamento.amountCents);
      const valor = excedente + devido;
      if (valor === 0) continue;
      const partes = alocarDevolucaoDoPagamento(st, 'txC', pagamento, valor);
      expect(partes.amountCents + partes.tipCents).toBe(valor);
      expect(partes.tipCents).toBe(devido);
      // A gorjeta que fica é a base da folha.
      expect(pagamento.tipCents - partes.tipCents).toBe(servico - devido);
      // Quantos casos SEPARAM a regra velha (proporcional) da nova?
      const { allocateRestitution, allocateRefund } = require('../_lib/checks/split-engine');
      const consumo = pagamento.amountCents;
      const velha = excedente > 0
        ? allocateRestitution(consumo, servico, valor, excedente)
        : allocateRefund(consumo, servico, valor);
      if (velha.tipCents !== partes.tipCents) distinguem += 1;
    }
    // Um teste gerado que não separa o mutante não é teste. Conta e prova.
    expect(distinguem).toBeGreaterThan(30);
  });
});

test('banco fora do ar não vira "confira o valor": 500, e a cópia manda CONFERIR antes de repetir', () => {
  // O mesmo ponto que o `resolve-issue` já tinha corrigido (compliance LOW-E de
  // 57c0d2e). Um 400 dizendo "confira o valor" manda conferir um valor que
  // estava certo — e esconde que o lançamento PODE ter pousado.
  const fs = require('node:fs');
  const path = require('node:path');
  const R = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const i = R.indexOf("url.pathname === '/api/checks/record-restitution'");
  const rota = R.slice(i, R.indexOf("url.pathname === '", i + 40));
  expect(rota).toMatch(/if \(!e\.statusCode \|\| e\.statusCode >= 500\) \{/);
  expect(rota).toMatch(/code: 'restitution_unavailable'/);
  // A recusa que aponta o adquirente, e a condição que a separa de "não deve nada".
  expect(rota).toMatch(/\? 'use_acquirer_refund' : 'nothing_to_restitute'/);
  expect(rota).toMatch(/paidAfterClose\(estado\)\.some\(\(x\) => x\.txid === String\(b\.txid\)\)/);
  const i18n = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
  for (const chave of ['err.restitution_unavailable', 'err.use_acquirer_refund']) {
    expect(i18n).toContain(`'${chave}'`);
  }
  // A cópia do 500 não pode mandar "tente de novo" seco: repetir às cegas
  // registra a mesma devolução duas vezes.
  const linha = i18n.slice(i18n.indexOf("'err.restitution_unavailable'"));
  expect(linha.slice(0, 400)).toMatch(/check before recording it again/);
});
