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

describe('o censo: todo sítio que lê uma mesa por QR ou é leitura, ou pergunta se é treino', () => {
  // ENUMERADO, não listado à mão (compliance, PR #18, M-2): cada chamada de
  // `getCheckByQrToken`/`getVenueByTableToken` no roteador e no serviço do
  // saldo é achada pelo texto, e cai numa de duas gavetas. Um quinto caminho
  // de cobrança que leia a mesa sem a guarda derruba este teste. O
  // `isDemoVenue` foi posto em um sítio de sete — é essa a forma que se evita.
  const RAIZ = path.join(__dirname, '..');
  const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
  const LEITURA = /getCheckByQrToken\(|getVenueByTableToken\(/g;

  // Onde NÃO se cobra nada: a leitura pública da conta, a telemetria de
  // abertura e a vitrine do saldo (que responde `enabled:false` no treino).
  const SO_LEITURA = { router: ['/api/check', '/api/check/opened'], house: ['publicConfig'] };
  // Onde a rota só REPASSA pra um serviço que tem a guarda (e o serviço está
  // no censo da casa, logo abaixo).
  // (O `/api/house/open` estava aqui: ele lia a mesa pra trava de mercado. A
  // trava foi pro `openAccount` — PR #26 — e a rota não lê mais nada; o serviço
  // segue no censo da casa, na gaveta COBRA.)
  const REPASSA = { router: {}, house: {} };
  // Onde se cobra, e a primeira chamada que move dinheiro em cada um: a guarda
  // tem de vir ANTES dela (M-1: a âncora de `/api/pay` era `createCharge`, que
  // não aparece na rota — a verificação de ordem era pulada).
  const COBRA = {
    router: { '/api/pay': 'demoCharge : charge', '/api/pay/stripe-intent': 'stripePsp.' },
    house: { redeem: 'store.redeemHouse(', openAccount: 'store.createHouseAccount(' },
  };

  // O bloco de cada dono: da rota (ou função) até a próxima.
  function blocos(src, rotulo) {
    const re = rotulo === 'router' ? /url\.pathname === '([^']+)'/g : /\n  async function (\w+)\(/g;
    const inicios = [...src.matchAll(re)].map((m) => ({ dono: m[1], i: m.index }));
    return inicios.map((b, k) => ({ dono: b.dono, texto: src.slice(b.i, k + 1 < inicios.length ? inicios[k + 1].i : undefined) }));
  }

  test.each([['router', '_app/router.js'], ['house', '_lib/house/house-service.js']])('%s: cada leitura por QR está numa gaveta', (rotulo, arquivo) => {
    const lidos = blocos(ler(arquivo), rotulo).filter((b) => LEITURA.test(b.texto) && ((LEITURA.lastIndex = 0), true));
    expect(lidos.length).toBeGreaterThan(0);
    const donos = [];
    for (const { dono, texto } of lidos) {
      donos.push(dono);
      if (SO_LEITURA[rotulo].includes(dono)) continue;
      if (REPASSA[rotulo][dono]) { expect([dono, texto.includes(REPASSA[rotulo][dono])]).toEqual([dono, true]); continue; }
      expect([dono, Object.keys(COBRA[rotulo]).includes(dono)]).toEqual([dono, true]); // gaveta desconhecida
      const leu = texto.search(LEITURA);
      const guarda = texto.search(/eMesaDeTreino\((view|hit)\)/);
      const cobra = texto.indexOf(COBRA[rotulo][dono]);
      expect([dono, cobra > -1]).toEqual([dono, true]);                 // a âncora existe mesmo
      expect([dono, leu < guarda && guarda < cobra]).toEqual([dono, true]); // lê, confere, e só então cobra
    }
    // E todo dono conhecido ainda existe — uma gaveta com nome morto é uma
    // lista que parou de ser conferida.
    for (const d of [...SO_LEITURA[rotulo], ...Object.keys(REPASSA[rotulo]), ...Object.keys(COBRA[rotulo])]) {
      expect([d, donos.includes(d)]).toEqual([d, true]);
    }
  });

  test('nenhum store volta a tirar dinheiro dos números por causa da marca', () => {
    for (const f of ['_lib/store/supabase.js', '_lib/store/memory.js']) {
      expect(ler(f)).not.toMatch(/trainingChecks|\.eq\('training', true\)/);
    }
  });
});

