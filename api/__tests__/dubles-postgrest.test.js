'use strict';

/**
 * O DUBLÊ TAMBÉM PRECISA DE TESTE.
 *
 * `test-helpers/postgrest-falso.js` é compartilhado por várias suítes que leem
 * DINHEIRO. Um dublê errado não quebra nada — ele faz todas elas dizerem sim na
 * mesma direção, de uma vez. Este arquivo mede as propriedades que os testes que
 * o usam estão confiando que ele tem.
 *
 * (Ele vive em `test-helpers/` e não em `__tests__/` porque o `testMatch` padrão
 * do jest colheria qualquer `.js` dali como suíte.)
 */

const { postgrestFalso, idasPorTabela, paginaObservada } = require('../../test-helpers/postgrest-falso');

const linhas = [
  { id: 'a', n: 3, grupo: 'x' },
  { id: 'b', n: 1, grupo: 'x' },
  { id: 'c', n: 2, grupo: 'y' },
];
const falso = (opts) => postgrestFalso({ t: linhas }, opts);

describe('os filtros filtram', () => {
  test('eq, neq, gte, lt e in', async () => {
    const { client } = falso();
    const q = () => client.from('t').select('id, n, grupo');
    expect((await q().eq('grupo', 'x')).data.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect((await q().neq('grupo', 'x')).data.map((r) => r.id)).toEqual(['c']);
    expect((await q().gte('n', 2)).data.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect((await q().lt('n', 2)).data.map((r) => r.id)).toEqual(['b']);
    expect((await q().in('id', ['a', 'c'])).data.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });
});

describe('a ordem tem DIREÇÃO', () => {
  test('asc e desc dão listas invertidas', async () => {
    const { client } = falso();
    const asc = (await client.from('t').select('id, n').order('n', { ascending: true })).data;
    const desc = (await client.from('t').select('id, n').order('n', { ascending: false })).data;
    expect(asc.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(desc.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  test('e `limit` corta DEPOIS de ordenar — é assim que "os mais recentes" funciona', async () => {
    const { client } = falso();
    const r = await client.from('t').select('id, n').order('n', { ascending: false }).limit(1);
    expect(r.data.map((x) => x.id)).toEqual(['a']);
  });
});

describe('o que ele não modela, ele RECUSA', () => {
  test('`.not()` lança em vez de virar no-op', () => {
    const { client } = falso();
    expect(() => client.from('t').select('id').not('grupo', 'in', '("x")')).toThrow(/não é modelado/);
  });
});

describe('a projeção erra como o servidor erra', () => {
  test('coluna que a tabela não tem vira 42703 — o SQLSTATE do inegociável #7', async () => {
    const { client } = falso();
    const r = await client.from('t').select('id, coluna_que_nao_existe');
    expect(r.data).toBeNull();
    expect(r.error).toMatchObject({ code: '42703' });
    expect(r.error.message).toMatch(/coluna_que_nao_existe/);
  });

  test('e devolve SÓ as colunas pedidas', async () => {
    const { client } = falso();
    const r = await client.from('t').select('id, n');
    expect(Object.keys(r.data[0]).sort()).toEqual(['id', 'n']);
  });

  test('um select com embutida passa a linha inteira — o dublê não monta junção', async () => {
    const { client } = postgrestFalso({ t: [{ id: 'a', n: 1, outra: { label: 'x' } }] });
    const r = await client.from('t').select('id, outra(label)');
    expect(r.data[0]).toHaveProperty('n');
  });
});

describe('`single()` não é `maybeSingle()`', () => {
  test('uma linha: devolve a linha', async () => {
    const { client } = falso();
    expect((await client.from('t').select('id').eq('id', 'a').single()).data).toEqual({ id: 'a' });
  });
  test('zero linhas: PGRST116 — é o erro de que o ramo de duplicata depende', async () => {
    const { client } = falso();
    const r = await client.from('t').select('id').eq('id', 'zzz').single();
    expect(r.error).toMatchObject({ code: 'PGRST116' });
  });
  test('muitas linhas: PGRST116 também', async () => {
    const { client } = falso();
    expect((await client.from('t').select('id').single()).error).toMatchObject({ code: 'PGRST116' });
  });
  test('`maybeSingle()` com zero linhas devolve null SEM erro', async () => {
    const { client } = falso();
    expect(await client.from('t').select('id').eq('id', 'zzz').maybeSingle()).toEqual({ data: null, error: null });
  });
});

describe('o corte do servidor e a paginação', () => {
  test('nunca devolve mais que `maxLinhas`, e o `range` fatia', async () => {
    const muitas = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, n: i }));
    const { client, idas } = postgrestFalso({ t: muitas }, { maxLinhas: 3 });
    const p1 = await client.from('t').select('id').order('id', { ascending: true }).range(0, 4);
    expect(p1.data).toHaveLength(3);          // o servidor corta em 3, não em 5
    const p2 = await client.from('t').select('id').order('id', { ascending: true }).range(3, 7);
    expect(p2.data.map((r) => r.id)).toEqual(['i3', 'i4', 'i5']);
    expect(paginaObservada(idas)).toBe(5);
    expect(idasPorTabela(idas)).toEqual({ t: 2 });
  });

  test('o EMPATE é sorteado — é o que faz uma ordem não-total falhar', async () => {
    const empatadas = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, n: 0 }));
    const { client } = postgrestFalso({ t: empatadas });
    const a = (await client.from('t').select('id').order('n', { ascending: true })).data.map((r) => r.id);
    const b = (await client.from('t').select('id').order('n', { ascending: true })).data.map((r) => r.id);
    // Trinta linhas empatadas: duas leituras darem a MESMA ordem é improvável
    // ao ponto de ser prova de que o desempate não está sorteando.
    expect(a).not.toEqual(b);
  });
});
