'use strict';

/**
 * QUAL ESTORNO FALHOU — a decisão, enumerada.
 *
 * As duas revisões obrigatórias da rodada dez acharam SETE defeitos nesta
 * decisão, quatro deles ALTOS, e todos da mesma família: um ramo que decide
 * sobre dinheiro e não alcança o caso pelo qual foi escrito. Ela estava
 * espalhada por sessenta linhas dentro do `applyConfirmedPayment`, onde só dava
 * pra testar por cenário. Agora é pura, e dá pra enumerar.
 */

const { casarReversao, candidatoDeEstorno } = require('../_lib/checks/reversal-match');

const est = (payload) => ({ type: 'PAYMENT_REFUNDED', payload: { txid: 'pi', ...payload } });
const rev = (payload) => ({ type: 'PAYMENT_REFUND_REVERSED', payload: { txid: 'pi', ...payload } });
const chaves = (r) => r.anomalias.map((a) => a.chave).sort();

describe('a janela do deploy — o caso que a guarda de identidade NÃO alcança', () => {
  /**
   * Toda reversão que já está no razão nasceu SEM `re_`: o adaptador descartava
   * o id, e não há como preencher depois. A guarda de identidade foi movida pra
   * cima justamente pra cobrir esta janela — e a janela é DEFINIDA pela reversão
   * do razão não ter id, então ela não podia disparar ali. A segunda entrega
   * caía em `jaEstornado === 0` e saía por `out_of_order`, gravando no razão,
   * para sempre, "a reversão chegou antes do estorno". Chegou depois, e já
   * estava aplicada (segurança HIGH-1 da rodada dez).
   */
  test('a segunda entrega, com id, sobre uma reversão SEM id do mesmo valor, é reentrega', () => {
    const razao = [est({ amountCents: 1000, tipCents: 100 }), rev({ amountCents: 1000, tipCents: 100 })];
    expect(casarReversao(razao, 'pi', 1100, 're_x')).toMatchObject({ decisao: 'reentrega', porque: 'consumo' });
  });

  test('e a decisão NÃO depende de o estorno ainda estar vivo no razão', () => {
    // É esse o ponto: depois da primeira reversão o pagamento fica sem estorno
    // vivo (`jaEstornado === 0`). A contagem olha o razão, não o saldo.
    const razao = [est({ amountCents: 1000, tipCents: 100 }), rev({ amountCents: 1000, tipCents: 100 })];
    expect(casarReversao(razao, 'pi', 1100, null).decisao).toBe('reentrega');
  });

  test('mas uma falha de um valor que o razão NÃO conhece não vira reentrega', () => {
    // `R(v) > 0` não é detalhe: sem ele, `0 >= 0` classificaria como reentrega
    // uma falha de um valor que ninguém registrou — justamente o caso em que o
    // adquirente sabe algo que a gente não sabe.
    const razao = [est({ amountCents: 1000, tipCents: 100 })];
    expect(casarReversao(razao, 'pi', 5000, 're_x').decisao).toBe('aplicar');
  });
});

describe('a testemunha', () => {
  test('um candidato, nenhuma reversão antes: testemunha VERDADEIRA, com os baldes dele', () => {
    const razao = [est({ amountCents: 1000, tipCents: 100 })];
    expect(casarReversao(razao, 'pi', 1100, 're_x'))
      .toMatchObject({ decisao: 'aplicar', testemunhado: true, amountCents: 1000, tipCents: 100 });
  });

  test('dois candidatos do mesmo valor não nomeiam lançamento nenhum — nem com a mesma repartição', () => {
    const iguais = [est({ amountCents: 3000, tipCents: 0 }), est({ amountCents: 3000, tipCents: 0 })];
    expect(casarReversao(iguais, 'pi', 3000, 're_x')).toMatchObject({ testemunhado: false });
  });

  /**
   * Uma reversão anterior do mesmo valor derruba a testemunha — e este é o caso
   * que a compliance mediu virando 409 ETERNO.
   *
   * Dois lançamentos de 1000 com repartições diferentes ({0,1000} e {600,400}).
   * A falha de um deles chega primeiro, é ambígua, e entra proporcional. A do
   * outro chega depois: o código antigo CONSUMIA o primeiro candidato e casava
   * com o segundo, carimbando testemunha — e o valor carimbado era maior do que
   * o que restava estornado, então o `validateEvent` recusava, a rota devolvia
   * 409, a Stripe reenviava, e o endpoint acabava desabilitado. O dinheiro que
   * voltou pra casa nunca entrava no razão.
   */
  test('com uma reversão do mesmo valor no meio, ninguém sabe qual candidato ela consumiu', () => {
    const razao = [
      est({ amountCents: 0, tipCents: 1000 }),
      est({ amountCents: 600, tipCents: 400 }),
      rev({ amountCents: 300, tipCents: 700 }),   // proporcional, não testemunhada
    ];
    // A reversão anterior soma 1000, igual aos candidatos: R=1, C=2.
    const r = casarReversao(razao, 'pi', 1000, 're_b');
    expect(r.decisao).toBe('aplicar');
    expect(r.testemunhado).toBe(false);
    // E a ambiguidade tem NOME: alguém confere no painel do adquirente.
    expect(chaves(r)).toEqual(['reversao_ambigua']);
  });
});

