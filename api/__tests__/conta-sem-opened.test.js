'use strict';

/**
 * UMA CONTA SEM `OPENED` AINDA NÃO ESTÁ ABERTA — e a leitura não pode lançar.
 *
 * `openCheck` grava a linha em `checks` e, noutra ida ao banco, o `OPENED`.
 * Entre as duas, a conta existe e o razão dela está vazio: `reduce([])` devolve
 * `null` por construção, e `getCheckByQrToken` fazia `state.status` direto.
 * `TypeError` → 500 em `/api/check`.
 *
 * A revisão de segurança mediu isso num Postgres de verdade: com 600 ms entre
 * as duas escritas e 30 leitores, QUINZE levaram 500. E a renovação da demo
 * paga passa por essa janela em TODA renovação, porque ela abre a conta nova com
 * vários telefones sondando. Numa casa de verdade, é o garçom abrindo a conta
 * com alguém já olhando o QR.
 *
 * Isto é o paliativo, não o conserto. Se o processo morre entre as duas
 * escritas, a linha fica pra sempre sem `OPENED` e a mesa não abre mais conta
 * (o índice de uma aberta por mesa responde 409). O conserto é uma RPC que
 * insere e grava o `OPENED` na mesma transação — inegociável #7 — e está no
 * livro de abertos com PR próprio. O que isto garante é que a LEITURA diga a
 * verdade: não há conta aberta ainda.
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { createSupabaseStore } = require('../_lib/store/supabase');

describe('memória: a conta que ficou pela metade não derruba a leitura', () => {
  test('o OPENED falhou depois de a linha entrar → a leitura diz "não há conta", sem lançar', async () => {
    const store = createMemoryStore();
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000 });
    const table = store.seedTable(venue.id, 'Mesa 3');
    // A FALHA DE VERDADE, reproduzida: a linha entra, o `OPENED` não.
    const original = store.appendEvent.bind(store);
    store.appendEvent = async (id, type, ...resto) => {
      if (type === 'OPENED') throw new Error('timeout na segunda ida');
      return original(id, type, ...resto);
    };
    await expect(store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 1000 }])).rejects.toThrow('timeout');
    store.appendEvent = original;

    await expect(store.getCheckByQrToken(table.qrToken)).resolves.toBeNull();
  });
});

// Um PostgREST falso mínimo, na forma do `idas-por-lote.test.js`: honra
// `eq`/`neq`/`in` e devolve linhas. Só o que o `getCheckByQrToken` lê.
function cliente(tabelas) {
  const from = (tabela) => {
    const f = { eq: {}, neq: {}, in: null };
    const b = {
      select() { return b; }, limit() { return b; }, order() { return b; }, range() { return b; },
      eq(c, v) { f.eq[c] = v; return b; },
      neq(c, v) { f.neq[c] = v; return b; },
      in(c, vs) { f.in = { c, vs: new Set(vs) }; return b; },
      gte() { return b; }, not() { return b; },
      maybeSingle() { return exec().then((r) => ({ data: r.data[0] ?? null, error: null })); },
      single() { return b.maybeSingle(); },
      then(ok, falha) { return exec().then(ok, falha); },
    };
    function exec() {
      const linhas = (tabelas[tabela] || []).filter((r) => {
        for (const [c, v] of Object.entries(f.eq)) if (r[c] !== v) return false;
        for (const [c, v] of Object.entries(f.neq)) if (r[c] === v) return false;
        if (f.in && !f.in.vs.has(r[f.in.c])) return false;
        return true;
      });
      return Promise.resolve({ data: linhas, error: null });
    }
    return b;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}


describe('supabase: o mesmo, pelo dublê de PostgREST', () => {
  test('linha em `checks` com status aberta e ZERO eventos → null, sem lançar', async () => {
    const tabelas = {
      venue_tables: [{ id: 't1', venue_id: 'v1', label: 'Mesa 3', qr_token: 'qr1', active: true, training: false,
        venues: { id: 'v1', name: 'Casa', market: 'BR', cnpj: null, servico_basis_points: 1000 } }],
      checks: [{ id: '00000000-3333-4333-8333-333333333333', venue_id: 'v1', table_id: 't1', status: 'aberta', opened_at: '2026-01-01T00:00:00Z', pos_ref: '[]' }],
      check_events: [],
      payments: [],
    };
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: cliente(tabelas) });
    await expect(store.getCheckByQrToken('qr1')).resolves.toBeNull();
  });
});

/**
 * PULAR NÃO É CALAR — a quarta rodada das duas revisões.
 *
 * O paliativo acima trocou o 500 por um 404 idêntico a "o garçom ainda não
 * abriu", sem log, e a conciliação dizia `ok`. A mesa órfã ficava trancada
 * (o índice de uma aberta por mesa) e ninguém sabia. O painel do dono, que lia
 * o mesmo razão vazio, seguia em 500 a cada recarga. E o store de memória
 * deixava abrir outra conta por cima, então "mesa trancada" era verde aqui e
 * falso em produção.
 *
 * Cada teste abaixo prende uma dessas quatro portas.
 */
