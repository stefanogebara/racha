'use strict';

/**
 * AS IDAS AO BANCO NÃO CRESCEM COM O TAMANHO DA CASA.
 *
 * `mesas-por-lote.test.js` fechou UM laço de leitura-por-linha (`listTables`) e
 * declarou o assunto resolvido. Sobravam quatro, nos caminhos mais caros que
 * existem: o painel do dono (recarrega a cada 4 s), a rota PÚBLICA do QR (todo
 * cliente que senta), e os dois lados da conciliação diária — que é a
 * inegociável #8 e roda sobre a casa inteira.
 *
 * É o conserto pontual que pega um sítio de dois, terceira vez nesta casa.
 * Então aqui o teste não pergunta "o `getPanelView` usa lote?": ele RODA cada
 * método com uma casa pequena e uma casa grande e compara a CONTAGEM de idas.
 * Um método novo que nasça com laço passa despercebido por este arquivo — mas
 * nenhum dos quatro consertados pode voltar atrás sem ficar vermelho.
 *
 * LIMITE DECLARADO: mede-se a contagem de idas de UM método. O prazo de cada
 * ida é o outro arquivo (`prazo-do-banco.test.js`), e nenhum dos dois mede
 * quantos MÉTODOS uma rota encadeia.
 */

const { createSupabaseStore } = require('../_lib/store/supabase');

