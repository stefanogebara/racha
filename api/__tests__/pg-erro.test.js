'use strict';

/**
 * O EXTRATOR DO NOME DA RESTRIÇÃO, que decide dinheiro.
 *
 * Enquanto a produção extraía por regex e o dublê recebia o nome de bandeja, o
 * ramo de FALHA da extração não existia em teste nenhum: um `lc_messages`
 * não-inglês, ou uma versão do PostgREST que remonte a mensagem, e a reentrega
 * da mesma devolução fora do trilho passaria a ser "recusada" — o operador leria
 * que o razão não recebeu nada sobre uma devolução que ESTÁ lá, e pagaria o
 * cliente uma segunda vez (segurança LOW-3 de 41b188a).
 */

const { nomeDaRestricao, mensagemDeUnicidade } = require('../_lib/store/pg-erro');
const { desfechoDoLancamento, INDICE_DA_DEVOLUCAO_FORA_DO_TRILHO } = require('../_lib/checks/reconcile');

test('extrai o nome da mensagem que o Postgres escreve', () => {
  expect(nomeDaRestricao(mensagemDeUnicidade('check_events_offrail_refund_uidx')))
    .toBe('check_events_offrail_refund_uidx');
  // A forma real, com o resto da frase em volta.
  expect(nomeDaRestricao('duplicate key value violates unique constraint "check_events_pkey" DETAIL: Key (check_id, seq)=(x, 2) already exists.'))
    .toBe('check_events_pkey');
});

test('o que não dá pra ler volta NULO — e nulo vira recusa, não sucesso', () => {
  for (const texto of [
    'chave duplicada viola a restrição de unicidade "check_events_offrail_refund_uidx"', // pt_BR
    'llave duplicada viola restricción de unicidad',                                     // es
    '', null, undefined, 42,
  ]) {
    expect(nomeDaRestricao(texto)).toBe(null);
  }
  // E é por isso que o lado seguro tem de ser a recusa: sem nome, não é a nossa.
  expect(desfechoDoLancamento(Object.assign(new Error('x'), { pgCode: '23505' }))).toBe('recusado');
  expect(desfechoDoLancamento(Object.assign(new Error('x'), {
    pgCode: '23505', pgConstraint: INDICE_DA_DEVOLUCAO_FORA_DO_TRILHO,
  }))).toBe('duplicado');
});

test('o DUBLÊ passa pelo mesmo extrator — o ramo de falha fica exercitado', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const M = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'memory.js'), 'utf8');
  expect(M).toMatch(/pgConstraint: nomeDaRestricao\(mensagemDeUnicidade\(/);
  const S = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'supabase.js'), 'utf8');
  expect(S).toMatch(/const nome = nomeDaRestricao\(/);
  // E ninguém mais escreve a regex por conta própria.
  for (const fonte of [M, S]) expect(fonte).not.toMatch(/unique constraint "\(\[/);
});

test('o razão do dublê data TODO evento — inclusive o da carteira da casa', async () => {
  // O Postgres tem `default now()` na coluna; um dublê que grava sem data
  // devolve `confirmedAt: null` onde a produção devolve data, e o prazo do
  // trilho passa a existir só em produção (segurança LOW-5 de 41b188a).
  const { createMemoryStore } = require('../_lib/store/memory');
  const { reduce } = require('../_lib/checks/check-state');
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Datas', servicoBp: 1000 });
  const mesa = await store.seedTable(venue.id, 'Mesa 1');
  const conta = await store.openCheck(mesa.qrToken, [{ id: 'a', name: 'Item', priceCents: 5000 }]);
  await store.appendEvent(conta.id, 'PAYMENT_CONFIRMED', { txid: 'p1', amountCents: 1000, tipCents: 0, method: 'pix' });
  // E o caminho da CARTEIRA DA CASA, que grava direto no log sem passar pelo
  // `appendEvent` — era o que estava sem data. Com débito antes: desde a 0043
  // o lançamento sem débito que o pague é recusado.
  const carteira = await store.createHouseAccount({ venueId: venue.id, phone: '11987654321', name: 'D' });
  await store.registerHouseLoad({ accountId: carteira.id, txid: 'l1', amountCents: 5000, bonusCents: 0, validityDays: 30 });
  await store.confirmHouseLoad({ txid: 'l1', confirmedAt: '2026-09-26T12:00:00.000Z' });
  await store.redeemHouse({ accountId: carteira.id, checkId: conta.id, txid: 'h1', amountCents: 1000, nowIso: '2026-09-26T12:01:00.000Z' });
  await store.appendHousePaymentGuarded(conta.id, 'h1', 1000);
  const eventos = await store.loadEvents(conta.id);
  expect(eventos.every((e) => typeof e.created_at === 'string')).toBe(true);
  const estado = reduce(eventos);
  expect(estado.payments.p1.confirmedAt).toBeTruthy();
  expect(estado.payments.h1.confirmedAt).toBeTruthy();
});
