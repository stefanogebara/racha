'use strict';

/**
 * A REVERSÃO DE ESTORNO, MEDIDA — quatro consertos da rodada de 53c9ff0 que
 * tinham prosa e não tinham teste.
 *
 * Os quatro são da mesma família: o caminho da reversão decide coisas caras (se
 * a testemunha do adquirente é verdadeira, se a entrega é nova ou repetida) e
 * cada decisão era invisível de fora. Um deles — a anomalia "sem id do estorno"
 * — estava MORTO em 100% das execuções por um `ReferenceError` na zona morta
 * temporal engolido por um `catch {}`, e a suíte inteira ficava verde, porque
 * nenhum teste perguntava se a anomalia existia (segurança HIGH-1 e compliance
 * HIGH-1 de 53c9ff0).
 *
 * Aqui a pergunta é sempre de SAÍDA: o que ficou no razão.
 */

const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');

/** Uma conta rachada entre dois pagadores em partes IGUAIS — o caso normal. */
async function mesaRachada() {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 6000 }]);
  const deps = {
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    // A REPARAÇÃO precisa destes dois: sem eles `repairRowFromLedger` sai calado
    // na primeira linha, e um teste que os omite prova que o reparo "funciona"
    // sem nunca chamá-lo.
    getPayment: store.getPayment.bind(store),
    repairPaymentRow: store.repairPaymentRow.bind(store),
  };
  for (const txid of ['pi_ana', 'pi_bruno']) {
    await store.registerCharge({
      checkId: check.id, txid, amountCents: 3000, tipCents: 300, payerLabel: null, method: 'card',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid, amountCents: 3000, tipCents: 300, method: 'card', eventId: `evt_pago_${txid}`,
    }, deps);
  }
  return { store, check, deps };
}

const eventos = async (store, checkId) => store.loadEvents(checkId);
const reversoes = (evs, txid) => evs.filter((e) => e.type === 'PAYMENT_REFUND_REVERSED'
  && e.payload && e.payload.txid === txid);
const anomalias = (evs) => evs.filter((e) => e.type === 'PAYMENT_ANOMALY').map((e) => e.payload);

test('a reversão de um pagador não consome a testemunha do outro', async () => {
  const { store, check, deps } = await mesaRachada();
  // Os dois são estornados pelo MESMO valor — partes iguais, é o que acontece.
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_bruno', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_bruno',
  }, deps);

  // A falha da Ana chega primeiro, e casa sozinha: testemunha VERDADEIRA.
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f_ana', refundId: 're_ana',
  }, deps);
  // A do Bruno chega depois. O lançamento dele é o único daquele valor NO
  // PAGAMENTO DELE — nada foi consumido. Sem o filtro por txid, a reversão da
  // Ana zerava o contador do Bruno e a testemunha dele virava `false`: o rateio
  // proporcional entrando no lugar do que o adquirente afirmou, e a devolução
  // por fora perdendo a autorização pra tirar da base da folha (Lei 13.419).
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_bruno', amountCents: 1100, eventId: 'evt_f_bruno', refundId: 're_bruno',
  }, deps);

  const evs = await eventos(store, check.id);
  expect(reversoes(evs, 'pi_ana').map((e) => e.payload.testemunhado)).toEqual([true]);
  expect(reversoes(evs, 'pi_bruno').map((e) => e.payload.testemunhado)).toEqual([true]);
  // E o dinheiro dos dois voltou ao que era antes do estorno.
  const st = reduce(evs);
  expect(st.payments.pi_ana.refundedAmountCents + st.payments.pi_ana.refundedTipCents).toBe(0);
  expect(st.payments.pi_bruno.refundedAmountCents + st.payments.pi_bruno.refundedTipCents).toBe(0);
});

test('reversão SEM id do estorno entra e GRITA — a anomalia existe mesmo', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  const r = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f_ana', refundId: null,
  }, deps);
  expect(r.status).toBe('appended');

  const alta = anomalias(await eventos(store, check.id))
    .filter((a) => a.severity === 'high' && /sem id do estorno/.test(a.reason || ''));
  // Uma, com o VALOR dentro: é o número que alguém confere no painel do
  // adquirente. Era ele que estourava na zona morta temporal.
  expect(alta.length).toBe(1);
  expect(alta[0].reason).toMatch(/1100/);
  expect(alta[0].txid).toBe('pi_ana');
});