const uuid = (n) => `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;

/**
 * Um PostgREST falso que honra `in`, `eq`, `order` e `range`.
 *
 * ORDENAR DE VERDADE, E DESEMPATAR AO ACASO, é o que faz este falso valer
 * alguma coisa. A primeira versão tinha `order() { return b; }` — um no-op — e
 * a revisão de compliance mostrou o buraco: trocar a ordem do `lerPorLote` por
 * uma NÃO-TOTAL (só `check_id`, sem o `seq`) deixava todos os testes verdes,
 * enquanto em produção duas páginas repetiriam e omitiriam a mesma linha de um
 * razão de dinheiro. Um teste que não pode falhar sobre o mutante não está
 * vigiando nada (compliance MEDIUM-2 de 2026-09-16).
 *
 * O Postgres não promete ordem nenhuma entre linhas EMPATADAS, e não promete a
 * MESMA ordem em duas consultas. Então o desempate aqui é aleatório e sorteado
 * a cada ida: com ordem total não há empate e o resultado é determinístico; sem
 * ela, a paginação perde e duplica linha, que é exatamente o que acontece lá.
 */
function clienteContador(tabelas, { maxLinhas = 1000 } = {}) {
  const idas = [];
  const from = (tabela) => {
    const f = { tabela, eq: {}, in: null, de: 0, ate: Infinity, ordem: [] };
    const b = {
      select() { return b; }, limit() { return b; },
      neq() { return b; }, gte() { return b; }, not() { return b; },
      order(col) { f.ordem.push(col); return b; },
      eq(col, val) { f.eq[col] = val; return b; },
      in(col, vals) { f.in = { col, vals: new Set(vals) }; return b; },
      range(de, ate) { f.de = de; f.ate = ate; return b; },
      maybeSingle() { return resolver().then((r) => ({ data: r.data[0] ?? null, error: null })); },
      single() { return b.maybeSingle(); },
      then(ok, falha) { return resolver().then(ok, falha); },
    };
    function resolver() {
      idas.push(f);
      const linhas = (tabelas[tabela] || []).filter((r) => {
        for (const [c, v] of Object.entries(f.eq)) if (r[c] !== v) return false;
        if (f.in && !f.in.vals.has(r[f.in.col])) return false;
        return true;
      }).map((r) => ({ r, sorte: Math.random() }));
      linhas.sort((x, y) => {
        for (const col of f.ordem) {
          const a = x.r[col], c = y.r[col];
          if (a < c) return -1;
          if (a > c) return 1;
        }
        return x.sorte - y.sorte;   // EMPATE: o banco não promete nada
      });
      // O CORTE DO SERVIDOR: o PostgREST devolve no máximo `db-max-rows` linhas
      // e não avisa. É ele que torna a paginação obrigatória, e é ele que este
      // falso precisa imitar pra que o teste signifique alguma coisa.
      const fatia = linhas.slice(f.de, Math.min(f.de + maxLinhas, f.ate + 1)).map((x) => x.r);
      return Promise.resolve({ data: fatia, error: null });
    }
    return b;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, idas };
}

/** O tamanho de página que o store pediu, lido da PRIMEIRA ida que usou `range`. */
function paginaObservada(idas) {
  const comRange = idas.find((i) => i.ate !== Infinity);
  return comRange ? comRange.ate - comRange.de + 1 : null;
}

/** Embaralha — a ordem do fixture não pode ser o que faz o teste passar. */
function embaralhar(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const conta = (n, venueId = 'v1') => ({ id: uuid(n), venue_id: venueId, table_id: 't1', status: 'aberta', opened_at: '2026-01-01T00:00:00Z', pos_ref: '[]' });
const evento = (n, seq, type = 'OPENED') => ({ check_id: uuid(n), seq, type, payload: {}, created_at: '2026-01-01T00:00:00Z' });
const pagamento = (n, txid) => ({
  check_id: uuid(n), txid, amount_cents: 100, tip_cents: 0,
  confirmed_amount_cents: 100, confirmed_tip_cents: 0,
  refunded_amount_cents: 0, refunded_tip_cents: 0,
  status: 'confirmado', method: 'pix', currency: 'BRL', confirmed_at: '2026-01-01T00:00:00Z',
});

/** Monta uma casa com N contas, cada uma com 3 eventos e 1 pagamento. */
function casa(n) {
  const checks = [], check_events = [], payments = [];
  for (let i = 0; i < n; i++) {
    checks.push(conta(i));
    for (let s = 1; s <= 3; s++) check_events.push(evento(i, s));
    payments.push(pagamento(i, `tx_${i}`));
  }
  return {
    venues: [{ id: 'v1', name: 'Casa', market: 'BR' }],
    venue_tables: [{ id: 't1', venue_id: 'v1', label: 'Mesa 1', qr_token: 'qr1', active: true, training: false, venues: { name: 'Casa', market: 'BR' } }],
    checks, check_events, payments,
  };
}

/** Quantas idas cada método faz a cada tabela, pra uma casa de N contas. */
async function idasDe(metodo, n) {
  const { client, idas } = clienteContador(casa(n));
  const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
  await metodo(store);
  const porTabela = {};
  for (const i of idas) porTabela[i.tabela] = (porTabela[i.tabela] || 0) + 1;
  return porTabela;
}

describe('a contagem de idas não acompanha o tamanho da casa', () => {
  const casos = [
    ['getPanelView', (s) => s.getPanelView('v1')],
    ['listChecksForReconcile', (s) => s.listChecksForReconcile('v1')],
  ];
  test.each(casos)('%s: 1 conta e 60 contas fazem as MESMAS idas', async (_nome, metodo) => {
    const pequena = await idasDe(metodo, 1);
    const grande = await idasDe(metodo, 60);
    expect(grande).toEqual(pequena);
    // E o razão foi lido de fato — um método que parasse de ler passaria no
    // `toEqual` acima com zero idas dos dois lados.
    expect(pequena.check_events).toBeGreaterThanOrEqual(1);
  });

  test('a rota PÚBLICA do QR lê as candidatas num salto só', async () => {
    const dados = casa(10);
    for (const c of dados.checks) c.table_id = 't1';
    const { client, idas } = clienteContador(dados);
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    await store.getCheckByQrToken('qr1');
    expect(idas.filter((i) => i.tabela === 'check_events')).toHaveLength(1);
  });

  test('as contas da casa (house) leem lotes e razão em lote', async () => {
    const dados = {
      house_accounts: Array.from({ length: 40 }, (_, i) => ({ id: uuid(i), venue_id: 'v1', principal_cents: 100 })),
      house_bonus_lots: Array.from({ length: 40 }, (_, i) => ({ account_id: uuid(i), event_seq: 1, remaining_cents: 10, expires_at: null })),
      house_account_events: Array.from({ length: 40 }, (_, i) => ({ account_id: uuid(i), seq: 1, type: 'CREDITED', payload: {} })),
    };
    const { client, idas } = clienteContador(dados);
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const out = await store.listHouseAccountsForReconcile('v1');
    expect(out).toHaveLength(40);
    expect(out[0].events).toHaveLength(1);
    expect(out[0].stored.lots).toHaveLength(1);
    expect(idas.filter((i) => i.tabela === 'house_bonus_lots')).toHaveLength(1);
    expect(idas.filter((i) => i.tabela === 'house_account_events')).toHaveLength(1);
  });
});

describe('o lote não perde nem troca linha', () => {
  test('cada conta recebe o SEU razão — 300 contas, nada vaza de uma pra outra', async () => {
    const dados = casa(300);
    // Marca cada evento com a conta dele pra poder conferir o agrupamento.
    for (const e of dados.check_events) e.payload = { dono: e.check_id };
    const { client } = clienteContador(dados);
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const linhas = await store.listChecksForReconcile('v1');
    expect(linhas).toHaveLength(300);
    for (const l of linhas) {
      expect(l.events).toHaveLength(3);
      for (const e of l.events) expect(e.payload.dono).toBe(l.checkId);
      expect(l.payments.map((p) => p.txid)).toEqual([`tx_${Number(l.checkId.slice(0, 8))}`]);
    }
  });

  /**
   * A LINHA QUE NÃO PODE SUMIR.
   *
   * O PostgREST corta a resposta em `db-max-rows` e devolve 200. Um lote de
   * 200 contas com 20 eventos cada são 4000 linhas: sem paginar, chegariam as
   * primeiras 1000 com cara de razão completo, e o redutor veria contas SEM o
   * pagamento que elas receberam. Não é erro de leitura, é erro de dinheiro.
   *
   * Aqui o falso corta em 1000 como o servidor corta, e o teste exige as 4000.
   */
  test('o corte do servidor não some com evento nenhum', async () => {
    const checks = [], check_events = [];
    for (let i = 0; i < 200; i++) {
      checks.push(conta(i));
      for (let s = 1; s <= 20; s++) check_events.push(evento(i, s));
    }
    expect(check_events).toHaveLength(4000);
    const { client, idas } = clienteContador({ checks, check_events: embaralhar([...check_events]), payments: [] }, { maxLinhas: 1000 });
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const linhas = await store.listChecksForReconcile('v1');
    const total = linhas.reduce((a, l) => a + l.events.length, 0);
    expect(total).toBe(4000);
    // Cada conta com os seus vinte eventos, EM ORDEM — é isto que morre quando
    // a ordem do `lerPorLote` deixa de ser total, e o fixture vem embaralhado
    // pra que não seja ele a produzir a ordem certa.
    for (const l of linhas) expect(l.events.map((e) => e.seq)).toEqual([...Array(20)].map((_, i) => i + 1));
    // E nenhuma linha repetida entre páginas: a soma bater com duplicatas
    // exigiria omissões na mesma medida, então as duas conferências juntas é
    // que fecham.
    const chaves = linhas.flatMap((l) => l.events.map((e) => `${l.checkId}#${e.seq}`));
    expect(new Set(chaves).size).toBe(4000);
    const pagina = paginaObservada(idas);
    const idasDoRazao = idas.filter((i) => i.tabela === 'check_events').length;
    // As páginas cheias mais a curta que encerra o laço — derivado do tamanho
    // que o store pediu, e não de um número escrito aqui que envelhece junto.
    expect(idasDoRazao).toBe(Math.floor(4000 / pagina) + 1);
    expect(pagina).toBeLessThan(1000);   // a página tem que ser MENOR que o corte
  });

  /**
   * A CONSULTA QUE DIRIGE AS OUTRAS TAMBÉM É CORTADA.
   *
   * O primeiro conserto paginou os FILHOS (razão e pagamentos) e deixou os PAIS
   * — a lista de contas e a de contas-da-casa — com um `select` seco. O
   * docblock do `lerPorLote` descrevia o corte do servidor, o que fazia a
   * lacuna parecer coberta, e nenhum teste daqui a alcançava: plantar o bug de
   * volta deixava os sete casos verdes (compliance HIGH-2 de 2026-09-16).
   *
   * Acima do corte, a conciliação diária roda PARA SEMPRE sobre um subconjunto
   * arbitrário da história da casa e diz que bate. E pior que drift escondido:
   * `reconcileVenueHouse` monta `checkLedgerTxids` desta lista, então um
   * resgate cujo razão ficou de fora vira um achado `critical` mandando
   * RE-CREDITAR a conta — o cliente fica com a refeição e com o saldo.
   */
  test('a lista de CONTAS passa do corte do servidor sem perder nenhuma', async () => {
    const dados = casa(1200);
    const { client } = clienteContador(dados, { maxLinhas: 1000 });
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const linhas = await store.listChecksForReconcile('v1');
    expect(linhas).toHaveLength(1200);
    expect(new Set(linhas.map((l) => l.checkId)).size).toBe(1200);
    expect(linhas.every((l) => l.events.length === 3)).toBe(true);
  });

  test('a lista de CONTAS DA CASA também — e aqui o teto é alcançável por desenho', async () => {
    // `MAX_ACCOUNTS_PER_VENUE` é 5000: cinco vezes o corte do PostgREST.
    const n = 1200;
    const dados = {
      house_accounts: Array.from({ length: n }, (_, i) => ({ id: uuid(i), venue_id: 'v1', principal_cents: 100 })),
      house_bonus_lots: [],
      house_account_events: Array.from({ length: n }, (_, i) => ({ account_id: uuid(i), seq: 1, type: 'CREDITED', payload: {} })),
    };
    const { client } = clienteContador(dados, { maxLinhas: 1000 });
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const out = await store.listHouseAccountsForReconcile('v1');
    expect(out).toHaveLength(n);
    expect(out.every((c) => c.events.length === 1)).toBe(true);
  });

  test('mais de 200 ids viram vários lotes — e nenhuma conta fica pra trás', async () => {
    const { client, idas } = clienteContador(casa(450));
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const linhas = await store.listChecksForReconcile('v1');
    expect(linhas).toHaveLength(450);
    expect(linhas.every((l) => l.events.length === 3)).toBe(true);
    // 450 ids ÷ 200 = 3 lotes. Cada lote traz 3 eventos por conta (600 no maior
    // lote), que é mais que uma página de 500: dois lotes precisam de 2 idas.
    const pagina = paginaObservada(idas);
    const idasDoRazao = idas.filter((i) => i.tabela === 'check_events').length;
    const esperadas = [200, 200, 50].reduce((a, n) => a + Math.floor((n * 3) / pagina) + 1, 0);
    expect(idasDoRazao).toBe(esperadas);
    // Pagamentos: um por conta, então nenhum lote enche uma página.
    expect(idas.filter((i) => i.tabela === 'payments').length).toBe(3);
  });
});
