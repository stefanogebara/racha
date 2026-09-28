import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerComanda as ler, linhaVazia, QTD_MAXIMA, unitarioDoItem, type LinhaDaComanda } from '../src/comanda.ts';
import { parseBrlToCents } from '../src/api.ts';

const lerComanda = (l: LinhaDaComanda[]) => ler(l, parseBrlToCents);

test('quantidade vira "(Nx)" e o preço da linha é N × unitário, em centavos', () => {
  const r = lerComanda([
    { nome: 'Picanha na chapa', qtd: '1', preco: '89,90' },
    { nome: 'Chopp artesanal', qtd: '4', preco: '13,90' },
  ]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.itens, [
    { id: 'i1', name: 'Picanha na chapa', priceCents: 8990 },
    { id: 'i2', name: 'Chopp artesanal (4x)', priceCents: 5560 },
  ]);
  assert.equal(r.totalCents, 14550);
});

test('a soma é exata e inteira mesmo com preço que em float erraria', () => {
  const linhas = Array.from({ length: 10 }, () => ({ nome: 'Refri', qtd: '3', preco: '0,10' }));
  const r = lerComanda(linhas);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.totalCents, 300);
});

test('linha em branco é ignorada; comanda toda em branco é "vazia"', () => {
  assert.deepEqual(lerComanda([linhaVazia(), linhaVazia()]), { ok: false, erro: 'vazia' });
  const r = lerComanda([{ nome: 'Pudim', qtd: '1', preco: '18,90' }, linhaVazia()]);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.itens.length, 1);
});

test('linha pela metade é ERRO com o número dela — nunca some em silêncio', () => {
  assert.deepEqual(lerComanda([{ nome: 'Pudim', qtd: '1', preco: '18,90' }, { nome: 'Café', qtd: '1', preco: '' }]),
    { ok: false, erro: 'linha_incompleta', linha: 2 });
  assert.deepEqual(lerComanda([{ nome: '', qtd: '1', preco: '5,00' }]), { ok: false, erro: 'linha_incompleta', linha: 1 });
});

test('quantidade e preço inválidos são recusados', () => {
  for (const qtd of ['0', '-1', '1.5', 'dois', String(QTD_MAXIMA + 1)]) {
    assert.equal((lerComanda([{ nome: 'X', qtd, preco: '1,00' }]) as { erro?: string }).erro, 'qtd_invalida', qtd);
  }
  for (const preco of ['0', '0,00', 'abc', '-5']) {
    assert.equal((lerComanda([{ nome: 'X', qtd: '1', preco }]) as { erro?: string }).erro, 'preco_invalido', preco);
  }
});

test('serviço digitado como item é recusado — ele não é consumo', () => {
  for (const nome of ['Serviço 10%', 'servico', 'Gorjeta', 'Taxa de serviço', '10 %']) {
    assert.deepEqual(lerComanda([{ nome, qtd: '1', preco: '15,00' }]), { ok: false, erro: 'servico_como_item', linha: 1 }, nome);
  }
  assert.ok(lerComanda([{ nome: 'Chopp 300ml', qtd: '1', preco: '12,00' }]).ok);
});

test('o unitário aparece só quando a divisão é exata', () => {
  assert.deepEqual(unitarioDoItem('Chopp artesanal (4x)', 5560), { qtd: 4, unitCents: 1390 });
  assert.equal(unitarioDoItem('Picanha na chapa', 8990), null);
  assert.equal(unitarioDoItem('Coisa (3x)', 1000), null);
  assert.equal(unitarioDoItem('Coisa (1x)', 1000), null);
});

test('o que a comanda gera passa INTACTO pelo normalizeItems do servidor', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { normalizeItems } = require('../../../api/_lib/checks/check-service.js');
  const linhas = [
    { nome: 'X'.repeat(200), qtd: '99', preco: '1.234,56' },
    { nome: 'Chopp artesanal', qtd: '4', preco: '13,90' },
    ...Array.from({ length: 198 }, (_, i) => ({ nome: `Item ${i}`, qtd: '1', preco: '0,01' })),
  ];
  const r = lerComanda(linhas);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.itens.length, 200);
  assert.deepEqual(normalizeItems({ items: r.itens }), r.itens);
  assert.equal(lerComanda([...linhas, { nome: 'mais um', qtd: '1', preco: '1,00' }]).ok, false);
});