test('sem id, a REENTREGA é pega pelo consumo — não reverte duas vezes', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: null,
  }, deps);
  // A casa estorna de novo, agora 1200 — outro lançamento, outro valor. Com ele
  // `jaEstornado` deixa de ser 0, e o ramo "reversão antes do estorno" não
  // segura mais nada. O que segura é o CONSUMO: o único lançamento de 1100 já
  // foi revertido, e a segunda entrega da mesma falha não tem com o que casar.
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1200, method: 'card', eventId: 'evt_est_ana_2',
  }, deps);
  // A LINHA DIVERGE do razão — é para isto que o reparo existe. Como ela
  // divergiu não importa (perda de escrita entre duas entregas em voo é o caso
  // real); o que importa é que a entrega repetida não passa por cima em
  // silêncio. Sem `repairRowFromLedger` neste ramo, a linha ficava `devolvido`
  // pra sempre e o painel contava como devolvido um dinheiro que está na casa.
  await store.recordPayment({ txid: 'pi_ana', status: 'devolvido' });
  expect((await store.getPayment('pi_ana')).status).toBe('devolvido');

  const segunda = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f2', refundId: null,
  }, deps);
  expect(segunda.status).toBe('duplicate');

  const evs = await eventos(store, check.id);
  expect(reversoes(evs, 'pi_ana').length).toBe(1);
  // O razão diz que sobrou dinheiro no pagamento; a linha voltou a dizer o mesmo.
  const st = reduce(evs);
  expect(st.payments.pi_ana.refundedAmountCents + st.payments.pi_ana.refundedTipCents).toBe(1200);
  expect((await store.getPayment('pi_ana')).status).toBe('confirmado');
});

test('a janela do deploy tem NOME: reversão com id sobre uma sem id do mesmo valor', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  // A primeira entrega é de ANTES do deploy: sem `re_` no razão, e não há como
  // preencher depois.
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: null,
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana_2',
  }, deps);
  // A segunda chega DEPOIS do deploy, com id. Reentrega ou falha nova? Não dá
  // pra saber — então aplica e grita, com valor e txid.
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f2', refundId: 're_novo',
  }, deps);

  const ambigua = anomalias(await eventos(store, check.id))
    .filter((a) => /reentrega ou falha nova/.test(a.reason || ''));
  expect(ambigua.length).toBe(1);
  expect(ambigua[0].severity).toBe('high');
  expect(ambigua[0].reason).toMatch(/1100/);
});

test('reversão ANTES do estorno é anomalia ALTA — ninguém reentrega um 200', async () => {
  const { store, check, deps } = await mesaRachada();
  const r = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: 're_x',
  }, deps);
  expect(r.status).toBe('out_of_order');
  const fora = anomalias(await eventos(store, check.id))
    .filter((a) => /antes do estorno/.test(a.reason || ''));
  expect(fora.length).toBe(1);
  // `info` mantinha em silêncio uma reversão DESCARTADA: dinheiro do cliente
  // sem dono no razão, com as duas projeções contando a mesma mentira.
  expect(fora[0].severity).toBe('high');
});

test('a segunda entrega do MESMO `re_` também reconcilia a linha', async () => {
  const { store, check, deps } = await mesaRachada();
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_ana', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_est_ana',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f1', refundId: 're_x',
  }, deps);
  // `refund.failed` e `refund.updated` com status `failed` são a entrega NORMAL
  // da Stripe: dois `evt_`, o mesmo `re_`. A segunda é atalho, e o atalho também
  // é um lugar onde a linha pode estar velha.
  await store.recordPayment({ txid: 'pi_ana', status: 'devolvido' });
  const segunda = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_ana', amountCents: 1100, eventId: 'evt_f2', refundId: 're_x',
  }, deps);
  expect(segunda.status).toBe('duplicate');
  expect(reversoes(await eventos(store, check.id), 'pi_ana').length).toBe(1);
  expect((await store.getPayment('pi_ana')).status).toBe('confirmado');
});

