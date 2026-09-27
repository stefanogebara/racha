import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarMesasNumeradas, loteValido, MESAS_POR_LOTE } from '../src/mesas-lote.ts';

const erro = (status: number) => Object.assign(new Error(`http ${status}`), { status });

test('cria na ordem, com o nome e o número', async () => {
  const feitas: string[] = [];
  const r = await criarMesasNumeradas(async (l) => { feitas.push(l); }, ' Mesa ', 3, 5);
  assert.deepEqual(feitas, ['Mesa 3', 'Mesa 4', 'Mesa 5']);
  assert.deepEqual(r, { criadas: 3, puladas: 0, erro: null });
});

test('nome que já existe (409) é pulado e o lote segue', async () => {
  const r = await criarMesasNumeradas(async (l) => { if (l === 'Mesa 2') throw erro(409); }, 'Mesa', 1, 3);
  assert.deepEqual(r, { criadas: 2, puladas: 1, erro: null });
});

test('qualquer outro erro PARA o lote e volta o erro', async () => {
  const tentadas: string[] = [];
  const r = await criarMesasNumeradas(async (l) => { tentadas.push(l); if (l === 'Mesa 2') throw erro(500); }, 'Mesa', 1, 5);
  assert.deepEqual(tentadas, ['Mesa 1', 'Mesa 2']);
  assert.equal(r.criadas, 1);
  assert.equal((r.erro as { status: number }).status, 500);
});

test('o progresso conta até o total', async () => {
  const passos: string[] = [];
  await criarMesasNumeradas(async () => {}, 'Mesa', 1, 3, (f, t) => passos.push(`${f}/${t}`));
  assert.deepEqual(passos, ['1/3', '2/3', '3/3']);
});

test('lote inválido não chama o servidor', async () => {
  let chamadas = 0;
  const post = async () => { chamadas++; };
  for (const [p, de, ate] of [['', 1, 3], ['Mesa', 5, 1], ['Mesa', -1, 2], ['Mesa', 1, MESAS_POR_LOTE + 1], ['Mesa', 1.5, 3]] as const) {
    assert.equal(loteValido(p, de, ate), false);
    await criarMesasNumeradas(post, p, de, ate);
  }
  assert.equal(chamadas, 0);
  assert.equal(loteValido('Mesa', 1, MESAS_POR_LOTE), true);
});
