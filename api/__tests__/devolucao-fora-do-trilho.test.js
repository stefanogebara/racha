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

const { reduce, paidAfterClose, validateEvent } = require('../_lib/checks/check-state');
const { tetoDaRestituicao, codigoDaRecusa } = require('../_lib/checks/restitution');
const { alocarDevolucaoDoPagamento, servicoDevidoDoAtrasado } = require('../_lib/checks/refund-allocation');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a, tip = 0) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: tip, method: 'pix' } });
const closed = () => ({ type: 'CLOSED', payload: {} });
const refunded = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: a, tipCents: tip } });
const revertido = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUND_REVERSED', payload: { txid, amountCents: a, tipCents: tip } });
const resolvido = (txid) => ({ type: 'PAYMENT_ISSUE_RESOLVED', payload: { txid, note: 'estorno refeito por fora', by: 'u-1' } });
const resolvidoEscopado = (txid) => ({ type: 'PAYMENT_ISSUE_RESOLVED', payload: { txid, note: 'a mesa não pagou no caixa', by: 'u-1', scope: 'paid_after_close' } });
const diasAtras = (d) => new Date(Date.now() - d * 86400000).toISOString();

// A mesa pagou no caixa; o Pix de 100 + 10 de serviço confirma depois.
const ATRASADO = [opened(30000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000)];