/**
 * ── A RODADA DEZ ────────────────────────────────────────────────────────────
 * Quatro achados ALTOS das duas revisões obrigatórias, cada um com o cenário que
 * o produz. O casamento em si está enumerado em `reversal-match.test.js`; aqui
 * é o que só se vê com o razão, a linha e o `validateEvent` no caminho.
 */

/** Uma conta com UM pagador — o cenário mais simples que ainda move dinheiro. */
async function mesaSimples(itemCents = 10000, tipCents = 1000) {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Prato', priceCents: itemCents }]);
  const deps = {
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    getPayment: store.getPayment.bind(store),
    repairPaymentRow: store.repairPaymentRow.bind(store),
  };
  await store.registerCharge({
    checkId: check.id, txid: 'pi_x', amountCents: itemCents, tipCents, payerLabel: null, method: 'card',
  });
  await applyConfirmedPayment({
    kind: 'payment_confirmed', txid: 'pi_x', amountCents: itemCents, tipCents, method: 'card', eventId: 'evt_pago',
  }, deps);
  return { store, check, deps };
}

test('a segunda entrega da janela do deploy é REENTREGA — não "chegou antes do estorno"', async () => {
  const { store, check, deps } = await mesaSimples(3000, 300);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_e1',
  }, deps);
  // A primeira entrega é de ANTES do deploy: sem `re_` no razão, e sem como
  // preencher depois.
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 1100, eventId: 'evt_f1', refundId: null,
  }, deps);
  // A irmã (`refund.updated` com status `failed`) chega DEPOIS do deploy, com id.
  const segunda = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 1100, eventId: 'evt_f2', refundId: 're_x',
  }, deps);

  // Era `out_of_order`: 200, sem reparo da linha, com um segundo aviso ao
  // fundador e uma frase FALSA e permanente no razão.
  expect(segunda.status).toBe('duplicate');
  const evs = await eventos(store, check.id);
  expect(reversoes(evs, 'pi_x').length).toBe(1);
  expect(anomalias(evs).filter((a) => /antes do estorno/.test(a.reason || ''))).toEqual([]);
});

test('uma reversão proporcional não consome candidato — nem vira 409 eterno', async () => {
  /**
   * Dois lançamentos de 1000 com repartições DIFERENTES. A falha de um chega,
   * é ambígua, entra proporcional. A do outro chega depois: o código antigo
   * consumia o primeiro candidato e casava com o segundo, carimbando testemunha
   * sobre um valor maior do que o que restava estornado — `validateEvent`
   * recusava, a rota devolvia 409, a Stripe reenviava até desabilitar o
   * endpoint, e o dinheiro que voltou pra casa nunca entrava no razão
   * (compliance HIGH-1 da rodada dez).
   */
  const { store, check, deps } = await mesaSimples(10000, 2000);
  await store.appendEvent(check.id, 'PAYMENT_REFUNDED', { txid: 'pi_x', amountCents: 0, tipCents: 1000 });
  await store.appendEvent(check.id, 'PAYMENT_REFUNDED', { txid: 'pi_x', amountCents: 600, tipCents: 400 });

  const a = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 1000, eventId: 'evt_fa', refundId: 're_a',
  }, deps);
  const b = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 1000, eventId: 'evt_fb', refundId: 're_b',
  }, deps);
  // As duas ENTRAM. Nenhuma é recusada, e nenhuma carimba testemunha.
  expect([a.status, b.status]).toEqual(['appended', 'appended']);
  const evs = await eventos(store, check.id);
  expect(reversoes(evs, 'pi_x').map((e) => e.payload.testemunhado)).toEqual([false, false]);
  // E a segunda GRITA, porque é ambígua de verdade.
  expect(anomalias(evs).some((a2) => /reentrega ou falha nova/.test(a2.reason || ''))).toBe(true);
});

