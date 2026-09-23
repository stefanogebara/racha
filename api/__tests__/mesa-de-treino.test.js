'use strict';

/**
 * MESA DE TREINO NÃO COBRA — e o painel não esconde dinheiro por causa dela.
 *
 * A auditoria do painel de 2026-09-23 (P1) achou: o roteiro do workshop manda
 * cada garçom pagar "uma conta de mentira" na mesa de treino, nenhum caminho de
 * pagamento olhava a marca — o Pix era real e liquidava no CNPJ —, e o painel
 * tirava esse dinheiro dos números, o serviço da folha inclusive. Ver
 * `api/_lib/checks/mesa-de-treino.js` pra decisão (recusar, não fingir).
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { eMesaDeTreino, CODIGO_MESA_DE_TREINO } = require('../_lib/checks/mesa-de-treino');
const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createHouseService } = require('../_lib/house/house-service');

describe('a decisão', () => {
  test('só a marca explícita recusa; sem informação, não é treino', () => {
    expect(eMesaDeTreino({ table: { label: 'Treino', training: true } })).toBe(true);
    expect(eMesaDeTreino({ table: { label: 'Mesa 1', training: false } })).toBe(false);
    expect(eMesaDeTreino({ table: { label: 'Mesa 1' } })).toBe(false);
    expect(eMesaDeTreino({ table: { label: 'Mesa 1', training: 'true' } })).toBe(false);
    expect(eMesaDeTreino(null)).toBe(false);
    expect(CODIGO_MESA_DE_TREINO).toBe('table_training');
  });
});

describe('a rota: /api/pay recusa a mesa de treino antes de qualquer cobrança', () => {
  let srv; let porta; let store;
  beforeAll(async () => {
    let route;
    jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv.close());

  const post = (p, body) => fetch(`http://127.0.0.1:${porta}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(`http://127.0.0.1:${porta}${p}`).then((r) => r.json());

  test('mesa de treino: 409 `table_training`, e NADA no razão — nem cobrança, nem vaga', async () => {
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000, pspRecipientId: 'rcpt_casa' });
    const treino = store.seedTable(venue.id, 'Treino');
    await store.setTableTraining(treino.id, true);
    const conta = await store.openCheck(treino.qrToken, [{ id: 'a', name: 'Café', priceCents: 1000 }]);

    const lida = await get(`/api/check?t=${treino.qrToken}`);
    expect(lida.data.table.training).toBe(true); // o cliente é AVISADO antes de tocar
    expect(lida.data.venue.payerTaxId.required).toBe(false); // e não dá CPF pra nada

    const r = await post('/api/pay', { token: treino.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725', rail: 'pix' });
    expect(r).toEqual({ status: 409, body: { success: false, code: 'table_training' } });
    const eventos = await store.loadEvents(conta.id);
    expect(eventos.map((e) => e.type)).toEqual(['OPENED']);
  });

  test('a mesa de verdade, na mesma casa, segue cobrando', async () => {
    const venue = store.seedVenue({ name: 'Casa2', servicoBp: 1000, pspRecipientId: 'rcpt_casa2' });
    const mesa = store.seedTable(venue.id, 'Mesa 1');
    await store.openCheck(mesa.qrToken, [{ id: 'a', name: 'Café', priceCents: 1000 }]);
    const lida = await get(`/api/check?t=${mesa.qrToken}`);
    expect(lida.data.table.training).toBe(false);
    expect(lida.data.venue.payerTaxId.required).toBe(true);
    const r = await post('/api/pay', { token: mesa.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725', rail: 'pix' });
    expect(r.status).toBe(200);
    expect(r.body.data.txid).toBeTruthy();
  });
});

describe('o saldo da casa: mesa de treino não gasta o dinheiro do cliente', () => {
  test('redeem numa mesa de treino → 409 `table_training`, saldo intacto', async () => {
    const store = createMemoryStore();
    const psp = new MockPsp({ webhookSecret: 'segredo-de-teste-0123456789' });
    const house = createHouseService({ store, psp, now: () => '2026-09-23T12:00:00.000Z' });
    const venue = store.seedVenue({ name: 'Bar', servicoBp: 1000, pspRecipientId: 'rcpt_bar' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
    const real = store.seedTable(venue.id, 'Mesa 1');
    const treino = store.seedTable(venue.id, 'Treino');
    await store.setTableTraining(treino.id, true);
    const { accountToken } = await house.openAccount({ tableQrToken: real.qrToken, phone: '11987654321', name: 'Ana' });
    await store.openCheck(treino.qrToken, [{ id: 'a', name: 'Café', priceCents: 1000 }]);
    const antes = (await house.wallet(accountToken)).account.totalCents;
    await expect(house.redeem({ accountToken, tableQrToken: treino.qrToken, amountCents: 500 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'table_training' });
    expect((await house.wallet(accountToken)).account.totalCents).toBe(antes);
  });
});

describe('o censo: todo caminho que cobra a partir de uma mesa pergunta se é treino', () => {
  // Os três sítios de hoje. Um quarto caminho de cobrança que leia a conta por
  // QR sem passar por aqui é o "chamador esquecido" que este repositório já
  // pagou pra aprender — o `isDemoVenue` foi posto em um sítio de sete.
  const RAIZ = path.join(__dirname, '..');
  const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
  const bloco = (src, inicio, fim) => {
    const i = src.indexOf(inicio);
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf(fim, i + inicio.length);
    return src.slice(i, j === -1 ? undefined : j);
  };

  test.each([
    ['/api/pay', "url.pathname === '/api/pay')", 'createCharge'],
    ['/api/pay/stripe-intent', "url.pathname === '/api/pay/stripe-intent')", 'stripePsp.'],
  ])('%s: a marca é conferida logo depois de ler a conta, antes de cobrar', (_nome, inicio, cobranca) => {
    const src = ler('_app/router.js');
    const b = bloco(src, inicio, 'url.pathname ===');
    const leu = b.indexOf('getCheckByQrToken(');
    const conferiu = b.indexOf('eMesaDeTreino(view)');
    expect(leu).toBeGreaterThan(-1);
    expect(conferiu).toBeGreaterThan(leu);
    const cobrou = b.indexOf(cobranca, leu);
    if (cobrou !== -1) expect(conferiu).toBeLessThan(cobrou);
  });

  test('o saldo da casa confere a marca antes de gastar', () => {
    const b = bloco(ler('_lib/house/house-service.js'), 'async function redeem(', '\n  async function ');
    expect(b.indexOf('eMesaDeTreino(view)')).toBeGreaterThan(b.indexOf('getCheckByQrToken('));
  });

  test('nenhum store volta a tirar dinheiro dos números por causa da marca', () => {
    for (const f of ['_lib/store/supabase.js', '_lib/store/memory.js']) {
      expect(ler(f)).not.toMatch(/trainingChecks|\.eq\('training', true\)/);
    }
  });
});

describe('o store de PRODUÇÃO também entrega a marca — senão a rota recusa só na memória', () => {
  // O mesmo dublê de PostgREST de `conta-sem-opened.test.js`. Sem este teste,
  // tirar o `training` da leitura do Supabase deixava a suíte verde e a mesa de
  // treino cobrando em produção: a rota confere uma marca que nunca chega.
  function cliente(tabelas) {
    const from = (tabela) => {
      const f = { eq: {}, neq: {}, in: null };
      const b = {
        select() { return b; }, limit() { return b; }, order() { return b; }, range() { return b; },
        eq(c, v) { f.eq[c] = v; return b; }, neq(c, v) { f.neq[c] = v; return b; },
        in(c, vs) { f.in = { c, vs: new Set(vs) }; return b; }, gte() { return b; }, not() { return b; },
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
  const { createSupabaseStore } = require('../_lib/store/supabase');

  test.each([[true, true], [false, false], [null, false]])('coluna training=%s → view.table.training=%s', async (coluna, esperado) => {
    const ID = '00000000-5555-4555-8555-000000000001';
    const tabelas = {
      venue_tables: [{ id: 't1', venue_id: 'v1', label: 'Treino', qr_token: 'qr1', active: true, training: coluna,
        venues: { id: 'v1', name: 'Casa', market: 'BR', cnpj: null, servico_basis_points: 1000 } }],
      checks: [{ id: ID, venue_id: 'v1', table_id: 't1', status: 'aberta', opened_at: '2026-09-23T12:00:00Z', pos_ref: '[]' }],
      check_events: [{ check_id: ID, seq: 1, type: 'OPENED', payload: { totalCents: 1000 }, created_at: '2026-09-23T12:00:00Z' }],
      payments: [],
    };
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: cliente(tabelas) });
    const view = await store.getCheckByQrToken('qr1');
    expect(view.table.training).toBe(esperado);
    expect(eMesaDeTreino(view)).toBe(esperado);
  });
});