describe('o teto da devolução por fora', () => {
  test('com o trilho ABERTO, a marca do atrasado não entra: devolva pelo adquirente', () => {
    const t = tetoDaRestituicao(reduce(ATRASADO), 'txC', { confirmedAt: diasAtras(1), method: 'pix' });
    expect({ tardio: t.tardio, teto: t.teto, impossivel: t.trilhoImpossivel })
      .toEqual({ tardio: 0, teto: 0, impossivel: false });
  });

  test('o estorno que FALHOU e voltou abre o caminho — e RESOLVER a pendência não o fecha', () => {
    const falhou = reduce([...ATRASADO, refunded('txC', 10000, 1000), revertido('txC', 10000, 1000)]);
    expect(tetoDaRestituicao(falhou, 'txC', { confirmedAt: diasAtras(1) }))
      .toMatchObject({ trilhoImpossivel: true, tardio: 11000, motivo: 'refund_reversed' });

    /**
     * A ORDEM DOS CLIQUES NÃO DECIDE MAIS NADA.
     *
     * A testemunha vinha da lista de ANOMALIAS, e `PAYMENT_ISSUE_RESOLVED` sem
     * escopo tira a anomalia da projeção. Quem resolvesse a pendência primeiro —
     * a ordem natural, porque é a marca que o cliente vê — trancava a devolução
     * PRA SEMPRE: a rota passava a responder `use_acquirer_refund` sobre um
     * estorno que já tinha falhado, a marca virava `critical` eterna sobre uma
     * dívida já paga, e o runbook não dizia uma palavra sobre ordem
     * (compliance HIGH-1 de ec86b37). Agora o FATO mora no pagamento.
     */
    const resolvida = reduce([...ATRASADO, refunded('txC', 10000, 1000), revertido('txC', 10000, 1000), resolvido('txC')]);
    expect(resolvida.anomalies.some((a) => a.type === 'PAYMENT_REFUND_REVERSED')).toBe(false);
    // O SALDO REVERTIDO EM ABERTO, que é o fato, com tamanho.
    expect(resolvida.payments.txC.reversedOpenCents).toBe(11000);
    expect(tetoDaRestituicao(resolvida, 'txC', { confirmedAt: diasAtras(1) }))
      .toMatchObject({ trilhoImpossivel: true, tardio: 11000, motivo: 'refund_reversed' });
  });

  test('o estorno REFEITO com sucesso fecha a porta de novo — a testemunha não é eterna', () => {
    /**
     * A primeira versão gravava um `true` que nunca saía, e isso abria a porta
     * pelo outro lado: uma reversão de dez centavos sobre um estorno de cem
     * reais destrancava a atestação do pagamento INTEIRO, pra sempre, mesmo
     * depois de o adquirente enfim devolver (compliance MEDIUM-1 de d7f2683).
     */
    const falhouEDepoisFoi = reduce([...ATRASADO,
      refunded('txC', 10000, 1000), revertido('txC', 10000, 1000), refunded('txC', 10000, 1000)]);
    expect(falhouEDepoisFoi.payments.txC.reversedOpenCents).toBe(0);
    expect(tetoDaRestituicao(falhouEDepoisFoi, 'txC', { confirmedAt: diasAtras(1) }))
      .toMatchObject({ trilhoImpossivel: false, motivo: null });

    // E uma reversão PARCIAL vale só o que ficou faltando.
    const parcial = reduce([...ATRASADO,
      refunded('txC', 10000, 1000), revertido('txC', 10, 0)]);
    expect(parcial.payments.txC.reversedOpenCents).toBe(10);
    expect(tetoDaRestituicao(parcial, 'txC', { confirmedAt: diasAtras(1) }))
      .toMatchObject({ trilhoImpossivel: true, motivo: 'refund_reversed' });
  });

  test('cada trilho tem o SEU prazo: Pix 90 dias, cartão 180', () => {
    const pix = reduce(ATRASADO);
    expect(tetoDaRestituicao(pix, 'txC', { confirmedAt: diasAtras(91) }))
      .toMatchObject({ trilhoImpossivel: true, tardio: 11000, motivo: 'pix_90d' });
    expect(tetoDaRestituicao(pix, 'txC', { confirmedAt: diasAtras(89) }))
      .toMatchObject({ trilhoImpossivel: false, tardio: 0, motivo: null });

    // O CARTÃO não tinha prazo NENHUM: passados os 180 dias do adquirente, a
    // devolução legítima não tinha como ser registrada e a marca virava
    // `critical` eterna — o mesmo desfecho do HIGH-1, alcançado pelo relógio
    // (MEDIUM-3 de ec86b37). E um estorno recusado na CRIAÇÃO não gera
    // `refund.failed`, então não havia outra saída.
    const cartao = reduce([opened(30000), paid('txA', 20000, 2000), closed(),
      { type: 'PAYMENT_CONFIRMED', payload: { txid: 'txC', amountCents: 10000, tipCents: 1000, method: 'credit_card' } }]);
    expect(tetoDaRestituicao(cartao, 'txC', { confirmedAt: diasAtras(181) }))
      .toMatchObject({ trilhoImpossivel: true, motivo: 'card_180d' });
    expect(tetoDaRestituicao(cartao, 'txC', { confirmedAt: diasAtras(179) }))
      .toMatchObject({ trilhoImpossivel: false });
    // No cartão, 91 dias ainda é trilho ABERTO — o que no Pix já venceu.
    expect(tetoDaRestituicao(cartao, 'txC', { confirmedAt: diasAtras(91) }))
      .toMatchObject({ trilhoImpossivel: false });
  });

  test('o MEIO vem do razão, não da linha de `payments`', () => {
    // A linha é melhor-esforço (a própria rota a trata assim). Ela some, ou
    // volta com o meio errado, e um Pix de 200 dias era mandado de volta pro
    // trilho que o BACEN fechou aos 90 (MEDIUM-4 de ec86b37).
    const st = reduce(ATRASADO);
    expect(st.payments.txC.method).toBe('pix');
    expect(tetoDaRestituicao(st, 'txC', { confirmedAt: diasAtras(120), method: 'card' }))
      .toMatchObject({ trilhoImpossivel: true, motivo: 'pix_90d' });
  });

  test('NÃO SABER a data não é o mesmo que estar no prazo', () => {
    const st = reduce(ATRASADO);
    const limites = tetoDaRestituicao(st, 'txC', {});
    expect(limites).toMatchObject({ trilhoImpossivel: false, tardio: 0, dataConhecida: false });
    // E a recusa diz QUAL não-há: mandar usar o adquirente seria mandar a casa
    // a um trilho que pode estar fechado.
    expect(codigoDaRecusa(st, 'txC', limites)).toBe('payment_age_unknown');
    expect(codigoDaRecusa(st, 'txC', tetoDaRestituicao(st, 'txC', { confirmedAt: diasAtras(1) })))
      .toBe('use_acquirer_refund');
    const semMarca = reduce([opened(10000), paid('t1', 10000)]);
    expect(codigoDaRecusa(semMarca, 't1', tetoDaRestituicao(semMarca, 't1', { confirmedAt: diasAtras(1) })))
      .toBe('nothing_to_restitute');
    // Com teto, não há recusa nenhuma.
    expect(codigoDaRecusa(st, 'txC', tetoDaRestituicao(st, 'txC', { confirmedAt: diasAtras(91) }))).toBeNull();
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
  /**
   * A ROTA CHAMA A REGRA, e a regra é testada acima sem HTTP.
   *
   * O que estava aqui era uma REGEX contra a expressão da recusa dentro do
   * router — o falso invariante que este repositório já documenta: um refactor
   * que preservasse a string e invertesse a condição passava verde (segurança
   * LOW-3 de ec86b37). O que resta é a FIAÇÃO: que a rota delega.
   */
  expect(rota).toMatch(/const recusa = codigoDaRecusa\(estado, String\(b\.txid\), limites\);/);
  expect(rota).toMatch(/railImpossible: limites\.motivo/);

  const i18n = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
  for (const chave of ['err.restitution_unavailable', 'err.use_acquirer_refund', 'err.payment_age_unknown']) {
    expect(i18n).toContain(`'${chave}'`);
  }
  // A cópia do 500 não pode mandar "tente de novo" seco: repetir às cegas
  // registra a mesma devolução duas vezes.
  const linha = i18n.slice(i18n.indexOf("'err.restitution_unavailable'"));
  expect(linha.slice(0, 400)).toMatch(/check before recording it again/);
});

describe('o atrasado em aberto devolve o CONSUMO antes da gorjeta', () => {
  // A mesa pagou no caixa: o razão não vê duplicação nenhuma (não registra o
  // caixa), então `sempreDevido` é ZERO aqui e quem cuida do caso é este balde.
  const st = () => reduce(ATRASADO);

  test('devolver só o principal não tira serviço da folha, e a marca fica valendo o serviço', () => {
    const e = st();
    const partes = alocarDevolucaoDoPagamento(e, 'txC', e.payments.txC, 10000);
    // Pelo proporcional saía 9091/909: sobrava consumo pago, a marca não
    // fechava, e ficavam 91 de serviço na folha (compliance MEDIUM-2 de ec86b37).
    expect(partes).toEqual({ amountCents: 10000, tipCents: 0 });
    const depois = reduce([...ATRASADO, refunded('txC', partes.amountCents, partes.tipCents)]);
    expect(paidAfterClose(depois).filter((x) => x.txid === 'txC'))
      .toEqual([{ txid: 'txC', amountCents: 1000 }]);
  });

  test('devolver a marca inteira fecha tudo', () => {
    const e = st();
    const partes = alocarDevolucaoDoPagamento(e, 'txC', e.payments.txC, 11000);
    expect(partes).toEqual({ amountCents: 10000, tipCents: 1000 });
    const depois = reduce([...ATRASADO, refunded('txC', partes.amountCents, partes.tipCents)]);
    expect(paidAfterClose(depois).filter((x) => x.txid === 'txC')).toEqual([]);
  });

  test('RESPONDIDO "não pagou no caixa", volta a ser estorno comum e proporcional', () => {
    // A pergunta foi respondida: o pagamento é legítimo, e um estorno dele é um
    // estorno como outro qualquer.
    const respondido = reduce([...ATRASADO, resolvidoEscopado('txC')]);
    expect(alocarDevolucaoDoPagamento(respondido, 'txC', respondido.payments.txC, 5500))
      .toEqual({ amountCents: 5000, tipCents: 500 });
  });

  test('um pagamento que NÃO é atrasado segue proporcional', () => {
    const normal = reduce([opened(20000), paid('t1', 10000, 1000)]);
    expect(alocarDevolucaoDoPagamento(normal, 't1', normal.payments.t1, 5500))
      .toEqual({ amountCents: 5000, tipCents: 500 });
  });
});

describe('o serviço DEVIDO sobrevive ao estorno do principal', () => {
  /**
   * A fração devida saía do LÍQUIDO (`d / l`), e aí a marca se apagava sozinha
   * justamente quando a casa fazia a coisa certa: devolvido o consumo
   * duplicado, `l` e `d` viram zero, o serviço deixa de ser "devido de qualquer
   * jeito" e vira PERGUNTA — com botão. Um clique em "não pagou no caixa"
   * apagava dinheiro do cliente e deixava o valor na base da folha (Lei
   * 13.419/2017 + STJ Tema 1102). A ordem dos cliques voltava a decidir
   * dinheiro, agora por devolver→responder (compliance HIGH-1 de d7f2683).
   */
  const DUPLICIDADE = [opened(20000), paid('txA', 20000, 2000), closed(), paid('txC', 10000, 1000)];

  test('devolvido o consumo duplicado, o serviço continua `sempreDevido`', () => {
    expect(paidAfterClose(reduce(DUPLICIDADE)))
      .toEqual([{ txid: 'txC', amountCents: 1000, sempreDevido: true }]);
    const depois = reduce([...DUPLICIDADE, refunded('txC', 10000, 0)]);
    expect(paidAfterClose(depois))
      .toEqual([{ txid: 'txC', amountCents: 1000, sempreDevido: true }]);
  });

  test('e o botão do painel não consegue apagá-lo', () => {
    const depois = reduce([...DUPLICIDADE, refunded('txC', 10000, 0)]);
    expect(() => validateEvent({
      type: 'PAYMENT_ISSUE_RESOLVED',
      payload: { txid: 'txC', note: 'a mesa não pagou no caixa', by: 'u-1', scope: 'paid_after_close' },
    }, depois)).toThrow(/duplicidade/);
  });

  test('some só quando o próprio serviço volta', () => {
    expect(paidAfterClose(reduce([...DUPLICIDADE, refunded('txC', 10000, 1000)]))).toEqual([]);
  });

  test('na duplicidade PARCIAL a fatia devida também sobrevive', () => {
    const parcial = [opened(20000), paid('txA', 15000, 1500), closed(), paid('txC', 10000, 1000)];
    const antes = paidAfterClose(reduce(parcial));
    expect(antes).toContainEqual({ txid: 'txC', amountCents: 500, sempreDevido: true });
    const depois = paidAfterClose(reduce([...parcial, refunded('txC', 5000, 0)]));
    expect(depois).toContainEqual({ txid: 'txC', amountCents: 500, sempreDevido: true });
  });

  test('a gorjeta já devolvida ABATE o que ainda é devido', () => {
    // Duplicidade parcial (5000 de 10000) com 1000 de serviço: 500 devidos. A
    // casa devolve 300 de gorjeta — restam 200, não 500. Sem esse abatimento a
    // marca pedia de volta um dinheiro que já tinha voltado, e o dono devolvia
    // duas vezes o mesmo serviço.
    const parcial = [opened(20000), paid('txA', 15000, 1500), closed(), paid('txC', 10000, 1000)];
    expect(paidAfterClose(reduce(parcial)))
      .toContainEqual({ txid: 'txC', amountCents: 500, sempreDevido: true });
    expect(paidAfterClose(reduce([...parcial, refunded('txC', 0, 300)])))
      .toContainEqual({ txid: 'txC', amountCents: 200, sempreDevido: true });
    expect(paidAfterClose(reduce([...parcial, refunded('txC', 0, 500)])))
      .not.toContainEqual(expect.objectContaining({ sempreDevido: true }));
  });

  test('a mesa que pagou NO CAIXA continua sem `sempreDevido` — o razão não vê o caixa', () => {
    expect(paidAfterClose(reduce(ATRASADO))).toEqual([{ txid: 'txC', amountCents: 11000 }]);
    expect(paidAfterClose(reduce([...ATRASADO, refunded('txC', 10000, 0)])))
      .toEqual([{ txid: 'txC', amountCents: 1000 }]);
  });
});

test('o CHARGEBACK continua proporcional — ninguém escolheu de onde o dinheiro sai', () => {
  // O balde do consumo-primeiro existe pra quem ESCOLHE devolver. Num
  // chargeback a rede decidiu, e deixar a gorjeta inteira nos livros enquanto a
  // rede levou parte do dinheiro mentiria pra folha (compliance MEDIUM-2 de
  // d7f2683) — que é o que o comentário do `webhook-handler` já dizia.
  const st = reduce(ATRASADO);
  const pg = st.payments.txC;
  expect(alocarDevolucaoDoPagamento(st, 'txC', pg, 5000))
    .toEqual({ amountCents: 5000, tipCents: 0 });
  const forcado = alocarDevolucaoDoPagamento(st, 'txC', pg, 5000, { forcada: true });
  expect(forcado.tipCents).toBeGreaterThan(0);
  expect(forcado.amountCents + forcado.tipCents).toBe(5000);

  const fs = require('node:fs');
  const path = require('node:path');
  const W = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', 'webhook-handler.js'), 'utf8');
  // A disputa perdida marca `forcada`; o estorno comum, não.
  expect(W).toMatch(/alocarDevolucao\(state, parsed\.txid, pay, parsed\.refundDeltaCents, \{ forcada: true \}\)/);
  expect(W).toMatch(/alocarDevolucao\(state, parsed\.txid, pay, delta\)/);
});

describe('a DATA que decide o prazo vem do razão', () => {
  const emDia = (d, ev) => ({ ...ev, created_at: new Date(Date.now() - d * 86400000).toISOString() });
  const velho = [
    emDia(200, opened(30000)), emDia(200, paid('txA', 20000, 2000)),
    emDia(200, closed()), emDia(200, paid('txC', 10000, 1000)),
  ];

  test('sem a linha de `payments`, o Pix de 200 dias ainda é trilho impossível', () => {
    const st = reduce(velho);
    expect(st.payments.txC.confirmedAt).toBeTruthy();
    expect(tetoDaRestituicao(st, 'txC', {}))
      .toMatchObject({ trilhoImpossivel: true, motivo: 'pix_90d', dataConhecida: true });
  });

  test('um razão SEM data (evento montado à mão) segue funcionando — e diz que não sabe', () => {
    const st = reduce(ATRASADO);
    expect(st.payments.txC.confirmedAt).toBeNull();
    expect(tetoDaRestituicao(st, 'txC', {})).toMatchObject({ dataConhecida: false });
  });

  test('trilho SEM prazo cadastrado não é trilho aberto pra sempre', () => {
    // `bizum`: o mercado está construído e desligado, e a devolução legítima
    // não teria como ser registrada NUNCA (compliance MEDIUM-5 de d7f2683).
    const biz = reduce([
      emDia(1, opened(30000)), emDia(1, paid('t1', 30000)), emDia(1, closed()),
      emDia(1, { type: 'PAYMENT_CONFIRMED', payload: { txid: 't2', amountCents: 5000, tipCents: 0, method: 'bizum' } }),
    ]);
    const limites = tetoDaRestituicao(biz, 't2', {});
    expect(limites.prazoConhecido).toBe(false);
    // O excedente não depende de trilho nenhum, então na conta acima há teto.
    // A recusa aparece no atrasado que só COMPLETA a conta: marca existe, sobra
    // não, e o prazo do trilho é desconhecido — "não sei", não "use o
    // adquirente", porque mandar a casa a um trilho que talvez esteja fechado é
    // pior que admitir a dúvida.
    const completa = reduce([
      emDia(1, opened(30000)), emDia(1, paid('t1', 20000)), emDia(1, closed()),
      emDia(1, { type: 'PAYMENT_CONFIRMED', payload: { txid: 'b2', amountCents: 10000, tipCents: 0, method: 'bizum' } }),
    ]);
    expect(paidAfterClose(completa)).toEqual([{ txid: 'b2', amountCents: 10000 }]);
    const semTeto = tetoDaRestituicao(completa, 'b2', {});
    expect(semTeto).toMatchObject({ teto: 0, prazoConhecido: false, dataConhecida: true });
    expect(codigoDaRecusa(completa, 'b2', semTeto)).toBe('payment_age_unknown');
  });
});