test('uma falha MAIOR do que o razão conhece não é cortada em silêncio', async () => {
  /**
   * `falhou` é o `Refund.amount` da Stripe; `jaEstornado` é o que o nosso razão
   * sabe. O `Math.min` cortava a diferença sem anomalia, sem log — e o número já
   * cortado ia casar por valor, podendo casar exatamente com um estorno que deu
   * CERTO: o razão revertia o estorno certo, com testemunha, e abria teto de
   * devolução por fora sobre dinheiro que o cliente já tinha recebido
   * (compliance HIGH-2 da rodada dez; CC art. 884, CDC art. 42).
   */
  const { store, check, deps } = await mesaSimples(3000, 300);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 1100, method: 'card', eventId: 'evt_e1',
  }, deps);
  // O adquirente relata falha de 2000 — o razão só conhece 1100 estornados.
  const r = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 2000, eventId: 'evt_f1', refundId: 're_2',
  }, deps);
  expect(r.status).toBe('appended');

  const evs = await eventos(store, check.id);
  const grito = anomalias(evs).filter((a) => /relata falha de 2000/.test(a.reason || ''));
  expect(grito.length).toBe(1);
  expect(grito[0].severity).toBe('high');
  // E o valor cortado NÃO sustenta testemunha: é, por construção, uma coisa que
  // o adquirente não disse.
  expect(reversoes(evs, 'pi_x').map((e) => e.payload.testemunhado)).toEqual([false]);
});

test('um chargeback parcial não faz o estorno seguinte virar reentrega', async () => {
  /**
   * `charge.amount_refunded` conta objetos `Refund`; uma disputa nunca o
   * incrementa. Comparando com o nosso acumulado TOTAL — com o chargeback
   * dentro — o nosso ficava permanentemente à frente, e todo estorno de verdade
   * que viesse depois caía em `delta <= 0`: engolido, sem anomalia e sem log,
   * com o cliente já com o dinheiro na mão (segurança HIGH-4 da rodada dez).
   */
  const { store, check, deps } = await mesaSimples(10000, 1000);
  await applyConfirmedPayment({
    kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 3000, method: 'dispute',
    eventId: 'evt_d1', disputeId: 'dp_1',
  }, deps);
  const r = await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 3000, method: 'card', eventId: 'evt_e1',
  }, deps);
  expect(r.status).toBe('appended');

  const st = reduce(await eventos(store, check.id));
  // Os dois saíram: 3000 pela rede, 3000 pelo estorno.
  expect(st.payments.pi_x.refundedAmountCents + st.payments.pi_x.refundedTipCents).toBe(6000);
  // E a reentrega DE VERDADE do estorno continua sendo reentrega.
  const dnv = await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 3000, method: 'card', eventId: 'evt_e2',
  }, deps);
  expect(dnv.status).toBe('duplicate');
});

test('uma falha de estorno não desfaz um chargeback que a rede levou', async () => {
  /**
   * Sem a exclusão da disputa do conjunto de candidatos, a linha do chargeback
   * era "a única que casa": a conta voltava de `parcial` pra `paga` sobre
   * dinheiro que não está mais na casa, com testemunha forjada abrindo teto de
   * devolução por fora (segurança HIGH-3 da rodada dez).
   */
  const { store, check, deps } = await mesaSimples(10000, 1000);
  await applyConfirmedPayment({
    kind: 'dispute_lost', txid: 'pi_x', refundDeltaCents: 3000, method: 'dispute',
    eventId: 'evt_d1', disputeId: 'dp_1',
  }, deps);
  const antes = reduce(await eventos(store, check.id));
  expect(antes.status).toBe('parcial');

  const r = await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 3000, eventId: 'evt_f1', refundId: 're_1',
  }, deps);
  /**
   * NENHUMA reversão entra, e a saída é `out_of_order`: pelo que o ADQUIRENTE
   * estornou, este pagamento não teve estorno nenhum — o que há é um chargeback,
   * e uma disputa não é um objeto `Refund` que possa falhar.
   *
   * A primeira versão deste teste afirmava só `testemunhado === false`, e o
   * próprio cabeçalho dela nomeava o desfecho que ela não media ("a conta voltava
   * de `parcial` pra `paga` sobre dinheiro que não está mais na casa"). Medido
   * então: a conta VOLTAVA mesmo — `paidCents` de 7273 pra 10000, com a gorjeta
   * junto, na base de cálculo da folha, e zero anomalias. A negação da testemunha
   * era metade do conserto (segurança HIGH-1 da rodada onze).
   */
  expect(r.status).toBe('out_of_order');
  const evs = await eventos(store, check.id);
  expect(reversoes(evs, 'pi_x')).toEqual([]);
  const st = reduce(evs);
  // O dinheiro que a rede levou CONTINUA fora, e a conta continua reaberta.
  expect(st.status).toBe('parcial');
  expect(st.paidCents).toBe(antes.paidCents);
  expect(st.payments.pi_x.refundedAmountCents + st.payments.pi_x.refundedTipCents).toBe(3000);
  // E GRITA, que é o que o ramo de fora de ordem existe pra fazer: o saldo da
  // disputa mascarava esta guarda, então ela nunca disparava sobre uma conta
  // que já tinha sofrido chargeback.
  expect(anomalias(evs).some((a) => /antes do estorno/.test(a.reason || ''))).toBe(true);
});