describe('quem NÃO é candidato', () => {
  test('a devolução que o DONO registrou — o adquirente nunca a viu', () => {
    expect(candidatoDeEstorno(est({ amountCents: 1000, tipCents: 100, offRail: true }))).toBe(false);
    const razao = [est({ amountCents: 1000, tipCents: 100, offRail: true })];
    expect(casarReversao(razao, 'pi', 1100, 're_x')).toMatchObject({ testemunhado: false });
  });

  /**
   * O CHARGEBACK. `dispute_lost` vira `PAYMENT_REFUNDED` (é dinheiro saindo),
   * mas um `refund.failed` descreve um objeto `Refund` da Stripe, e uma disputa
   * não é um: ela nunca pode ser "o estorno que falhou".
   *
   * As duas exclusões são a MESMA regra, e por meses só uma estava escrita
   * (segurança HIGH-3 da rodada dez).
   */
  test('o chargeback — uma disputa nunca é o estorno que falhou', () => {
    expect(candidatoDeEstorno(est({ amountCents: 2727, tipCents: 273, disputeId: 'dp_1' }))).toBe(false);
  });

  test('e sem a exclusão ele DESTRÓI a testemunha de um estorno de verdade', () => {
    const comDisputa = [
      est({ amountCents: 2727, tipCents: 273 }),                      // o estorno
      est({ amountCents: 2727, tipCents: 273, disputeId: 'dp_1' }),   // o chargeback, mesmo valor
    ];
    // Só o estorno é candidato → C=1 → testemunha de pé.
    expect(casarReversao(comDisputa, 'pi', 3000, 're_1'))
      .toMatchObject({ testemunhado: true, amountCents: 2727, tipCents: 273 });
  });

  test('e sozinho ele seria "o único que casa" — desfazendo no razão um chargeback que a rede levou', () => {
    const soDisputa = [est({ amountCents: 2727, tipCents: 273, disputeId: 'dp_1' })];
    // Nenhum candidato: a reversão até entra (o dinheiro se moveu), mas sem
    // autoridade nenhuma — e é a testemunha que abriria teto de devolução por
    // fora sobre dinheiro que não está mais na casa.
    expect(casarReversao(soDisputa, 'pi', 3000, 're_1')).toMatchObject({ testemunhado: false });
  });
});

describe('os gritos', () => {
  test('sem `re_`, grita — só a Stripe emite isto e o objeto `Refund` sempre traz id', () => {
    const razao = [est({ amountCents: 1000, tipCents: 100 })];
    expect(chaves(casarReversao(razao, 'pi', 1100, null))).toEqual(['sem_refund_id']);
  });

  test('a reentrega NÃO grita: é comportamento normal do adquirente', () => {
    const razao = [est({ amountCents: 1000, tipCents: 100 }), rev({ amountCents: 1000, tipCents: 100 })];
    expect(casarReversao(razao, 'pi', 1100, 're_x').anomalias).toEqual([]);
  });

  test('sem id E com reversão anterior: os DOIS gritos, porque são duas coisas diferentes', () => {
    const razao = [
      est({ amountCents: 1000, tipCents: 0 }), est({ amountCents: 1000, tipCents: 0 }),
      est({ amountCents: 1000, tipCents: 0 }), rev({ amountCents: 1000, tipCents: 0 }),
    ];
    expect(chaves(casarReversao(razao, 'pi', 1000, null))).toEqual(['reversao_ambigua', 'sem_refund_id']);
  });
});

test('o txid isola: nada de outro pagamento entra na conta deste', () => {
  const razao = [
    { type: 'PAYMENT_REFUNDED', payload: { txid: 'outro', amountCents: 1000, tipCents: 100 } },
    { type: 'PAYMENT_REFUND_REVERSED', payload: { txid: 'outro', amountCents: 1000, tipCents: 100 } },
    est({ amountCents: 1000, tipCents: 100 }),
  ];
  // Compensar a dívida de um pagador com o crédito de outro é o que o
  // `refund-allocation` proíbe por escrito (CC art. 876).
  expect(casarReversao(razao, 'pi', 1100, 're_x'))
    .toMatchObject({ decisao: 'aplicar', testemunhado: true, amountCents: 1000, tipCents: 100 });
});

