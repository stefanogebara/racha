'use strict';

/**
 * QUEM QUER SABER A SOBRA DE UM PAGAMENTO CHAMA `sobraPorPagamento`.
 *
 * O commit que consolidou a regra dizia "havia QUATRO lugares respondendo isso
 * por conta própria". Eram CINCO — e o que ficou de fora alimenta a série
 * semanal de faturamento, que passou a contar como receita a mesma quantia que a
 * linha ao lado chamava de dívida (CC art. 876; segurança HIGH-1 de a95e15c).
 *
 * O erro não foi o conserto: foi CONTAR À MÃO. Um `grep` teria listado seis. É
 * isso que este censo faz, toda vez, de graça.
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

/**
 * Quem PODE ler o excedente congelado, e por quê. Declaração por arquivo, com
 * motivo — não por silêncio.
 */
const PODEM = {
  '_lib/checks/check-state.js':
    'é a dona da regra: `sobraPorPagamento` combina o congelado (quem entrou com '
    + 'excedente) com o vivo (quem a conta não precisou) e rateia pelo que a casa deve.',
  '_lib/checks/refund-allocation.js':
    'aloca UM estorno dentro do pagamento (de onde o dinheiro sai: consumo antes '
    + 'da gorjeta). É a pergunta "como reparto o que está voltando", não "quanto este '
    + 'pagamento ainda deve" — e o excedente congelado é o que descreve de onde aquele '
    + 'dinheiro entrou, que não muda depois.',
  '_lib/checks/reconcile.js':
    'decide se um `overpayment` já foi RESOLVIDO: o teste é "havia excedente nesta '
    + 'cobrança e ele já voltou", e "havia" é justamente o número congelado.',
  '_lib/pay/webhook-handler.js':
    'GRAVA o campo no payload do `PAYMENT_CONFIRMED` quando o adquirente reporta '
    + 'excedente; não o lê pra decidir nada. O redutor deriva o dele e usa o do '
    + 'adaptador só como conferência.',
  '_lib/pay/pagarme-psp.js':
    'PRODUZ o campo a partir do que a Pagar.me reporta na cobrança — é a fronteira '
    + 'onde o número entra no sistema, e ali ele ainda não é decisão de ninguém.',
  '_lib/checks/split-engine.js':
    'recebe o número como PARÂMETRO puro (`allocateRestitution`), sem saber de onde '
    + 'veio nem consultar estado: é aritmética de centavos, e quem decide o valor é '
    + 'quem chama.',
};

test('ninguém deriva a sobra de um pagamento por conta própria', () => {
  const arquivos = [];
  (function varrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p); else if (e.name.endsWith('.js')) arquivos.push(p);
    }
  }(RAIZ));

  const leitores = new Set();
  for (const p of arquivos) {
    const fonte = fs.readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/\bexcessCents\b/.test(fonte)) leitores.add(path.relative(RAIZ, p));
  }

  // Todo leitor tem que estar declarado, e toda declaração tem que descrever um
  // leitor que existe — enumeração que não bate com o código passa calada.
  expect([...leitores].filter((f) => !PODEM[f]).sort()).toEqual([]);
  expect(Object.keys(PODEM).filter((f) => !leitores.has(f)).sort()).toEqual([]);
  // E o motivo é uma frase, não um carimbo.
  for (const [arquivo, porque] of Object.entries(PODEM)) {
    expect(`${arquivo}: ${porque}`).toMatch(/.{80,}/);
  }
});