const { reconcileVenue } = require('../_lib/checks/reconcile');
const { JANELA_DE_ABERTURA_MS } = require('../_lib/checks/conta-sem-opened');

// A órfã agora só nasce SEMEADA: desde a 0037 o `openCheck` é uma transação só
// (e o dublê desfaz a linha se o `OPENED` falhar). As defesas abaixo seguem
// valendo pras linhas antigas, de antes da 0037.
async function mesaComOrfa() {
  const store = createMemoryStore();
  const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000 });
  const table = store.seedTable(venue.id, 'Mesa 3');
  store.seedContaSemOpened(table.qrToken);
  const [orfa] = await store.listChecksForReconcile(venue.id);
  return { store, venue, table, orfa, criadaMs: Date.parse(orfa.openedAt) };
}

function ouvirStderr() {
  const linhas = [];
  const espiao = jest.spyOn(process.stderr, 'write').mockImplementation((s) => { linhas.push(String(s)); return true; });
  return { alarmes: () => linhas.filter((l) => l.startsWith('[conta-sem-opened]')), soltar: () => espiao.mockRestore() };
}

describe('a conta órfã grita, em todo leitor que a pula', () => {
  afterEach(() => jest.restoreAllMocks());

  test('leitura pública: dentro da janela, calada; passada a janela, a linha de alarme — com o id e a idade', async () => {
    const { store, table, orfa, criadaMs } = await mesaComOrfa();
    const ouvido = ouvirStderr();
    jest.spyOn(Date, 'now').mockReturnValue(criadaMs + 5_000);
    await expect(store.getCheckByQrToken(table.qrToken)).resolves.toBeNull();
    expect(ouvido.alarmes()).toEqual([]); // o garçom abrindo agora não é alarme

    Date.now.mockReturnValue(criadaMs + JANELA_DE_ABERTURA_MS + 60_000);
    await expect(store.getCheckByQrToken(table.qrToken)).resolves.toBeNull();
    expect(ouvido.alarmes()).toEqual([`[conta-sem-opened] check=${orfa.checkId} idade=90s em=getCheckByQrToken\n`]);
  });

  test('o painel do dono não cai — pula a órfã, mostra o resto, e grita', async () => {
    const { store, venue, orfa, criadaMs } = await mesaComOrfa();
    const outra = store.seedTable(venue.id, 'Mesa 4');
    await store.openCheck(outra.qrToken, [{ id: 'j', name: 'Y', priceCents: 500 }]);
    const ouvido = ouvirStderr();
    const view = await store.getPanelView(venue.id, new Date(criadaMs + 120_000).toISOString());
    expect(view.checks.map((c) => c.tableLabel)).toEqual(['Mesa 4']);
    expect(ouvido.alarmes()).toEqual([`[conta-sem-opened] check=${orfa.checkId} idade=120s em=getPanelView\n`]);
  });

  test('a mesa fica TRANCADA, como no Postgres: 409 ao abrir, "tem conta aberta" na lista e ao desativar', async () => {
    const { store, venue, table } = await mesaComOrfa();
    await expect(store.openCheck(table.qrToken, [{ id: 'k', name: 'Z', priceCents: 100 }]))
      .rejects.toMatchObject({ statusCode: 409 });
    const [linha] = await store.listTables(venue.id);
    expect(linha.hasOpenCheck).toBe(true);
    await expect(store.setTableActive(linha.id, false)).rejects.toThrow('open check');
  });

  test('a conciliação: órfã velha é CRITICAL (pagina); a que está abrindo agora não é achado', async () => {
    const { store, venue, orfa, criadaMs } = await mesaComOrfa();
    const velha = await reconcileVenue(store, venue.id, { nowMs: criadaMs + 10 * 60_000 });
    // `worstSeverity` é o que o canário diário lê pra pintar a casa de
    // vermelho e acordar o fundador; `failed` é a lista que vai no alerta.
    expect(velha.worstSeverity).toBe('critical');
    const [falhou] = velha.failed;
    expect(falhou.checkId).toBe(orfa.checkId);
    expect(falhou.findings.find((f) => f.code === 'check_without_opened'))
      .toMatchObject({ severity: 'critical', ageSeconds: 600 });
    // O alerta do fundador imprime só a frase: ela tem de dizer QUAL conta.
    expect(falhou.findings.find((f) => f.code === 'check_without_opened').message)
      .toContain(orfa.checkId);

    const nova = await reconcileVenue(store, venue.id, { nowMs: criadaMs + 1_000 });
    expect(nova.failed).toEqual([]);
    expect(nova.worstSeverity).not.toBe('critical');
  });
});

