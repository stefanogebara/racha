'use strict';

/**
 * O TETO DA DEVOLUÇÃO POR FORA É UMA FRONTEIRA, e fronteira lida-e-depois-
 * escrita não é fronteira.
 *
 * A rota lia o razão, calculava quanto o dono PODE declarar como devolvido sem
 * testemunha, e gravava. Entre uma coisa e outra, nada. A revisão de segurança
 * de ec86b37 mediu contra o store: duas chamadas simultâneas, cada uma no teto,
 * gravaram o DOBRO do direito — `paidCents` abaixo do total, a conta PAGA
 * voltando a 'parcial', o telefone de quem já pagou dizendo que a mesa ainda
 * deve, e uma cobrança nova podendo sair contra quem não deve nada (CDC art.
 * 42). O mesmo estrago sai de um `curl` repetido: a rota é operada à mão pelo
 * runbook e não tinha chave de idempotência — e a cópia do erro de 500 chega a
 * MANDAR conferir antes de repetir, prova de que a repetição era esperada.
 *
 * Conferir e gravar agora são um passo só (migração 0034), com o erro CHECADO
 * (inegociável #7).
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');
const { tetoDaRestituicao } = require('../_lib/checks/restitution');
const { alocarDevolucaoDoPagamento } = require('../_lib/checks/refund-allocation');
const { appendValidated } = require('../_lib/checks/append-validated');
const { desfechoDoLancamento } = require('../_lib/checks/reconcile');

/** O que a rota faz, sem HTTP: lê, calcula o teto, e lança CONDICIONAL. */
async function registrarDevolucao(store, checkId, txid, valor, referencia) {
  const eventos = await store.loadEvents(checkId);
  const seqEsperado = eventos.length ? eventos[eventos.length - 1].seq : 0;
  const estado = reduce(eventos);
  const limites = tetoDaRestituicao(estado, txid, { confirmedAt: new Date().toISOString() });
  if (valor > limites.teto) return { recusado: 'amount_over', teto: limites.teto };
  const partes = alocarDevolucaoDoPagamento(estado, txid, estado.payments[txid], valor);
  try {
    const seq = await appendValidated(store, checkId, 'PAYMENT_REFUNDED', {
      txid, amountCents: partes.amountCents, tipCents: partes.tipCents,
      offRail: true, reference: referencia, by: 'u-1',
    }, null, seqEsperado);
    return { seq, partes };
  } catch (e) {
    // PELO CLASSIFICADOR, como a rota faz. Ler `pgCode` aqui deixava o teste
    // cego justamente pra mudanças no classificador — a prova de mutação que
    // apagava o ramo do 40001 passava verde.
    const desfecho = desfechoDoLancamento(e);
    if (desfecho === 'conflito') return { recusado: 'restitution_conflict' };
    if (desfecho === 'duplicado') return { duplicate: true };
    throw e;
  }
}

async function contaComSobra() {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Atômico', servicoBp: 1000 });
  const mesa = await store.seedTable(venue.id, 'Mesa 1');
  const conta = await store.openCheck(mesa.qrToken, [{ id: 'a', name: 'Item', priceCents: 10000 }]);
  // A paga 50, B paga 100: sobra 50, e o teto de B é 50.
  await store.appendEvent(conta.id, 'PAYMENT_CONFIRMED', { txid: 'A', amountCents: 5000, tipCents: 0, method: 'pix' });
  await store.appendEvent(conta.id, 'PAYMENT_CONFIRMED', { txid: 'B', amountCents: 10000, tipCents: 0, method: 'pix' });
  return { store, checkId: conta.id };
}

test('a sobra da conta é o teto — e o cenário da revisão está montado', async () => {
  const { store, checkId } = await contaComSobra();
  const estado = reduce(await store.loadEvents(checkId));
  expect(estado.overpaidCents).toBe(5000);
  expect(tetoDaRestituicao(estado, 'B', { confirmedAt: new Date().toISOString() }).teto).toBe(5000);
  expect(estado.paidCents).toBe(15000);
});