test('a série de faturamento desconta a dívida — medido, não por regex', async () => {
  /**
   * A versão anterior casava a STRING `for (const [txid, centavos] of
   * sobraPorPagamento(state))` nos dois stores. A revisão de segurança plantou
   * dois mutantes que passaram verdes: um sexto leitor derivando a sobra à mão
   * em outro arquivo (sem escrever `excessCents`), e um segundo laço logo abaixo
   * da linha exigida SOBRESCREVENDO o mapa com a derivação errada. Renomear a
   * variável quebrava; inverter o sentido passava — o falso invariante que este
   * repositório documenta em `br/documento.js` (segurança MEDIUM-2 de 95f72a9).
   *
   * Agora a pergunta é de SAÍDA: a série semanal desconta a dívida? E o mapa que
   * o store monta é IGUAL ao que a regra única diz?
   */
  const { createMemoryStore } = require('../_lib/store/memory');
  const { reduce, sobraPorPagamento } = require('../_lib/checks/check-state');

  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Sobra', servicoBp: 1000 });
  const mesa = await store.seedTable(venue.id, 'Mesa 1');
  const conta = await store.openCheck(mesa.qrToken, [{ id: 'a', name: 'Item', priceCents: 10000 }]);

  // Ana paga a conta inteira; a casa estorna 60; a conta fecha; o Pix do Bruno
  // (60) cai atrasado; o estorno da Ana FALHA. A casa deve 60 — e o faturamento
  // da semana não pode contar esses 60 como receita (CC art. 876).
  const agora = new Date().toISOString();
  const cobrar = async (txid, cents) => {
    await store.registerCharge({ checkId: conta.id, txid, amountCents: cents, tipCents: 0, payerLabel: null });
    await store.recordPayment({ txid, status: 'confirmado', confirmedAt: agora, confirmedAmountCents: cents, confirmedTipCents: 0 });
  };
  await cobrar('ana', 10000);
  await store.appendEvent(conta.id, 'PAYMENT_CONFIRMED', { txid: 'ana', amountCents: 10000, tipCents: 0, method: 'pix' });
  await store.appendEvent(conta.id, 'PAYMENT_REFUNDED', { txid: 'ana', amountCents: 6000, tipCents: 0 });
  await store.appendEvent(conta.id, 'CLOSED', {});
  await cobrar('bruno', 6000);
  await store.appendEvent(conta.id, 'PAYMENT_CONFIRMED', { txid: 'bruno', amountCents: 6000, tipCents: 0, method: 'pix' });
  await store.appendEvent(conta.id, 'PAYMENT_REFUND_REVERSED', { txid: 'ana', amountCents: 6000, tipCents: 0, testemunhado: true });

  const estado = reduce(await store.loadEvents(conta.id));
  expect(estado.overpaidCents).toBe(6000);
  const esperado = sobraPorPagamento(estado);
  expect([...esperado]).toEqual([['ana', 6000]]);

  const painel = await store.getPanelView(venue.id);
  // O MAPA que o store monta é o mesmo da regra única — comparação de mapas,
  // não de texto.
  const daConta = (painel.checks || []).find((c) => c.checkId === conta.id);
  const doPainel = new Map(((daConta && daConta.state && daConta.state.overpaidTxids) || [])
    .map((x) => [x.txid, x.restituteCents]));
  expect([...doPainel]).toEqual([...esperado]);

  // E A SÉRIE SEMANAL DESCONTA: o faturamento não conta a dívida (CC art. 876).
  // Recebido 16000, dívida 6000 → 10000. Lido do congelado, a dívida era
  // invisível aqui e a série dizia 16000 (segurança HIGH-1 de 95f72a9).
  expect(painel.ativacao.semana.valorCents).toBe(10000);
});

test('os DOIS stores montam a sobra pela mesma implementação', () => {
  /**
   * A metade de saída deste censo passou a medir só o store de MEMÓRIA, e o de
   * PRODUÇÃO ficou sem nada: a revisão de segurança plantou nele um segundo laço
   * sobrescrevendo o mapa com a derivação errada, e a suíte inteira ficou verde
   * — o painel mandaria o dono devolver ao pagador errado (segurança MEDIUM-2 de
   * 11a0904). Agora a regra é um módulo com dois chamadores, e o censo confere
   * que nenhum dos dois a reimplementa.
   */
  for (const arq of ['_lib/store/memory.js', '_lib/store/supabase.js']) {
    const fonte = fs.readFileSync(path.join(RAIZ, arq), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(fonte).toMatch(/overpaidTxids: linhasDeSobra\(state\)/);
    expect(fonte).toMatch(/acumularSobra\(state, sobraPorTxid\)/);
    // E não chamam a regra crua por conta própria: quem quiser mudar a resposta
    // muda o módulo, onde o teste de saída está.
    expect(fonte).not.toMatch(/sobraPorPagamento\(/);
  }
});

test('a regra do painel é medida na SAÍDA, não pela grafia', () => {
  // O módulo é puro: dá pra perguntar direto, sem store.
  const { linhasDeSobra, acumularSobra } = require('../_lib/checks/sobra-do-painel');
  const { reduce } = require('../_lib/checks/check-state');
  const ev = (type, payload) => ({ type, payload });
  const st = reduce([
    ev('OPENED', { totalCents: 10000 }),
    ev('PAYMENT_CONFIRMED', { txid: 'ana', amountCents: 10000, tipCents: 0, method: 'pix' }),
    ev('PAYMENT_REFUNDED', { txid: 'ana', amountCents: 6000, tipCents: 0 }),
    ev('CLOSED', {}),
    ev('PAYMENT_CONFIRMED', { txid: 'bruno', amountCents: 6000, tipCents: 0, method: 'pix' }),
    ev('PAYMENT_REFUND_REVERSED', { txid: 'ana', amountCents: 6000, tipCents: 0, testemunhado: true }),
  ]);
  // A sobra é de quem perdeu o estorno — e é ESSA cobrança que o painel nomeia.
  expect(linhasDeSobra(st)).toEqual([{ txid: 'ana', restituteCents: 6000 }]);
  expect([...acumularSobra(st, new Map())]).toEqual([['ana', 6000]]);
});