describe('supabase: a leitura pública grita também', () => {
  afterEach(() => jest.restoreAllMocks());

  test('órfã de ontem → null E a linha de alarme', async () => {
    const ontem = '2026-01-01T00:00:00Z';
    const tabelas = {
      venue_tables: [{ id: 't1', venue_id: 'v1', label: 'Mesa 3', qr_token: 'qr1', active: true, training: false,
        venues: { id: 'v1', name: 'Casa', market: 'BR', cnpj: null, servico_basis_points: 1000 } }],
      checks: [{ id: 'c-orfa', venue_id: 'v1', table_id: 't1', status: 'aberta', opened_at: ontem, pos_ref: '[]' }],
      check_events: [],
      payments: [],
    };
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: cliente(tabelas) });
    const ouvido = ouvirStderr();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(ontem) + 86_400_000);
    await expect(store.getCheckByQrToken('qr1')).resolves.toBeNull();
    expect(ouvido.alarmes()).toEqual(['[conta-sem-opened] check=c-orfa idade=86400s em=getCheckByQrToken\n']);
  });
});

/**
 * O PAINEL NO STORE DE PRODUÇÃO — a lacuna que a quinta rodada de segurança
 * achou. O conserto do painel estava coberto só no store de memória; tirar o
 * `continue` do `getPanelView` do Supabase deixava a suíte inteira verde e, num
 * Postgres de verdade, o painel da casa de volta em 500 a cada 4 s. Verde na
 * memória, errado em produção — a forma que o `store-shape` existe pra pegar.
 */
