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

test('a série de faturamento desconta a dívida pela regra única', () => {
  for (const arq of ['_lib/store/memory.js', '_lib/store/supabase.js']) {
    const fonte = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
    expect(fonte).toMatch(/for \(const \[txid, centavos\] of sobraPorPagamento\(state\)\)/);
    expect(fonte).not.toMatch(/excessCents/);
  }
});