/**
 * A INVARIANTE QUE DE FATO SEGURA O CORTE — e a que eu tinha escrito, que era
 * falsa.
 *
 * O `applyConfirmedPayment` corta a falha relatada pelo que o razão conhece
 * (`aReverter = min(falhou, jaEstornado)`) e, no corte, zera a testemunha. Eu
 * afirmei que essa zeragem era redundante por causa desta invariante: "se existe
 * um candidato vivo somando `falhou`, então `jaEstornado >= falhou`". **Ela é
 * falsa**, e as duas revisões da rodada onze trouxeram o contraexemplo — um
 * razão que o PRÓPRIO handler produz, porque a reversão é gravada pelo valor
 * cortado e rateada proporcionalmente, e então não soma o total de candidato
 * nenhum:
 *
 *     PAYMENT_REFUNDED        {1000, 100}
 *     PAYMENT_REFUNDED        { 909,  91}
 *     PAYMENT_REFUND_REVERSED {1818, 182}
 *     → jaEstornado = 100, falhou = 1100 → HÁ CORTE
 *     → casarReversao: { testemunhado: true, amountCents: 1000, tipCents: 100 }
 *
 * A prova anterior não pegava porque o GERADOR só emitia reversões que
 * espelhavam exatamente um estorno: ele construía o mundo em que a invariante
 * vale. Uma propriedade que gera só o caso fácil é um teste verde sobre nada —
 * a terceira vez que esta suíte aprende isso.
 *
 * A invariante VERDADEIRA é mais simples, e é sobre o casador sozinho: quando
 * ele testemunha, a repartição que ele devolve soma EXATAMENTE `falhou`, porque
 * ela é a de um candidato daquele valor. É isso que faz o `casaOValor` do
 * handler (`amountCents + tipCents === aReverter`) ser falso em todo corte — e
 * é o `casaOValor`, não a zeragem, o suspensório de verdade.
 */
test('propriedade: quem testemunha devolve uma repartição que soma o valor relatado', () => {
  // PRNG de 32 bits com `Math.imul`. Um LCG em ponto flutuante degenera nos
  // bits baixos e gera trezentos casos que não separam nada — já aconteceu
  // nesta suíte, e o mutante ficou verde.
  let semente = 20260916;
  const proximo = () => {
    semente = (Math.imul(semente, 1664525) + 1013904223) | 0;
    return (semente >>> 0) / 4294967296;
  };
  const inteiro = (n) => Math.floor(proximo() * n);

  let testemunhas = 0;
  let cortes = 0;
  let cortesComCasamentoDeValor = 0;
  for (let i = 0; i < 4000; i += 1) {
    const razao = [];
    for (let k = 0, n = 1 + inteiro(4); k < n; k += 1) {
      razao.push({ type: 'PAYMENT_REFUNDED', payload: { txid: 'pi', amountCents: inteiro(2000), tipCents: inteiro(500) } });
    }
    // Reversões de valor ARBITRÁRIO — não espelhos. É assim que o handler as
    // grava: pelo valor cortado, rateado proporcionalmente.
    for (let k = 0, n = inteiro(3); k < n; k += 1) {
      razao.push({
        type: 'PAYMENT_REFUND_REVERSED',
        payload: {
          txid: 'pi', amountCents: inteiro(2000), tipCents: inteiro(500),
          ...(proximo() < 0.5 ? { refundId: `re_${k}` } : {}),
        },
      });
    }
    const jaEstornado = razao.reduce((acc, e) => acc
      + (e.type === 'PAYMENT_REFUNDED' ? (e.payload.amountCents + e.payload.tipCents) : 0)
      - (e.type === 'PAYMENT_REFUND_REVERSED' ? (e.payload.amountCents + e.payload.tipCents) : 0), 0);
    /**
     * O VALOR RELATADO sai de um candidato na maioria das vezes.
     *
     * Sorteado livre em 1..4000 ele quase nunca casa com um lançamento, e a
     * propriedade rodava 4000 vezes sem gerar UMA testemunha — verde sobre nada,
     * que é o defeito que esta versão existe pra não repetir. O contador abaixo
     * é o que denuncia isso.
     */
    const quais = razao.filter((e) => e.type === 'PAYMENT_REFUNDED');
    const falhou = proximo() < 0.75 && quais.length
      ? quais[inteiro(quais.length)].payload.amountCents + quais[inteiro(quais.length)].payload.tipCents
      : 1 + inteiro(4000);
    if (falhou <= 0) continue;
    const r = casarReversao(razao, 'pi', falhou, proximo() < 0.5 ? 're_x' : null);
    if (r.decisao !== 'aplicar' || r.testemunhado !== true) continue;
    testemunhas += 1;
    // A INVARIANTE: a repartição da testemunha soma o valor RELATADO.
    expect(r.amountCents + r.tipCents).toBe(falhou);
    // E daí sai o que o handler precisa: no corte, `casaOValor` é falso.
    const aReverter = Math.min(falhou, jaEstornado);
    if (aReverter !== falhou) {
      cortes += 1;
      if (r.amountCents + r.tipCents === aReverter) cortesComCasamentoDeValor += 1;
    }
  }
  // CONTA o que exercitou: uma propriedade que não gerou o caso que ela vigia é
  // um teste verde sobre nada.
  expect(testemunhas).toBeGreaterThan(200);
  // O gerador ALCANÇA o contraexemplo da invariante velha (corte com testemunha)
  // — é por isso que a prova anterior era viciada.
  expect(cortes).toBeGreaterThan(20);
  // E mesmo ali, o `casaOValor` do handler recusa a repartição: é ele que segura.
  expect(cortesComCasamentoDeValor).toBe(0);
});