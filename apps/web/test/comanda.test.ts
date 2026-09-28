import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerComanda as ler, linhaVazia, QTD_MAXIMA, type LinhaDaComanda } from '../src/comanda.ts';
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
