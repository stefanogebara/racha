'use strict';

/**
 * A DEMO PROVA A CASA — o token sozinho não basta.
 *
 * O livro de abertos (HIGH): com `RACHA_DEMO_TABLE_TOKEN` digitada apontando
 * pro QR de uma mesa de verdade, `/api/pay` cobrava pelo MockPsp da demo e a
 * conta real virava `paga` sem dinheiro nenhum — qualquer um com o QR fechava
 * a conta sem pagar. O mesmo token desligava o reconcile-on-read, sumia com
 * carteira e cartão e dizia "demo" sem pedir CPF. Ver `contaEDaDemo`: agora
 * é a CASA que decide.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TOKEN_REAL = 'mesarealdigitadaerrado0000000001';

// AS DUAS FORMAS de casa real: recebedor de verdade, e a forma que sete casas
// de produção têm (e o `seedVenue` da memória por padrão) — `rcpt_demo` SEM
// `isTest`. Só a segunda prende a perna `isTest` do `isDemoVenue`: tirá-la
// sobrevivia à suíte inteira (segurança, PR #19, M-1).
describe.each([
  ['recebedor de verdade', { pspRecipientId: 'rcpt_real' }],
  ['rcpt_demo SEM isTest (a forma de produção)', { pspRecipientId: 'rcpt_demo' }],
])('com o token da demo apontando pra uma mesa de VERDADE — casa com %s', (_forma, casaExtra) => {
  let srv; let porta; let store; let conta; let log = [];
  const ANTES = process.env.RACHA_DEMO_TABLE_TOKEN;
  beforeAll(async () => {
    process.env.RACHA_DEMO_TABLE_TOKEN = TOKEN_REAL;
    let route;
    jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
    if (ANTES === undefined) delete process.env.RACHA_DEMO_TABLE_TOKEN; else process.env.RACHA_DEMO_TABLE_TOKEN = ANTES;
    const venue = store.seedVenue({ name: 'Casa de verdade', servicoBp: 1000, ...casaExtra });
    expect(venue.isTest).not.toBe(true);
    store.seedTable(venue.id, 'Mesa 7', TOKEN_REAL);
    conta = await store.openCheck(TOKEN_REAL, [{ id: 'a', name: 'Picanha', priceCents: 8990 }]);
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv.close());
  beforeEach(() => {
    log = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((s) => { log.push(String(s)); return true; });
  });
  afterEach(() => jest.restoreAllMocks());

  test('a leitura NÃO diz "demo", pede CPF, e grita no log — UMA vez, não a cada poll', async () => {
    const r = await (await fetch(`http://127.0.0.1:${porta}/api/check?t=${TOKEN_REAL}`)).json();
    expect(r.data.venue.demo).not.toBe(true);
    expect(r.data.venue.payerTaxId.required).toBe(true);
    await fetch(`http://127.0.0.1:${porta}/api/check?t=${TOKEN_REAL}`);
    await fetch(`http://127.0.0.1:${porta}/api/check?t=${TOKEN_REAL}`);
    // Cada telefone sonda a cada 4 s: a linha de configuração quebrada sai uma
    // vez por conta por hora, senão ela vira a enchente que ensina a ignorar.
    expect(log.filter((l) => l.startsWith('[demo-token]') && l.includes(conta.id))).toHaveLength(1);
  });

  test('pagar cobra como MESA REAL: nada de auto-confirmação do MockPsp da demo', async () => {
    const r = await fetch(`http://127.0.0.1:${porta}/api/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN_REAL, amountCents: 8990, tipCents: 0, payerDocument: '52998224725', rail: 'pix' }),
    }).then((x) => x.json());
    expect(r.success).toBe(true);
    // A demo confirma a própria cobrança na hora (é o que fazia a conta real
    // virar `paga` sem dinheiro). Mesa real: a cobrança fica PENDENTE até o
    // adquirente de verdade confirmar.
    const tipos = (await store.loadEvents(conta.id)).map((e) => e.type);
    expect(tipos).not.toContain('PAYMENT_CONFIRMED');
    const lida = await (await fetch(`http://127.0.0.1:${porta}/api/check?t=${TOKEN_REAL}`)).json();
    expect(lida.data.state.status).toBe('aberta');
  });
});

describe('a outra metade do mesmo erro: a env diferente do token da landing', () => {
  // A landing tem `demoracha` fixo no código. Decidindo pelo token, qualquer
  // outro valor da env fazia a demo de verdade virar mesa real — CPF do
  // visitante numa casa fictícia (compliance, PR #19, M-2). Pela casa, não.
  let srv; let porta; let store;
  const ANTES = process.env.RACHA_DEMO_TABLE_TOKEN;
  beforeAll(async () => {
    process.env.RACHA_DEMO_TABLE_TOKEN = 'outrotoken0000000000000000000001';
    let route;
    jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
    if (ANTES === undefined) delete process.env.RACHA_DEMO_TABLE_TOKEN; else process.env.RACHA_DEMO_TABLE_TOKEN = ANTES;
    const { ensureDemoCheck, DEMO_TOKEN } = require('../_lib/demo');
    await ensureDemoCheck(store, DEMO_TOKEN);
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv.close());

  test('a demo da landing continua sendo a demo: sem CPF, com a bandeira', async () => {
    const r = await (await fetch(`http://127.0.0.1:${porta}/api/check?t=demoracha`)).json();
    expect(r.data.venue.demo).toBe(true);
    expect(r.data.venue.payerTaxId.required).toBe(false);
  });
});

describe('o censo: o token da demo não decide sozinho em lugar nenhum', () => {
  const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

  test('só as duas curas comparam o token direto — e as duas passam por quem prova a casa', () => {
    // `==` também: o mutante `DEMO_TABLE_TOKEN == b.token ||` escapava de uma
    // regex só de `===` (segurança, PR #19, L-1).
    const linhas = ROUTER.split('\n').filter((l) => /[!=]==?\s*DEMO_TABLE_TOKEN|DEMO_TABLE_TOKEN\s*[!=]==?/.test(l));
    expect(linhas).toHaveLength(2);
    // As curas: `ensureDemoCheck` e `resetDemoCheck` chamam `resolveDemoTable`,
    // que recusa mesa fora da casa da demo antes de fechar ou abrir qualquer coisa.
    const curas = ROUTER.slice(ROUTER.indexOf(linhas[0].trim()), ROUTER.indexOf(linhas[1].trim()) + 800);
    expect(curas).toMatch(/ensureDemoCheck\(store, token\)/);
    expect(curas).toMatch(/resetDemoCheck\(store, token\)/);
    const demoJs = fs.readFileSync(path.join(__dirname, '..', '_lib', 'demo.js'), 'utf8');
    for (const f of ['ensureDemoCheck', 'resetDemoCheck']) {
      const corpo = demoJs.slice(demoJs.indexOf(`async function ${f}(`));
      expect([f, corpo.slice(0, 600).includes('resolveDemoTable(store, token)')]).toEqual([f, true]);
    }
  });

  test('cada decisão "é a demo" do roteador passa por `contaEDaDemo`', () => {
    // /api/check (uma vez por leitura), /api/pay e /api/pay/stripe-intent.
    expect((ROUTER.match(/await contaEDaDemo\(store, /g) || []).length).toBe(3);
  });
});

describe('o intent de cartão com o token da demo numa casa de verdade', () => {
  // A casa real NÃO perde o cartão por causa do token: a recusa `rail_unsupported`
  // é só da demo de verdade (segurança, PR #19, L-1).
  let srv; let porta; let store; let intents = 0;
  const TOKEN = 'mesarealdigitadaerrado0000000002';
  const ANTES = { k: process.env.STRIPE_SECRET_KEY, t: process.env.RACHA_DEMO_TABLE_TOKEN };
  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_naoexiste';
    process.env.RACHA_DEMO_TABLE_TOKEN = TOKEN;
    let route;
    jest.isolateModules(() => {
      jest.doMock('stripe', () => () => ({
        paymentIntents: { create: async () => { intents += 1; return { id: 'pi_y', client_secret: 'cs_y', status: 'requires_payment_method' }; } },
        webhooks: { constructEvent: () => { throw new Error('não usado'); } },
      }));
      ({ route, store } = require('../_app/router'));
    });
    for (const [k, v] of [['STRIPE_SECRET_KEY', ANTES.k], ['RACHA_DEMO_TABLE_TOKEN', ANTES.t]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const venue = store.seedVenue({ name: 'Casa real', servicoBp: 1000, pspRecipientId: 'rcpt_demo' });
    await store.setVenueStripeAccount(venue.id, 'acct_real789');
    store.seedTable(venue.id, 'Mesa 3', TOKEN);
    await store.openCheck(TOKEN, [{ id: 'a', name: 'Café', priceCents: 1000 }]);
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv.close());

  test('cobra no cartão normalmente — a Stripe é chamada', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await fetch(`http://127.0.0.1:${porta}/api/pay/stripe-intent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, amountCents: 1000, tipCents: 0 }),
    });
    jest.restoreAllMocks();
    expect(r.status).toBe(200);
    expect(intents).toBe(1);
  });
});