describe('supabase: o painel do dono pula a órfã, mostra a viva e grita', () => {
  afterEach(() => jest.restoreAllMocks());

  // Ids em forma de UUID: o `loadEventsPorLote` descarta o que não é, e a
  // conta viva sumiria do painel por isso, não pelo conserto.
  test('uma órfã de ontem e uma conta viva → o painel não lança, lista só a viva, e escreve o alarme', async () => {
    const ontem = '2026-01-01T00:00:00Z';
    const agora = '2026-01-02T00:00:00Z';
    const tabelas = {
      venue_tables: [
        { id: 't1', venue_id: 'v1', label: 'Mesa 3', qr_token: 'qr1', active: true },
        { id: 't2', venue_id: 'v1', label: 'Mesa 4', qr_token: 'qr2', active: true },
      ],
      venues: [{ id: 'v1', name: 'Casa' }],
      checks: [
        { id: '00000000-4444-4444-8444-000000000001', venue_id: 'v1', table_id: 't1', status: 'aberta', opened_at: ontem, pos_ref: '[]', venue_tables: { label: 'Mesa 3' } },
        { id: '00000000-4444-4444-8444-000000000002', venue_id: 'v1', table_id: 't2', status: 'aberta', opened_at: agora, pos_ref: '[]', venue_tables: { label: 'Mesa 4' } },
      ],
      check_events: [{ check_id: '00000000-4444-4444-8444-000000000002', seq: 1, type: 'OPENED', payload: { totalCents: 500 }, created_at: agora }],
      payments: [],
    };
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: cliente(tabelas) });
    const ouvido = ouvirStderr();
    const view = await store.getPanelView('v1', agora);
    expect(view.checks.map((c) => c.tableLabel)).toEqual(['Mesa 4']);
    expect(ouvido.alarmes()).toEqual(['[conta-sem-opened] check=00000000-4444-4444-8444-000000000001 idade=86400s em=getPanelView\n']);
  });
});

describe('a idade ilegível é órfã — na dúvida, alarme', () => {
  const { idadeSemOpened } = require('../_lib/checks/conta-sem-opened');
  test('sem data, data lixo, ou sem relógio → órfã', () => {
    expect(idadeSemOpened(undefined, Date.now())).toEqual({ idadeMs: null, orfa: true });
    expect(idadeSemOpened('não é data', Date.now())).toEqual({ idadeMs: null, orfa: true });
    expect(idadeSemOpened('2026-01-01T00:00:00Z', undefined)).toEqual({ idadeMs: null, orfa: true });
  });
});

describe('o reparo à mão apaga o alarme — a quinta rodada de segurança, M-B', () => {
  const { reconcileCheck } = require('../_lib/checks/reconcile');
  const base = { checkId: 'c', events: [], payments: [], openedAt: '2026-01-01T00:00:00Z', nowMs: Date.parse('2026-01-03T00:00:00Z') };

  test('órfã velha com a linha ainda aberta → critical: a mesa está trancada', () => {
    const r = reconcileCheck({ ...base, statusDaLinha: 'aberta' });
    expect(r.findings.map((f) => [f.severity, f.code])).toEqual([['critical', 'check_without_opened']]);
  });

  test('a mesma órfã depois de `status = fechada` à mão → só registro, e a conta sai ok', () => {
    const r = reconcileCheck({ ...base, statusDaLinha: 'fechada' });
    expect(r.findings.map((f) => [f.severity, f.code])).toEqual([['info', 'check_closed_without_opened']]);
    expect(r.ok).toBe(true);
  });
});


