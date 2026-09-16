'use strict';

/**
 * O FUNIL DE ADOÇÃO — o primeiro degrau, que não era medido.
 *
 * O portão do CLAUDE.md governa o roteiro: as casas-piloto precisam mostrar
 * ≥25% das contas migrando na semana 8, ou o produto para. Sete semanas depois
 * da primeira casa, o banco sabia dizer quantas contas o RESTAURANTE digitou e
 * quantas foram pagas — e nada sobre quantas pessoas viram a tela.
 *
 * Com isso, dois mundos opostos davam o mesmo relatório: "40 escanearam e 1
 * pagou" (problema de produto) e "ninguém escaneou" (problema de distribuição).
 * Eles pedem correções opostas, e um portão que não os distingue não é um
 * portão.
 *
 * A telemetria que existia media vendas: `sendBeacon` só dispara com `?pl=` na
 * URL, o token de prospecção da Olímpia.
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { createSupabaseStore } = require('../_lib/store/supabase');
const { postgrestFalso } = require('../../test-helpers/postgrest-falso');

async function casaComMesa() {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Beira Mar', servicoBp: 900, pspRecipientId: 're_x' });
  const table = await store.seedTable(venue.id, 'Mesa 13');
  return { store, venue, table };
}

describe('quem ABRIU a conta na mesa', () => {
  test('conta uma vez por telefone, não uma vez por consulta', async () => {
    // O app consulta a conta a cada 4 segundos. Contar leitura seria contar
    // polling em vez de gente.
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    const abrir = (sessao) => store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: sessao,
    });
    expect(await abrir('telefone-a')).toBe(true);
    expect(await abrir('telefone-a')).toBe(false);   // mesma aba, de novo
    expect(await abrir('telefone-b')).toBe(true);    // outra pessoa na mesa

    const f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.contasAbertasNaMesa).toBe(1);           // uma CONTA, dois telefones
  });

  test('o funil separa "ninguém viu" de "viram e não pagaram"', async () => {
    const { store, venue, table } = await casaComMesa();

    // Conta A: o restaurante digitou o total e ninguém abriu no telefone.
    await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    let f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.contasCriadas).toBe(1);
    expect(f.contasAbertasNaMesa).toBe(0);
    // Sem denominador não há taxa — e inventar 0% aqui diria "o produto perde
    // gente" quando o que houve foi ninguém chegar nele.
    expect(f.conversao).toBeNull();
  });

  test('viram e NÃO pagaram: aí sim é 0%, e isso é sobre o produto', async () => {
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    await store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: 'telefone-a',
    });
    const f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.contasAbertasNaMesa).toBe(1);
    expect(f.contasPagas).toBe(0);
    expect(f.conversao).toBe(0);
  });

  test('viram e pagaram: a conversão que o portão pede', async () => {
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    await store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: 'telefone-a',
    });
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 5000, tipCents: 0, method: 'pix',
    });
    await store.recordPayment({ txid: 'ch_1', status: 'confirmado', confirmedAt: new Date().toISOString() });
    const f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.conversao).toBe(1);
  });

  test('a janela é respeitada — o portão é da semana, não da vida da casa', async () => {
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    await store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: 'telefone-a',
    });
    const daquiUmMes = new Date(Date.now() + 30 * 86400000).toISOString();
    const f = await store.getAdoptionFunnel(venue.id, { sinceIso: daquiUmMes });
    expect(f.contasAbertasNaMesa).toBe(0);
  });
});

describe('a rota registra e nunca atrapalha quem paga', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const rota = src.slice(src.indexOf("url.pathname === '/api/check/opened'"), src.indexOf("url.pathname === '/api/demo/beacon'"));

  test('sempre 200 — telemetria não pode espelhar falha na tela de pagar', () => {
    expect(rota).toMatch(/json\(res, 200/);
    expect(rota).not.toMatch(/json\(res, [45]\d\d/);
  });

  test('tem limite de taxa: é rota pública e sem auth', () => {
    expect(rota).toMatch(/rateLimitDemo\(req\)/);
  });

  test('exige uma sessão com tamanho mínimo — sem ela não conta', () => {
    expect(rota).toMatch(/sessao\.length >= 8/);
  });

  test('e o cliente dispara pra mesa REAL, não só pra link de prospecção', () => {
    const app = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/'\/api\/check\/opened'/);
    // O de vendas continua existindo e continua dependendo do `pl` — são dois
    // instrumentos diferentes medindo coisas diferentes.
    expect(app).toMatch(/if \(!prospectPl\) return;/);
  });
});

/**
 * OS DOIS STORES CONTAM O MESMO — e é isto que faltava.
 *
 * Todo o resto deste arquivo roda contra o store de MEMÓRIA. O de produção
 * ficou sem nenhum teste, e quando a leitura virou paginada a conversão trocou
 * `views.data` por `views` e esqueceu as outras duas linhas: `contasCriadas` e
 * `contasPagas` passaram a ser ZERO pra sempre, sem erro nenhum. É deste número
 * que sai o portão de ≥25% na semana 8 — o que o CLAUDE.md diz que estaciona o
 * produto. Ninguém consome o funil por rota ainda; alguém vai, confiando nele.
 *
 * Achado pela segunda revisão de segurança de 2026-09-16 (NEW-2). O conserto de
 * CLASSE não é a linha: é este teste, que faz o store de produção responder à
 * mesma pergunta que o de memória.
 */