describe('o saldo da casa na mesa de treino: nem vitrine, nem carteira nova', () => {
  test('publicConfig diz desligado, e openAccount recusa', async () => {
    const store = createMemoryStore();
    const psp = new MockPsp({ webhookSecret: 'segredo-de-teste-0123456789' });
    const house = createHouseService({ store, psp, now: () => '2026-09-23T12:00:00.000Z' });
    const venue = store.seedVenue({ name: 'Bar', servicoBp: 1000, pspRecipientId: 'rcpt_bar' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
    const real = store.seedTable(venue.id, 'Mesa 1');
    const treino = store.seedTable(venue.id, 'Treino');
    await store.setTableTraining(treino.id, true);
    expect((await house.publicConfig(real.qrToken)).enabled).toBe(true);
    expect((await house.publicConfig(treino.qrToken)).enabled).toBe(false);
    await expect(house.openAccount({ tableQrToken: treino.qrToken, phone: '11987654321', name: 'Ana' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'table_training' });
  });
});

describe('o store de PRODUÇÃO também entrega a marca — senão a rota recusa só na memória', () => {
  // O mesmo dublê de PostgREST de `conta-sem-opened.test.js`. Sem este teste,
  // tirar o `training` da leitura do Supabase deixava a suíte verde e a mesa de
  // treino cobrando em produção: a rota confere uma marca que nunca chega.
  function cliente(tabelas) {
    const from = (tabela) => {
      const f = { eq: {}, neq: {}, in: null, cols: null };
      const b = {
        // A PROJEÇÃO É HONRADA (segurança, PR #18, H1): o dublê devolvia a
        // linha inteira qualquer que fosse o SELECT, e tirar `training` da
        // leitura de produção deixava este teste verde. Só as colunas de topo
        // pedidas voltam; `venues(...)` volta inteiro.
        select(cols) {
          if (typeof cols === 'string' && cols.trim() !== '*') {
            f.cols = []; let fundo = 0; let atual = '';
            for (const ch of cols) {
              if (ch === '(') fundo += 1;
              if (ch === ')') fundo -= 1;
              if (ch === ',' && fundo === 0) { f.cols.push(atual); atual = ''; } else atual += ch;
            }
            f.cols.push(atual);
            f.cols = f.cols.map((c) => c.trim().replace(/\(.*$/s, ''));
          }
          return b;
        },
        limit() { return b; }, order() { return b; }, range() { return b; },
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
        }).map((r) => (f.cols ? Object.fromEntries(f.cols.filter((c) => c in r).map((c) => [c, r[c]])) : r));
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

  test.each([[true, true], [false, false], [null, false]])('getVenueByTableToken: coluna training=%s → table.training=%s (vitrine e carteira do saldo dependem dela)', async (coluna, esperado) => {
    // Segurança, PR #18, M3: `publicConfig` e `openAccount` leem a marca DAQUI,
    // e tirar `training` deste SELECT sobrevivia à suíte inteira.
    const tabelas = {
      venue_tables: [{ id: 't1', venue_id: 'v1', label: 'Treino', qr_token: 'qr1', active: true, training: coluna,
        venues: { id: 'v1', name: 'Casa', market: 'BR', cnpj: null, servico_basis_points: 1000 } }],
    };
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: cliente(tabelas) });
    const hit = await store.getVenueByTableToken('qr1');
    expect(hit.table.training).toBe(esperado);
    expect(eMesaDeTreino(hit)).toBe(esperado);
  });

  test('marcar como treino com conta aberta: recusado ANTES de escrever — e com CLOSED no razão, passa da guarda', async () => {
    const ID = '00000000-5555-4555-8555-000000000002';
    const tabelas = {
      venue_tables: [{ id: 't1', venue_id: 'v1', label: 'Mesa 1', qr_token: 'qr1', active: true, training: false }],
      checks: [{ id: ID, venue_id: 'v1', table_id: 't1', status: 'aberta', opened_at: '2026-09-23T12:00:00Z', pos_ref: '[]' }],
      check_events: [{ check_id: ID, seq: 1, type: 'OPENED', payload: { totalCents: 1000 }, created_at: '2026-09-23T12:00:00Z' }],
      payments: [],
    };
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: cliente(tabelas) });
    await expect(store.setTableTraining('t1', true)).rejects.toMatchObject({ statusCode: 409, code: 'table_has_open_check' });
    // Fechada: a guarda deixa passar e o store chega à ESCRITA — que este dublê
    // não implementa (`update`), e é esse o erro que prova ter passado.
    tabelas.check_events.push({ check_id: ID, seq: 2, type: 'CLOSED', payload: {}, created_at: '2026-09-23T13:00:00Z' });
    await expect(store.setTableTraining('t1', true)).rejects.toThrow(/update is not a function/);
  });
});


describe('todo TRILHO de /api/pay e o intent de cartão recusam — com o adquirente espiado', () => {
  // Segurança, PR #18, M2: o teste da rota só mandava Pix. A carteira captura
  // o dinheiro NA chamada (Pagar.me, `walletCaptures`), e o intent da Stripe é
  // outro caminho inteiro — os dois sem teste de comportamento.
  let srv; let porta; let store; let intents = 0;
  const ANTES = process.env.STRIPE_SECRET_KEY;
  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_naoexiste';
    let route;
    jest.isolateModules(() => {
      jest.doMock('stripe', () => () => ({
        paymentIntents: { create: async () => { intents += 1; return { id: 'pi_x', client_secret: 'cs_x', status: 'requires_payment_method' }; } },
        webhooks: { constructEvent: () => { throw new Error('não usado'); } },
      }));
      ({ route, store } = require('../_app/router'));
    });
    if (ANTES === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = ANTES;
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv.close());
  const post = (p, body) => fetch(`http://127.0.0.1:${porta}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  async function mesaDeTreino(market) {
    const venue = store.seedVenue({ name: `Casa ${Math.random()}`, servicoBp: 1000, pspRecipientId: 'rcpt_x', ...(market ? { market } : {}) });
    await store.setVenueStripeAccount(venue.id, 'acct_teste123');
    const t = store.seedTable(venue.id, 'Treino');
    await store.setTableTraining(t.id, true);
    const c = await store.openCheck(t.qrToken, [{ id: 'a', name: 'Café', priceCents: 1000 }]);
    return { t, c };
  }

  test.each([
    ['carteira (Google Pay)', { wallet: 'google_pay', paymentToken: 'tok_x', rail: 'pix' }],
    ['Bizum', { rail: 'bizum' }],
  ])('/api/pay por %s → 409 e nada no razão', async (_n, extra) => {
    const { t, c } = await mesaDeTreino();
    const r = await post('/api/pay', { token: t.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725', ...extra });
    expect(r).toEqual({ status: 409, body: { success: false, code: 'table_training' } });
    expect((await store.loadEvents(c.id)).map((e) => e.type)).toEqual(['OPENED']);
  });

  test('/api/pay/stripe-intent → 409, e a Stripe NUNCA é chamada', async () => {
    const { t } = await mesaDeTreino();
    const antes = intents;
    const r = await post('/api/pay/stripe-intent', { token: t.qrToken, amountCents: 1000, tipCents: 0 });
    expect(r).toEqual({ status: 409, body: { success: false, code: 'table_training' } });
    expect(intents).toBe(antes);
  });

  test('e o espião ENXERGA: numa mesa comum, o intent chama a Stripe', async () => {
    const venue = store.seedVenue({ name: `Casa ${Math.random()}`, servicoBp: 1000, pspRecipientId: 'rcpt_y' });
    await store.setVenueStripeAccount(venue.id, 'acct_teste456');
    const t = store.seedTable(venue.id, 'Mesa 1');
    await store.openCheck(t.qrToken, [{ id: 'a', name: 'Café', priceCents: 1000 }]);
    const antes = intents;
    const r = await post('/api/pay/stripe-intent', { token: t.qrToken, amountCents: 1000, tipCents: 0 });
    expect(r.status).toBe(200);
    expect(intents).toBe(antes + 1);
  });
});

describe('marcar como treino com conta aberta é recusado', () => {
  test('nos dois sentidos: recusa marcar com conta aberta; tirar do treino sempre pode', async () => {
    const store = createMemoryStore();
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000 });
    const t = store.seedTable(venue.id, 'Mesa 1');
    const c = await store.openCheck(t.qrToken, [{ id: 'a', name: 'Café', priceCents: 1000 }]);
    await expect(store.setTableTraining(t.id, true)).rejects.toMatchObject({ statusCode: 409, code: 'table_has_open_check' });
    await store.appendEvent(c.id, 'CLOSED', {});
    await expect(store.setTableTraining(t.id, true)).resolves.toMatchObject({ training: true });
    await store.openCheck(t.qrToken, [{ id: 'b', name: 'Chá', priceCents: 500 }]);
    await expect(store.setTableTraining(t.id, false)).resolves.toMatchObject({ training: false });
  });
});
