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
const { reduce, paidAfterClose, validateEvent, sobraPorPagamento } = require('../_lib/checks/check-state');
const { reconcileCheck } = require('../_lib/checks/reconcile');
const { formatReconcileAlert } = require('../_lib/checks/reconcile-daily');
const { tetoDaRestituicao, payloadDaResolucao, autorDoRegistro } = require('../_lib/checks/restitution');
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

  test('sem a LINHA do pagamento, o relógio das 48 h corre pelo razão', () => {
    /**
     * Ele lia só a linha de `payments`, e sem ela `horas` virava 0: a marca
     * ficava `high` PRA SEMPRE e nunca subia pra `critical` — a dívida com o
     * consumidor parava de subir de tom exatamente quando a projeção falhava,
     * que é o cenário que o conserto da data foi escrito pra fechar
     * (compliance MEDIUM-3 de 41b188a).
     */
    const comData = (at, ev) => ({ ...ev, created_at: at });
    const velhoNoRazao = [
      comData(horasAtras(8 * 24), opened(30000)),
      comData(horasAtras(8 * 24), paid('txA', 10000)),
      comData(horasAtras(8 * 24), paid('txB', 10000)),
      comData(horasAtras(8 * 24), closed()),
      comData(horasAtras(8 * 24), paid('txC', 10000)),
    ];
    const semLinhas = achados(reconcileCheck({ checkId: 'c1', events: velhoNoRazao, payments: [] }));
    expect(semLinhas).toHaveLength(1);
    expect(semLinhas[0].severity).toBe('critical');

    // E a MAIS ANTIGA das duas fontes manda: linha recente, razão velho.
    const linhaNova = linhas(horasAtras(1)).map((l) => ({ ...l }));
    const misto = achados(reconcileCheck({ checkId: 'c1', events: velhoNoRazao, payments: linhaNova }));
    expect(misto[0].severity).toBe('critical');
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
      /**
       * E O PAGAMENTO DE ANTES DO FECHO também é estornado às vezes.
       *
       * O gerador só mexia nos ATRASADOS, e por isso nunca produzia o caso em
       * que a duplicidade some porque o IRMÃO foi devolvido — o atrasado vira o
       * pagador exato e legítimo da conta. Ali um serviço GANHO aparecia como
       * "devolver de qualquer jeito", `critical` pra sempre, e o runbook mandava
       * a casa pagar ao cliente o que ele não tinha a receber (segurança HIGH-1
       * de 41b188a). O estorno que FALHA entra junto: ele devolve dinheiro à
       * conta depois do fecho e pode CRIAR duplicidade onde não havia
       * (compliance HIGH-1 da mesma rodada).
       */
      if (antes.length && rnd(3) === 0) {
        const valor = 1 + rnd(antes[0].payload.amountCents);
        ev.push(refunded('pre', valor, 0));
        if (rnd(4) === 0) {
          ev.push({ type: 'PAYMENT_REFUND_REVERSED', payload: { txid: 'pre', amountCents: valor, tipCents: 0 } });
        }
      }
      const st = reduce(ev);
      const liqAmt = (t) => st.payments[t].amountCents - st.payments[t].refundedAmountCents;
      const liqTip = (t) => st.payments[t].tipCents - st.payments[t].refundedTipCents;
      const marcas = paidAfterClose(st).reduce((soma, x) => soma + x.amountCents, 0);
      const pool = atrasados.reduce((soma, x) => soma + liqAmt(x.txid), 0);
      const atrasadoLiquido = pool + atrasados.reduce((soma, x) => soma + liqTip(x.txid), 0);
      /**
       * A sobra que entra na conta é a ATRIBUÍDA aos atrasados — não
       * `min(overpaid, pool)`.
       *
       * Desde que a sobra criada por uma reversão passou a pertencer a quem
       * perdeu o estorno (compliance HIGH-1 de a95e15c), parte de `overpaidCents`
       * pode ter endereço num pagamento que NÃO é atrasado. O invariante é sobre
       * o dinheiro atrasado, então ele soma o que foi endereçado a atrasados.
       */
      const enderecos = sobraPorPagamento(st);
      const sobraDosAtrasados = atrasados
        .reduce((soma, x) => soma + (enderecos.get(x.txid) || 0), 0);
      void pool;
      expect({ caso, soma: marcas + sobraDosAtrasados }).toEqual({ caso, soma: atrasadoLiquido });
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
    // No COMEÇO da linha, sem `//`: um casamento de texto passava com a linha
    // comentada (segurança LOW-3 de 57c0d2e).
    expect(corpo).toMatch(/^\s*paidAfterClose: paidAfterClose\(state\),/m);
  });

  test('duplicidade PARCIAL: o serviço da parte duplicada fica devido — um centavo de estorno na irmã não o apaga', () => {
    // Só a duplicidade EXATA marcava o serviço como devido: um estorno de um
    // centavo numa irmã e a resposta honesta ("não pagou no caixa") apagava os
    // 10 inteiros (segurança MEDIUM-1 e compliance MEDIUM-C de 57c0d2e).
    const comCentavo = [opened(20000), paid('txA', 10000), paid('txB', 10000), closed(), paid('txC', 10000, 1000), refunded('txA', 1)];
    const doC = (st) => paidAfterClose(st).filter((x) => x.txid === 'txC');
    expect(doC(reduce(comCentavo))).toEqual([{ txid: 'txC', amountCents: 1 }, { txid: 'txC', amountCents: 1000, sempreDevido: true }]);
    expect(doC(reduce([...comCentavo, resolvido('txC')]))).toEqual([{ txid: 'txC', amountCents: 1000, sempreDevido: true }]);
  });

  test('PROPRIEDADE: uma resposta aceita tira EXATAMENTE a pergunta daquele pagamento — nem o devido, nem as irmãs', () => {
    // Antes, responder uma linha mexia no valor das irmãs, e a resposta podia
    // levar o serviço devido junto. Trezentas contas geradas (gerador de 32
    // bits exatos), cada pergunta aberta respondida uma de cada vez.
    let semente = 11;
    const rnd = (n) => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente % n; };
    let respostas = 0;
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
      /**
       * E O PAGAMENTO DE ANTES DO FECHO também é estornado às vezes.
       *
       * O gerador só mexia nos ATRASADOS, e por isso nunca produzia o caso em
       * que a duplicidade some porque o IRMÃO foi devolvido — o atrasado vira o
       * pagador exato e legítimo da conta. Ali um serviço GANHO aparecia como
       * "devolver de qualquer jeito", `critical` pra sempre, e o runbook mandava
       * a casa pagar ao cliente o que ele não tinha a receber (segurança HIGH-1
       * de 41b188a). O estorno que FALHA entra junto: ele devolve dinheiro à
       * conta depois do fecho e pode CRIAR duplicidade onde não havia
       * (compliance HIGH-1 da mesma rodada).
       */
      if (antes.length && rnd(3) === 0) {
        const valor = 1 + rnd(antes[0].payload.amountCents);
        ev.push(refunded('pre', valor, 0));
        if (rnd(4) === 0) {
          ev.push({ type: 'PAYMENT_REFUND_REVERSED', payload: { txid: 'pre', amountCents: valor, tipCents: 0 } });
        }
      }
      /**
       * O QUE OS TRÊS ACHADOS DESTA SÉRIE TINHAM EM COMUM — e a monotonia que
       * eu quase escrevi no lugar.
       *
       * A revisão de segurança pediu "se o devido era positivo e nenhuma gorjeta
       * voltou, continua positivo". Escrevi, e ela ficou vermelha num caso
       * legítimo: estornar o pagamento de ANTES do fecho faz a conta precisar
       * MAIS dos atrasados, então a parte não necessária deles encolhe — que é
       * exatamente o comportamento que a mesma revisão exigiu no achado do
       * irmão. Monotonia é falsa aqui.
       *
       * O que é verdade, e é do que os três achados tratam, não depende da
       * fórmula:
       *
       *  1. se a conta está INTEIRAMENTE coberta sem este pagamento, todo o
       *     serviço que ainda resta nele é `sempreDevido` — não sobra nada
       *     clicável, porque não há pergunta a fazer sobre o caixa;
       *  2. se a conta PRECISA dele por inteiro, nada nele é `sempreDevido` —
       *     senão um serviço ganho vira dívida.
       */
      for (const x of atrasados) {
        for (let corte = 1; corte <= ev.length; corte += 1) {
          const st2 = reduce(ev.slice(0, corte));
          const pg = st2.payments[x.txid];
          if (!pg) continue;
          const liquidoDe = (q) => Math.max(0, q.amountCents - (q.refundedAmountCents || 0));
          const doResto = Object.entries(st2.payments)
            .filter(([t]) => t !== x.txid)
            .reduce((soma, [, q]) => soma + liquidoDe(q), 0);
          // O que a conta tem de quem NÃO chegou atrasado. É esta a cobertura
          // que decide se os atrasados foram precisos: entre atrasados, a
          // convenção é que o mais VELHO cobre e o mais novo duplica, então
          // "coberta sem este" não vale como premissa quando quem cobre é outro
          // atrasado — os dois não podem ser o redundante ao mesmo tempo.
          const dosNaoAtrasados = Object.values(st2.payments)
            .filter((q) => !q.late).reduce((soma, q) => soma + liquidoDe(q), 0);
          const servico = Math.max(0, (pg.tipCents || 0) - (pg.refundedTipCents || 0));
          const marcas = paidAfterClose(st2).filter((m) => m.txid === x.txid);
          const devido = marcas.filter((m) => m.sempreDevido).reduce((soma, m) => soma + m.amountCents, 0);
          const pergunta = marcas.filter((m) => !m.sempreDevido).reduce((soma, m) => soma + m.amountCents, 0);

          if (dosNaoAtrasados >= st2.totalCents && servico > 0 && !pg.lateResolved) {
            // 1. coberta sem ele: o serviço inteiro é devido, e a pergunta não
            // carrega nada de serviço (ela vale, no máximo, o consumo líquido).
            expect({ caso, txid: x.txid, corte, devido, sobrouServicoClicavel: pergunta > liquidoDe(pg) })
              .toEqual({ caso, txid: x.txid, corte, devido: servico, sobrouServicoClicavel: false });
          }
          // Pelo BRUTO, que é a base da regra: o que já voltou continua
          // contando como duplicidade (é o que faz o serviço sobreviver ao
          // estorno do principal), então a premissa "precisou dele todo" tem de
          // olhar o mesmo número.
          if (doResto + Math.max(0, pg.amountCents || 0) <= st2.totalCents) {
            // 2. a conta precisa dele por inteiro: nada é "devido de qualquer jeito".
            expect({ caso, txid: x.txid, corte, devido }).toEqual({ caso, txid: x.txid, corte, devido: 0 });
          }
        }
      }
      const marcasAntes = paidAfterClose(reduce(ev));
      for (const x of marcasAntes.filter((e) => !e.sempreDevido)) {
        const depois = paidAfterClose(reduce([...ev, resolvido(x.txid)]));
        const esperado = marcasAntes.filter((e) => !(e.txid === x.txid && !e.sempreDevido));
        expect({ caso, txid: x.txid, depois }).toEqual({ caso, txid: x.txid, depois: esperado });
        respostas += 1;
      }
    }
    // O gerador EXERCITA: a lição do gerador degenerado que não separava nada.
    expect(respostas).toBeGreaterThan(100);
  });

  test('uma resposta TARDIA — a pergunta já fechou — vira informação, não uma marca vermelha sem dono', () => {
    // Uma corrida com o estorno do adquirente, ou dois cliques: a resposta chega
    // quando não há mais pergunta. Era `high` sem txid, que nada limpava
    // (segurança LOW-2 e compliance LOW-A de 57c0d2e).
    const st = reduce([...MESA, refunded('txC', 10000), resolvido('txC')]);
    expect(st.anomalies.find((a) => a.type === 'PAYMENT_ISSUE_RESOLVED')).toMatchObject({ severity: 'info', txid: 'txC' });
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

describe('as regras puras das duas rotas do dono — testadas sem HTTP', () => {
  test('o teto da devolução REGISTRADA alcança a marca do pago-depois-de-fechar — só com o trilho impossível', () => {
    // Sem alcançá-la, um atrasado cujo estorno falhou, ou um Pix além dos 90
    // dias, não tinha jeito verdadeiro de fechar (compliance MEDIUM-A de
    // 57c0d2e). Alcançando-a SEMPRE, virava um jeito de tirar serviço da folha
    // por atestação (segurança MEDIUM-2 de 3eea5f3) — ver
    // `devolucao-fora-do-trilho.test.js`.
    const st = reduce(MESA);
    const velho = { confirmedAt: new Date(Date.now() - 91 * 86400000).toISOString(), method: 'pix' };
    expect(tetoDaRestituicao(st, 'txC', velho)).toMatchObject({ excesso: 0, tardio: 10000, teto: 10000 });
    expect(tetoDaRestituicao(st, 'txC')).toMatchObject({ tardio: 0, teto: 0 });
    expect(tetoDaRestituicao(st, 'txA', velho)).toMatchObject({ excesso: 0, tardio: 0, teto: 0 });
    const dup = reduce([opened(20000), paid('txA', 10000), paid('txB', 10000), closed(), paid('txC', 10000, 1000)]);
    expect(tetoDaRestituicao(dup, 'txC', velho)).toMatchObject({ excesso: 10000, tardio: 1000, teto: 11000 });
    // O EXCEDENTE não depende do trilho: sobra devolve-se sempre.
    expect(tetoDaRestituicao(dup, 'txC')).toMatchObject({ excesso: 10000, tardio: 0, teto: 10000 });
    expect(tetoDaRestituicao(dup, 'nenhum')).toBeNull();
  });

  test('a resposta escopada grava texto FIXO e o autor pelo ID — o que o cliente mandar não entra', () => {
    // A rota era o único escritor da resposta escopada e nada a testava: tirar
    // o `scope` dela deixava tudo verde (segurança LOW-1 de 57c0d2e). E o autor
    // pelo e-mail num razão que não se apaga (compliance LOW-F).
    const dono = { id: 'u-1', email: 'dono@exemplo.com' };
    expect(payloadDaResolucao({ txid: 'tx1', scope: 'paid_after_close', note: 'devolvi pro Pedro 11 9999' }, dono))
      .toEqual({ txid: 'tx1', note: 'a mesa não pagou no caixa', by: 'u-1', scope: 'paid_after_close' });
    expect(payloadDaResolucao({ txid: 'tx1', note: '  reembolsado por fora  ' }, dono))
      .toEqual({ txid: 'tx1', note: 'reembolsado por fora', by: 'u-1' });
    expect(payloadDaResolucao({ txid: 'tx1', scope: 'outro' }, dono).scope).toBeUndefined();
    expect(autorDoRegistro({ email: 'dono@exemplo.com' })).toBe('dono');
  });

  test('as rotas usam as regras puras — e não as reescrevem', () => {
    const R = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    const trecho = (rota) => { const i = R.indexOf(`url.pathname === '${rota}'`); return R.slice(i, R.indexOf("url.pathname === '", i + 40)); };
    expect(trecho('/api/checks/resolve-issue')).toMatch(/const payload = payloadDaResolucao\(b, user\);/);
    expect(trecho('/api/checks/resolve-issue')).toMatch(/appendValidated\(store, b\.checkId, 'PAYMENT_ISSUE_RESOLVED', payload\)/);
    expect(trecho('/api/checks/record-restitution')).toMatch(/const limites = tetoDaRestituicao\(estado, String\(b\.txid\), \{/);
    // O trilho impossível se decide pela LINHA do pagamento: data e meio.
    expect(trecho('/api/checks/record-restitution')).toMatch(/confirmedAt: linhaDoPagamento && linhaDoPagamento\.confirmedAt/);
    expect(trecho('/api/checks/record-restitution')).toMatch(/method: linhaDoPagamento && linhaDoPagamento\.method/);
    expect(trecho('/api/checks/record-restitution')).toMatch(/by: autorDoRegistro\(user\)/);
  });

  test('os dois códigos do pago-depois-de-fechar se juntam no painel — o serviço critical não expulsa o prazo', () => {
    // (Compliance LOW-D de 57c0d2e.)
    const { projetarAchados } = require('../_app/router');
    const servicos = [1, 2, 3, 4, 5].map((i) => ({ severity: 'critical', code: 'paid_after_close_tip', txid: `s${i}`, amountCents: i }));
    const saida = projetarAchados([...servicos, { severity: 'high', code: 'dispute_evidence_due', txid: 'd1' }]);
    expect(saida.map((f) => f.code)).toEqual(['paid_after_close_tip', 'dispute_evidence_due']);
    expect(saida[0]).toEqual({ severity: 'critical', code: 'paid_after_close_tip', amountCents: 15, count: 5 });
  });
});