describe('o funil do store de PRODUÇÃO conta como o da memória', () => {
  const VENUE = 'v1';
  const conta = (n) => `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;
  const agora = new Date().toISOString();

  /** Três contas criadas, duas abertas na mesa por telefone, uma paga. */
  const dados = {
    check_views: [
      { check_id: conta(0), venue_id: VENUE, at: agora, session_hash: 'a' },
      { check_id: conta(0), venue_id: VENUE, at: agora, session_hash: 'b' },
      { check_id: conta(1), venue_id: VENUE, at: agora, session_hash: 'c' },
    ],
    checks: [0, 1, 2].map((i) => ({ id: conta(i), venue_id: VENUE, opened_at: agora })),
    payments: [
      { check_id: conta(0), txid: 'tx0', venue_id: VENUE, status: 'confirmado', confirmed_at: agora },
      { check_id: conta(0), txid: 'tx1', venue_id: VENUE, status: 'confirmado', confirmed_at: agora },
      { check_id: conta(2), txid: 'tx2', venue_id: VENUE, status: 'pendente', confirmed_at: null },
    ],
  };

  test('os três números, e a conversão', async () => {
    const { client } = postgrestFalso(dados);
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const f = await store.getAdoptionFunnel(VENUE, {});
    expect(f).toEqual({
      contasCriadas: 3,          // era 0: `checks.data` num array
      contasAbertasNaMesa: 2,    // duas contas vistas, três telefones
      contasPagas: 1,            // uma conta com pagamento confirmado (dois txids)
      conversao: 1 / 2,          // era 0: `pagos.data` num array
    });
  });

  /**
   * O NUMERADOR TEM QUE CABER NO DENOMINADOR.
   *
   * `recordCheckView` é telemetria de navegador, melhor esforço: bloqueada,
   * limitada por taxa ou simplesmente perdida, a conta entra em `pagas` e não em
   * `abertas`. Medindo os dois conjuntos INDEPENDENTES, a razão passava de 1 —
   * e é este número que o portão de adoção lê pra decidir se o produto continua
   * (CLAUDE.md, ≥25% na semana 8). Inflado, ele mantém vivo um piloto que
   * fracassou.
   *
   * Nenhum caso anterior pegava isso: em todos eles os pagamentos eram de contas
   * que também foram vistas, ou seja `pagas ⊆ abertas` por construção do
   * fixture. Achado pela terceira revisão de segurança de 2026-09-16 (M4).
   */
  test('uma conta PAGA que ninguém viu não infla a conversão', async () => {
    const soUmaVista = {
      ...dados,
      // A: vista, não paga.  B: paga, com o beacon perdido.
      check_views: [{ check_id: conta(0), venue_id: VENUE, at: agora, session_hash: 'a' }],
      payments: [{ check_id: conta(1), txid: 'tx9', venue_id: VENUE, status: 'confirmado', confirmed_at: agora }],
    };
    const { client } = postgrestFalso(soUmaVista);
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    const f = await store.getAdoptionFunnel(VENUE, {});
    expect(f.contasAbertasNaMesa).toBe(1);
    expect(f.contasPagas).toBe(1);
    // A verdade é ZERO: a única conta que alguém abriu na mesa não foi paga.
    // Sem a interseção, isto era 1.0 — 100% de conversão.
    expect(f.conversao).toBe(0);
  });

  test('e a conversão nunca passa de 1, aconteça o que acontecer com a telemetria', async () => {
    const tresPagasUmaVista = {
      ...dados,
      check_views: [{ check_id: conta(0), venue_id: VENUE, at: agora, session_hash: 'a' }],
      payments: [0, 1, 2].map((i) => ({
        check_id: conta(i), txid: `txx${i}`, venue_id: VENUE, status: 'confirmado', confirmed_at: agora,
      })),
    };
    const { client } = postgrestFalso(tresPagasUmaVista);
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    expect((await store.getAdoptionFunnel(VENUE, {})).conversao).toBeLessThanOrEqual(1);
  });

  test('sem ninguém na mesa, a conversão é NULA e não zero', async () => {
    // Zero é uma medida ("abriram e não pagaram"); nulo é a ausência dela. O
    // portão de adoção lê os dois de forma diferente.
    const { client } = postgrestFalso({ ...dados, check_views: [] });
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
    expect((await store.getAdoptionFunnel(VENUE, {})).conversao).toBeNull();
  });
});
