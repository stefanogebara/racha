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

describe('supabase: o mesmo, pelo dublê de PostgREST', () => {
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
