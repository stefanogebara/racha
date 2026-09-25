'use strict';

/**
 * O AJUSTE É UMA TRANSAÇÃO SÓ: o `ADJUSTED` e os itens (`adjust_check`, 0038).
 *
 * Eram duas escritas; dois ajustes cruzados deixavam o TOTAL de um com os
 * ITENS do outro (segurança, PR #21, MÉDIA). O invariante que importa: depois
 * de qualquer corrida, os itens da conta somam o total do razão.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore } = require('../_lib/store/memory');
const { createSupabaseStore } = require('../_lib/store/supabase');
const { createCheckService } = require('../_lib/checks/check-service');
const { reduce } = require('../_lib/checks/check-state');

const RAIZ = path.join(__dirname, '..', '..');

async function mesa() {
  const store = createMemoryStore();
  const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000 });
  const table = store.seedTable(venue.id, 'Mesa 1');
  const svc = createCheckService({ store });
  const aberta = await svc.openCheck({ tableId: table.id, totalCents: 5000 });
  return { store, svc, table, checkId: aberta.checkId };
}

async function estado(store, table, checkId) {
  const view = await store.getCheckByQrToken(table.qrToken);
  const total = reduce(await store.loadEvents(checkId)).totalCents;
  return { total, soma: view.check.items.reduce((s, i) => s + i.priceCents, 0), itens: view.check.items };
}

test('dois ajustes cruzados: os itens da conta somam o total do razão, sempre', async () => {
  for (let rodada = 0; rodada < 25; rodada += 1) {
    const { store, svc, table, checkId } = await mesa();
    // A gravação atômica demora um pouco e em ordem variável — as duas chamadas
    // leem antes de qualquer uma gravar, como numa rede de verdade.
    const original = store.adjustCheck.bind(store);
    store.adjustCheck = async (...args) => { await new Promise((r) => setTimeout(r, Math.random() * 15)); return original(...args); };
    const r = await Promise.allSettled([
      svc.adjustCheck({ checkId, items: [{ name: 'A', priceCents: 7000 }] }),
      svc.adjustCheck({ checkId, items: [{ name: 'B1', priceCents: 4000 }, { name: 'B2', priceCents: 5000 }] }),
    ]);
    for (const x of r) if (x.status === 'rejected') expect(x.reason).toMatchObject({ statusCode: 409, code: 'check_changed' });
    const e = await estado(store, table, checkId);
    expect(e.soma).toBe(e.total);
  }
});

test('ajuste recusado pelo banco (40001 até esgotar) não deixa item nenhum pra trás', async () => {
  const { store, svc, table, checkId } = await mesa();
  const antes = await estado(store, table, checkId);
  store.adjustCheck = async () => { throw Object.assign(new Error('o razão mudou'), { pgCode: '40001' }); };
  await expect(svc.adjustCheck({ checkId, items: [{ name: 'Novo', priceCents: 9999 }] }))
    .rejects.toMatchObject({ statusCode: 409, code: 'check_changed' });
  expect(await estado(store, table, checkId)).toEqual(antes);
});

test('o store em memória recusa item que não soma o total, e não grava nada', async () => {
  const { store, table, checkId } = await mesa();
  const antes = await estado(store, table, checkId);
  const seq = (await store.loadEvents(checkId)).length;
  await expect(store.adjustCheck(checkId, seq, 1000, [{ id: 'x', name: 'X', priceCents: 999 }])).rejects.toMatchObject({ pgCode: '22023' });
  await expect(store.adjustCheck(checkId, seq - 1, 1000, [{ id: 'x', name: 'X', priceCents: 1000 }])).rejects.toMatchObject({ pgCode: '40001' });
  expect(await estado(store, table, checkId)).toEqual(antes);
});

test('supabase: UMA chamada a `adjust_check`, com os nomes da assinatura da 0038', async () => {
  const chamadas = [];
  const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: {
    from: () => { throw new Error('nenhum update solto'); },
    rpc: async (nome, args) => { chamadas.push([nome, args]); return { data: 7, error: null }; },
  } });
  const itens = [{ id: 'a', name: 'X', priceCents: 700 }, { id: 'b', name: 'Y', priceCents: 300 }];
  expect(await store.adjustCheck('c1', 6, 1000, itens)).toBe(7);
  expect(chamadas).toEqual([['adjust_check', { p_check_id: 'c1', p_expected_seq: 6, p_total_cents: 1000, p_items: itens }]]);
  // Os nomes batem com a SQL — um parâmetro renomeado de um lado só é PGRST202.
  const sql = fs.readFileSync(path.join(RAIZ, 'supabase', 'migrations', '0038_adjust_check.sql'), 'utf8');
  const assinatura = sql.match(/create or replace function public\.adjust_check\(([\s\S]*?)\)\s*returns/)[1];
  const params = [...assinatura.matchAll(/\b(p_[a-z_]+)\b/g)].map((m) => m[1]);
  expect(params).toEqual(Object.keys(chamadas[0][1]));
});

test('supabase: o código do banco chega no pgCode (o serviço decide por ele)', async () => {
  const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: {
    from: () => { throw new Error('nenhum update solto'); },
    rpc: async () => ({ data: null, error: { code: '40001', message: 'o razão mudou' } }),
  } });
  await expect(store.adjustCheck('c1', 1, 100, [{ id: 'a', name: 'X', priceCents: 100 }])).rejects.toMatchObject({ pgCode: '40001' });
});

test('censo: o serviço não escreve itens fora da transação; a função é fechada como a 0037', () => {
  const svc = fs.readFileSync(path.join(RAIZ, 'api', '_lib', 'checks', 'check-service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(svc).not.toMatch(/setCheckItems\(/);
  expect(svc).toMatch(/gravar: \(seq\) => store\.adjustCheck\(checkId, seq, newTotal, norm\)/);
  const sql = fs.readFileSync(path.join(RAIZ, 'supabase', 'migrations', '0038_adjust_check.sql'), 'utf8');
  expect(sql).toMatch(/security definer\s+set search_path = public/);
  expect(sql).toMatch(/revoke all on function public\.adjust_check\(uuid, integer, bigint, jsonb\) from public, anon, authenticated;/);
  expect(sql).toMatch(/public\.append_check_event_if_unchanged\(/);   // delega, não reescreve o corpo
  expect(sql).toMatch(/notify pgrst, 'reload schema';/);
});

describe('os itens viajam no evento (compliance, PR #29, M-2)', () => {
  const { validateEvent } = require('../_lib/checks/check-state');
  const aberta = () => reduce([{ seq: 1, type: 'OPENED', payload: { totalCents: 5000 } }]);

  test('o ADJUSTED gravado leva os itens que o cliente viu', async () => {
    const { store, svc, checkId } = await mesa();
    await svc.adjustCheck({ checkId, items: [{ name: 'A', priceCents: 3000 }, { name: 'B', priceCents: 1000 }] });
    const ev = (await store.loadEvents(checkId)).filter((e) => e.type === 'ADJUSTED').pop();
    expect(ev.payload).toEqual({ totalCents: 4000, items: [
      { id: 'i1', name: 'A', priceCents: 3000 }, { id: 'i2', name: 'B', priceCents: 1000 }] });
  });
  test('itens que não somam o total: o evento é recusado', () => {
    expect(() => validateEvent({ type: 'ADJUSTED', payload: { totalCents: 4000, items: [{ priceCents: 3999 }] } }, aberta())).toThrow(/sum 3999 != totalCents 4000/);
    // Lista vazia = sem itens (formato histórico tolerado); não-lista é inválido.
    expect(() => validateEvent({ type: 'ADJUSTED', payload: { totalCents: 4000, items: [] } }, aberta())).not.toThrow();
    expect(() => validateEvent({ type: 'ADJUSTED', payload: { totalCents: 4000, items: 'x' } }, aberta())).toThrow(/must be an array/);
    expect(() => validateEvent({ type: 'ADJUSTED', payload: { totalCents: 4000, items: [{ priceCents: -1 }, { priceCents: 4001 }] } }, aberta())).toThrow();
  });
  test('evento antigo, sem itens, segue válido — o razão não se reescreve', () => {
    expect(() => validateEvent({ type: 'ADJUSTED', payload: { totalCents: 4000 } }, aberta())).not.toThrow();
  });
  test('o store em memória guarda uma CÓPIA dos itens, não a referência de quem chamou', async () => {
    const { store, table, checkId } = await mesa();
    const itens = [{ id: 'x', name: 'X', priceCents: 5000 }];
    await store.adjustCheck(checkId, (await store.loadEvents(checkId)).length, 5000, itens);
    itens[0].priceCents = 1;
    expect((await store.getCheckByQrToken(table.qrToken)).check.items[0].priceCents).toBe(5000);
  });
});