describe('ABRIR É UMA TRANSAÇÃO SÓ (migração 0037) — a órfã deixa de nascer', () => {
  test('memória: o OPENED falhou → a linha sai junto, e a mesa abre conta de novo', async () => {
    const store = createMemoryStore();
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000 });
    const table = store.seedTable(venue.id, 'Mesa 3');
    const original = store.appendEvent.bind(store);
    store.appendEvent = async (id, type, ...resto) => {
      if (type === 'OPENED') throw new Error('timeout na segunda ida');
      return original(id, type, ...resto);
    };
    await expect(store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 1000 }])).rejects.toThrow('timeout');
    store.appendEvent = original;
    expect(await store.listChecksForReconcile(venue.id)).toEqual([]);   // nada órfão ficou
    await expect(store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 1000 }])).resolves.toMatchObject({ tableId: table.id });
  });

  function clienteComRpc(rpc) {
    const b = {
      select() { return b; }, eq() { return b; },
      maybeSingle: async () => ({ data: { id: 't1', venue_id: 'v1' }, error: null }),
    };
    return { from: () => b, rpc };
  }

  test('supabase: UMA chamada a `open_check`, com a linha e o total — e nenhum insert solto', async () => {
    const chamadas = [];
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: clienteComRpc(async (nome, args) => {
      chamadas.push([nome, args]); return { data: '00000000-6666-4666-8666-000000000001', error: null };
    }) });
    const c = await store.openCheck('qr1', [{ id: 'a', name: 'X', priceCents: 700 }, { id: 'b', name: 'Y', priceCents: 300 }]);
    expect(c).toMatchObject({ id: '00000000-6666-4666-8666-000000000001', venueId: 'v1', tableId: 't1' });
    expect(chamadas).toEqual([['open_check', {
      p_table_id: 't1', p_total_cents: 1000,
      p_pos_ref: JSON.stringify([{ id: 'a', name: 'X', priceCents: 700 }, { id: 'b', name: 'Y', priceCents: 300 }]),
    }]]);
  });

  test('supabase: 23505 (mesa já aberta) vira 409 pelo CÓDIGO; outro erro sobe como erro', async () => {
    const com = (error) => createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: clienteComRpc(async () => ({ data: null, error })) });
    await expect(com({ code: '23505', message: 'duplicate key value violates unique constraint "checks_one_open_per_table"' }).openCheck('qr1', [{ id: 'a', name: 'X', priceCents: 1 }]))
      .rejects.toMatchObject({ statusCode: 409 });
    // A MESMA frase com outro código NÃO é mesa aberta — a regex antiga dizia que era.
    const outro = com({ code: '57014', message: 'duplicate key … canceling statement due to statement timeout' });
    await expect(outro.openCheck('qr1', [{ id: 'a', name: 'X', priceCents: 1 }])).rejects.not.toMatchObject({ statusCode: 409 });
  });
});


describe('o contrato da 0037 com o store — o que o dublê não prova', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '0037_open_check.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  const STORE = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'supabase.js'), 'utf8');

  test('o corpo de `open_check` tem o INSERT e o OPENED — a atomicidade é isso (segurança, PR #21, M-2)', () => {
    const corpo = SQL.slice(SQL.indexOf('create or replace function public.open_check('));
    expect(corpo).toMatch(/insert into checks/);
    expect(corpo).toMatch(/perform public\.append_check_event\(v_id, 'OPENED'/);
    expect(corpo).toMatch(/security definer[\s\S]*set search_path = public/);
    expect(corpo).toMatch(/p_total_cents <= 0/);
  });

  test('os parâmetros que o store manda são os que a função declara', () => {
    const decl = SQL.match(/create or replace function public\.open_check\(([\s\S]*?)\)\s*returns/)[1];
    const sql = [...decl.matchAll(/(p_\w+)\s+\w+/g)].map((m) => m[1]).sort();
    const chamada = STORE.slice(STORE.indexOf("client.rpc('open_check', {"));
    const enviados = [...chamada.slice(0, chamada.indexOf('});')).matchAll(/(p_\w+):/g)].map((m) => m[1]).sort();
    expect(enviados).toEqual(sql);
  });

  test('`open_check` sem id na volta é erro, não um 200 com `checkId: null` (segurança, PR #21, LOW-2)', async () => {
    const b = { select() { return b; }, eq() { return b; }, maybeSingle: async () => ({ data: { id: 't1', venue_id: 'v1' }, error: null }) };
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: { from: () => b, rpc: async () => ({ data: null, error: null }) } });
    await expect(store.openCheck('qr1', [{ id: 'a', name: 'X', priceCents: 1 }])).rejects.toThrow(/não devolveu o id/);
  });
});