test('DUAS chamadas simultâneas no teto devolvem o teto, não o dobro', async () => {
  const { store, checkId } = await contaComSobra();
  const [um, dois] = await Promise.all([
    registrarDevolucao(store, checkId, 'B', 5000, 'PIX E2E-1'),
    registrarDevolucao(store, checkId, 'B', 5000, 'PIX E2E-2'),
  ]);
  const vencedores = [um, dois].filter((r) => r.seq);
  expect(vencedores.length).toBe(1);
  expect([um, dois].filter((r) => r.recusado === 'restitution_conflict').length).toBe(1);

  const depois = reduce(await store.loadEvents(checkId));
  expect(depois.payments.B.refundedAmountCents).toBe(5000);   // o teto, não 10000
  expect(depois.paidCents).toBe(10000);                       // e não 5000
  // E a conta NÃO volta a dever: era isto que a mesa via.
  expect(depois.totalCents - depois.paidCents).toBe(0);
});

test('o MESMO comprovante registrado duas vezes é UM lançamento', async () => {
  const { store, checkId } = await contaComSobra();
  const primeira = await registrarDevolucao(store, checkId, 'B', 2500, 'PIX E2E-9');
  expect(primeira.seq).toBeGreaterThan(0);
  // O `curl` que deu timeout e foi repetido — com espaço e caixa trocados, que
  // é como um comprovante volta colado de outro lugar.
  const repetida = await registrarDevolucao(store, checkId, 'B', 2500, '  pix e2e-9 ');
  expect(repetida).toEqual({ duplicate: true });
  const depois = reduce(await store.loadEvents(checkId));
  expect(depois.payments.B.refundedAmountCents).toBe(2500);
});

test('referência DIFERENTE é devolução diferente — e o teto vale pra soma', async () => {
  const { store, checkId } = await contaComSobra();
  expect((await registrarDevolucao(store, checkId, 'B', 2500, 'PIX E2E-1')).seq).toBeGreaterThan(0);
  expect((await registrarDevolucao(store, checkId, 'B', 2500, 'PIX E2E-2')).seq).toBeGreaterThan(0);
  // A terceira não tem mais teto: a sobra acabou.
  expect(await registrarDevolucao(store, checkId, 'B', 2500, 'PIX E2E-3'))
    .toEqual({ recusado: 'amount_over', teto: 0 });
  expect(reduce(await store.loadEvents(checkId)).payments.B.refundedAmountCents).toBe(5000);
});

test('sem `expectedSeq`, o lançamento segue o caminho antigo — nada mais quebra', async () => {
  const { store, checkId } = await contaComSobra();
  const seq = await appendValidated(store, checkId, 'PAYMENT_REFUNDED',
    { txid: 'B', amountCents: 1000, tipCents: 0 });
  expect(seq).toBeGreaterThan(0);
});

test('a rota usa o lançamento condicional, e a leitura que autoriza é a mesma', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const R = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const i = R.indexOf("url.pathname === '/api/checks/record-restitution'");
  const rota = R.slice(i, R.indexOf("url.pathname === '", i + 40));
  expect(rota).toMatch(/const eventosAntes = await store\.loadEvents\(b\.checkId\);/);
  expect(rota).toMatch(/const estado = reduce\(eventosAntes\);/);
  expect(rota).toMatch(/\}, null, seqEsperado\);/);
  // A rota NÃO lê SQLSTATE: quem classifica é o `desfechoDoLancamento`, junto
  // da lista branca (censo em `sql-contract`).
  expect(rota).toMatch(/const desfecho = desfechoDoLancamento\(e\);/);
  expect(rota).toMatch(/desfecho === 'conflito'/);
  expect(rota).toMatch(/desfecho === 'duplicado'/);
  expect(rota).not.toMatch(/pgCode/);
});
