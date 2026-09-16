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

const { reduce, paidAfterClose, validateEvent, sobraPorPagamento } = require('../_lib/checks/check-state');
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

  test('a testemunha do estorno que falhou vale O TAMANHO dela, não a marca inteira', () => {
    /**
     * `reversedOpenCents` ganhou valor, mas quem o lia tratava como sim/não:
     * dez centavos de estorno que falharam autorizavam o dono a declarar a marca
     * INTEIRA como devolvida por fora — R$ 109,10 de atestação em cima de dez
     * centavos de testemunha, com o trilho do Pix aberto pro resto (compliance
     * HIGH-2 e segurança MEDIUM-1 de 41b188a).
     */
    const dez = reduce([...ATRASADO, refunded('txC', 10, 0), revertido('txC', 10, 0)]);
    expect(dez.payments.txC.reversedOpenCents).toBe(10);
    expect(tetoDaRestituicao(dez, 'txC', { confirmedAt: diasAtras(1) }))
      .toMatchObject({ trilhoImpossivel: true, motivo: 'refund_reversed', tardio: 10, teto: 10 });

    // A reversão INTEIRA destrava a marca inteira, que é o caso do runbook.
    const tudo = reduce([...ATRASADO, refunded('txC', 10000, 1000), revertido('txC', 10000, 1000)]);
    expect(tetoDaRestituicao(tudo, 'txC', { confirmedAt: diasAtras(1) }))
      .toMatchObject({ tardio: 11000, teto: 11000 });

    // E o PRAZO vencido continua valendo a marca inteira — ali não há testemunha
    // parcial: o trilho fechou pra tudo.
    expect(tetoDaRestituicao(reduce(ATRASADO), 'txC', { confirmedAt: diasAtras(91) }))
      .toMatchObject({ motivo: 'pix_90d', tardio: 11000, teto: 11000 });
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
  // E a TESTEMUNHA viaja pro rateio: sem ela o pagamento pontual cai no
  // proporcional e tira da folha o que o adquirente diz que nunca foi gorjeta
  // (compliance HIGH-2 de a95e15c).
  expect(rota).toMatch(/limites\.testemunha \? \{ testemunha: limites\.testemunha \} : \{\}\)/);

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

  test('estornar o IRMÃO não transforma serviço GANHO em dívida', () => {
    /**
     * A duplicidade tem de sumir quando ela deixa de existir por um motivo que
     * não é este pagamento ter voltado. E. paga 60, o caixa cobra os 40 que
     * faltam, a conta fecha; o Pix de A (100 + 10) confirma depois, então A tem
     * 60 de duplicidade e 6 de serviço devido. Aí E é estornado: A vira o
     * pagador EXATO e legítimo da conta inteira, e não deve mais nada.
     *
     * Pela fórmula que olhava só a duplicidade ORIGINAL, os 6 continuavam
     * marcados "devolver de qualquer jeito" — sem botão que os dispense,
     * `critical` pra sempre na conciliação, e passados 90 dias a rota de
     * devolução ainda entregava teto pra pagá-los: o runbook mandando a casa
     * devolver ao cliente um dinheiro que ele não tem a receber, e tirando 10%
     * da base da folha (segurança HIGH-1 de 41b188a).
     */
    const irmao = [opened(10000), paid('E', 6000), closed(), paid('A', 10000, 1000)];
    expect(paidAfterClose(reduce(irmao)))
      .toEqual([{ txid: 'A', amountCents: 4400 }, { txid: 'A', amountCents: 600, sempreDevido: true }]);

    const semIrmao = reduce([...irmao, refunded('E', 6000, 0)]);
    expect(semIrmao.overpaidCents).toBe(0);
    expect(paidAfterClose(semIrmao)).toEqual([{ txid: 'A', amountCents: 11000 }]);
    // E a pergunta que sobra PODE ser respondida — é a pergunta do caixa.
    expect(() => validateEvent({
      type: 'PAYMENT_ISSUE_RESOLVED',
      payload: { txid: 'A', note: 'a mesa não pagou no caixa', by: 'u-1', scope: 'paid_after_close' },
    }, semIrmao)).not.toThrow();
  });

  test('um estorno que FALHA depois do fecho CRIA duplicidade — e o serviço dela é devido', () => {
    // `ADJUSTED` é recusado depois do fecho, mas `PAYMENT_REFUND_REVERSED` sobe
    // `paidCents` e dá no mesmo: o atrasado passa a estar duplicado sem nunca
    // ter tido `excessCents` (compliance HIGH-1 de 41b188a).
    const base = [opened(10000), paid('txA', 10000), refunded('txA', 6000, 0), closed(), paid('txC', 6000, 600)];
    expect(reduce(base).payments.txC.excessCents).toBe(0);
    expect(paidAfterClose(reduce(base))).toEqual([{ txid: 'txC', amountCents: 6600 }]);

    /**
     * E A SOBRA QUE A REVERSÃO CRIA É DE QUEM PERDEU O ESTORNO.
     *
     * A versão anterior deste teste afirmava que a duplicidade passava a ser do
     * txC — e ela vinha do mesmo lugar que o painel: `naoNecessario` dava a
     * sobra ao atrasado mais novo. Mas os centavos que voltaram são os que a
     * casa devia ao txA, e o razão diz isso na anomalia ("o cliente ficou sem").
     * Contados nos dois lugares, o painel mandava estornar o txC enquanto a tela
     * do txA prometia a MESMA quantia: R$ 120 sobre R$ 60 de sobra, cada ação
     * justificada pelo que a tela mostrava (compliance HIGH-1 de a95e15c).
     *
     * O txC pagou o que a conta precisava naquele momento — o serviço dele foi
     * prestado, e não é devido.
     */
    const revertido2 = reduce([...base, revertido('txA', 6000, 0)]);
    expect(revertido2.overpaidCents).toBe(6000);
    expect([...sobraPorPagamento(revertido2)]).toEqual([['txA', 6000]]);
    // A marca do txC segue sendo a PERGUNTA inteira — ele pagou o que a conta
    // precisava, e a pergunta dele é a do caixa, não a da duplicidade.
    expect(paidAfterClose(revertido2)).toEqual([{ txid: 'txC', amountCents: 6600 }]);
    expect(() => validateEvent({
      type: 'PAYMENT_ISSUE_RESOLVED',
      payload: { txid: 'txC', note: 'a mesa não pagou no caixa', by: 'u-1', scope: 'paid_after_close' },
    }, revertido2)).not.toThrow();
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

describe('a sobra que uma REVERSÃO cria tem um endereço só', () => {
  /**
   * O `PAYMENT_REFUND_REVERSED` devolve o valor a `paidCents` E grava a
   * testemunha. Os mesmos centavos viravam sobra da conta (endereçada ao
   * atrasado mais novo) e "você tem a receber" do pagador original — dois
   * endereços pro mesmo dinheiro (compliance HIGH-1 de a95e15c).
   */
  const nasceDepois = [
    opened(10000), paid('txA', 10000), refunded('txA', 6000, 0), closed(),
    paid('txC', 6000, 600), revertido('txA', 6000, 0),
  ];

  test('a SOBRA é de quem perdeu o estorno, não do atrasado mais novo', () => {
    const st = reduce(nasceDepois);
    expect(st.overpaidCents).toBe(6000);
    expect(st.payments.txA.reversedOpenCents).toBe(6000);
    expect([...sobraPorPagamento(st)]).toEqual([['txA', 6000]]);
    // E o que a soma dos endereços promete nunca passa do que a casa deve.
    expect([...sobraPorPagamento(st).values()].reduce((a, b) => a + b, 0))
      .toBeLessThanOrEqual(st.overpaidCents);
  });

  test('e o teto de quem perdeu cobre a dívida dele', () => {
    const st = reduce(nasceDepois);
    expect(tetoDaRestituicao(st, 'txA', { confirmedAt: diasAtras(1) }))
      .toMatchObject({ trilhoImpossivel: true, motivo: 'refund_reversed', teto: 6000 });
  });

  test('a soma dos endereços nunca passa da dívida — nem com três pagando tudo', () => {
    // Três pagam a conta inteira e a casa estorna parte de um: o teto por
    // pagamento (em vez de rateio) prometia R$ 300 sobre R$ 270 de dívida, e o
    // runbook manda devolver linha por linha (segurança MEDIUM-1 de a95e15c).
    const tres = reduce([opened(15000), paid('ana', 15000), paid('bruno', 15000),
      paid('carla', 15000), refunded('ana', 3000, 0)]);
    const enderecos = sobraPorPagamento(tres);
    expect([...enderecos.values()].reduce((a, b) => a + b, 0)).toBe(tres.overpaidCents);
  });

  test('a conta REDUZIDA no PDV também ganha endereço', () => {
    // Ninguém tem excedente congelado (correto: ninguém pagou a mais, a conta
    // encolheu), e o painel dizia "a devolver" sem nenhuma cobrança embaixo
    // (segurança MEDIUM-2 de a95e15c).
    const menor = reduce([opened(10000), paid('ch1', 10000),
      { type: 'ADJUSTED', payload: { totalCents: 5000 } }]);
    expect(menor.overpaidCents).toBe(5000);
    expect([...sobraPorPagamento(menor)]).toEqual([['ch1', 5000]]);
  });

  test('o cliente que só digitou um número maior não muda de comportamento', () => {
    const digitou = reduce([opened(10000), paid('t1', 14000, 1000)]);
    expect([...sobraPorPagamento(digitou)]).toEqual([['t1', 4000]]);
    expect(tetoDaRestituicao(digitou, 't1', {}).teto).toBe(4000);
  });
});

test('a testemunha do estorno que falhou vale num pagamento NÃO atrasado', () => {
  /**
   * `marca` só existe pra atrasado. Num pagamento pontual cujo estorno falhou —
   * reclamação legítima, a casa devolve na mão — o teto era zero e a rota
   * respondia `nothing_to_restitute`: sobrava resolver a pendência, que limpa a
   * anomalia sem mover dinheiro, e os R$ 10 de serviço ficavam na base da folha
   * sobre dinheiro que voltou ao cliente (compliance MEDIUM-2 de 089e8a2).
   */
  const pontual = reduce([opened(11000), paid('t1', 10000, 1000),
    refunded('t1', 10000, 1000), revertido('t1', 10000, 1000)]);
  expect(paidAfterClose(pontual)).toEqual([]);          // não é atrasado: não há marca
  expect(pontual.payments.t1.reversedOpenCents).toBe(11000);
  expect(tetoDaRestituicao(pontual, 't1', { confirmedAt: diasAtras(1) }))
    .toMatchObject({ trilhoImpossivel: true, motivo: 'refund_reversed', teto: 11000 });

  // E uma reversão PARCIAL vale só o tamanho dela.
  const parcial = reduce([opened(11000), paid('t1', 10000, 1000),
    refunded('t1', 10000, 1000), revertido('t1', 10, 0)]);
  expect(tetoDaRestituicao(parcial, 't1', { confirmedAt: diasAtras(1) })).toMatchObject({ teto: 10 });
});

test('o motivo grava os DOIS quando os dois valem, e o tamanho da testemunha', () => {
  // A precedência sozinha escrevia `pix_90d` ("só a palavra do dono") sobre um
  // estorno que o adquirente comprovadamente não entregou — perdendo justo a
  // distinção que o campo existe pra guardar (segurança LOW-4 de 089e8a2).
  const velhoEFalho = reduce([...ATRASADO, refunded('txC', 10, 0), revertido('txC', 10, 0)]);
  const limites = tetoDaRestituicao(velhoEFalho, 'txC', { confirmedAt: diasAtras(200) });
  expect(limites.motivo).toBe('refund_reversed+pix_90d');
  expect(limites.revertidoEmAberto).toBe(10);
  // Só o prazo: um motivo só.
  expect(tetoDaRestituicao(reduce(ATRASADO), 'txC', { confirmedAt: diasAtras(200) }).motivo).toBe('pix_90d');

  const fs = require('node:fs');
  const path = require('node:path');
  const R = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  expect(R).toMatch(/reversedOpenCents: limites\.revertidoEmAberto/);
});

describe('a devolução por fora segue A TESTEMUNHA, não o proporcional', () => {
  /**
   * `reversedOpenCents` colapsava consumo e serviço num número só, e o rateio do
   * pagamento PONTUAL caía no proporcional. Um estorno de R$ 50 só de CONSUMO
   * que falha tirava R$ 4,55 da base da folha sobre dinheiro que nunca foi
   * gorjeta; o espelho deixava R$ 9,09 de serviço na folha DEPOIS de ele ter
   * voltado ao cliente (compliance HIGH-2 de a95e15c). O adquirente já diz qual
   * balde falhou — Lei 13.419/2017, STJ Tema 1102 e CLT art. 462, que não deixa
   * desfazer depois.
   */
  const comFalha = (a, t) => reduce([
    opened(10000), paid('t1', 10000, 1000), refunded('t1', a, t), revertido('t1', a, t),
  ]);
  const devolver = (st, valor) => {
    const limites = tetoDaRestituicao(st, 't1', { confirmedAt: diasAtras(1) });
    return {
      limites,
      partes: alocarDevolucaoDoPagamento(st, 't1', st.payments.t1, valor,
        limites.testemunha ? { testemunha: limites.testemunha } : {}),
    };
  };

  test('falhou só o CONSUMO: nada sai da base da folha', () => {
    const st = comFalha(5000, 0);
    expect(st.payments.t1.reversedOpenAmountCents).toBe(5000);
    expect(st.payments.t1.reversedOpenTipCents).toBe(0);
    const { limites, partes } = devolver(st, 5000);
    expect(limites.testemunha).toEqual({ amountCents: 5000, tipCents: 0 });
    expect(partes).toEqual({ amountCents: 5000, tipCents: 0 });
  });

  test('falhou só o SERVIÇO: sai inteiro da base da folha', () => {
    const st = comFalha(0, 1000);
    const { partes } = devolver(st, 1000);
    expect(partes).toEqual({ amountCents: 0, tipCents: 1000 });
  });

  test('falharam os dois: cada um pelo seu tamanho', () => {
    const st = comFalha(10000, 1000);
    const { limites, partes } = devolver(st, limites0(st));
    expect(limites.testemunha).toEqual({ amountCents: 10000, tipCents: 1000 });
    expect(partes).toEqual({ amountCents: 10000, tipCents: 1000 });
  });

  test('o que PASSA da testemunha volta às regras de sempre', () => {
    // Testemunha de 1000 só de consumo, devolução de 2200: 1000 pelo balde da
    // testemunha, o resto proporcional sobre o que sobrou.
    const st = comFalha(1000, 0);
    const { partes } = devolver(st, 2200);
    expect(partes.amountCents + partes.tipCents).toBe(2200);
    expect(partes.amountCents).toBeGreaterThanOrEqual(1000);
    expect(partes.tipCents).toBeGreaterThan(0);
  });
});

/** O teto daquele estado, pra não repetir a chamada. */
function limites0(st) {
  return tetoDaRestituicao(st, 't1', { confirmedAt: new Date(Date.now() - 86400000).toISOString() }).teto;
}