test('o acumulado do trilho DESCE na reversão — senão o estorno seguinte é engolido', async () => {
  /**
   * `charge.amount_refunded` conta objetos `Refund`. A nossa régua tem que
   * medir a mesma coisa — e ela SOBE no estorno e DESCE na reversão. Contada só
   * pra cima (ou, pior, contando disputa sem descer), depois de uma reversão ela
   * afirmava um estorno vivo que não existe mais: o próximo estorno DE VERDADE
   * caía em `delta <= 0` e era engolido como reentrega, sem anomalia e sem log,
   * com o cliente já com o dinheiro na mão (segurança HIGH-2 da rodada onze).
   */
  const { store, check, deps } = await mesaSimples(10000, 1000);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 3000, method: 'card', eventId: 'evt_e1',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'pi_x', amountCents: 3000, eventId: 'evt_f1', refundId: 're_1',
  }, deps);
  const meio = reduce(await eventos(store, check.id));
  expect(meio.payments.pi_x.refundedAmountCents + meio.payments.pi_x.refundedTipCents).toBe(0);
  // A régua voltou a ZERO junto — não ficou presa no que já foi desfeito.
  expect(meio.payments.pi_x.refundedPeloTrilhoAmountCents
    + meio.payments.pi_x.refundedPeloTrilhoTipCents).toBe(0);

  // A casa refaz o estorno. O adquirente manda o acumulado dele: 3000.
  const r = await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 3000, method: 'card', eventId: 'evt_e2',
  }, deps);
  expect(r.status).toBe('appended');
  const fim = reduce(await eventos(store, check.id));
  expect(fim.payments.pi_x.refundedAmountCents + fim.payments.pi_x.refundedTipCents).toBe(3000);
});

test('uma devolução que o DONO fez no caixa não entra na régua do adquirente', async () => {
  /**
   * `charge.amount_refunded` não conta a devolução que o dono registrou fora do
   * trilho — o adquirente nunca a viu. Com ela dentro da régua, a casa devolvia
   * R$ 30,00 no caixa e os estornos de cartão seguintes eram engolidos como
   * `duplicate`, sem anomalia: cliente com o dinheiro na mão e o razão dizendo
   * que a casa o tem, com o serviço na base da folha (segurança HIGH-3 da
   * rodada onze).
   */
  const { store, check, deps } = await mesaSimples(10000, 1000);
  await store.appendEvent(check.id, 'PAYMENT_REFUNDED', {
    txid: 'pi_x', amountCents: 2727, tipCents: 273, offRail: true, reference: 'caixa', by: 'dono@bar',
  });
  const r = await applyConfirmedPayment({
    kind: 'refund', txid: 'pi_x', cumulativeRefundedCents: 2000, method: 'card', eventId: 'evt_e1',
  }, deps);
  expect(r.status).toBe('appended');
  const st = reduce(await eventos(store, check.id));
  // Os dois saíram: 3000 pelo caixa, 2000 pelo cartão.
  expect(st.payments.pi_x.refundedAmountCents + st.payments.pi_x.refundedTipCents).toBe(5000);
});
