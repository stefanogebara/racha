'use strict';

/**
 * A DEMO PROVA A CASA — o token sozinho não basta.
 *
 * O livro de abertos (HIGH): com `RACHA_DEMO_TABLE_TOKEN` digitada apontando
 * pro QR de uma mesa de verdade, `/api/pay` cobrava pelo MockPsp da demo e a
 * conta real virava `paga` sem dinheiro nenhum — qualquer um com o QR fechava
 * a conta sem pagar. O mesmo token desligava o reconcile-on-read, sumia com
 * carteira e cartão e dizia "demo" sem pedir CPF. Ver `tokenEDaDemo`.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TOKEN_REAL = 'mesarealdigitadaerrado0000000001';

describe('com o token da demo apontando pra uma mesa de VERDADE', () => {
  let srv; let porta; let store; let conta; let log = [];
  const ANTES = process.env.RACHA_DEMO_TABLE_TOKEN;
  beforeAll(async () => {
    process.env.RACHA_DEMO_TABLE_TOKEN = TOKEN_REAL;
    let route;
    jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
    if (ANTES === undefined) delete process.env.RACHA_DEMO_TABLE_TOKEN; else process.env.RACHA_DEMO_TABLE_TOKEN = ANTES;
    const venue = store.seedVenue({ name: 'Casa de verdade', servicoBp: 1000, pspRecipientId: 'rcpt_real' });
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

  test('a leitura NÃO diz "demo", pede CPF, e grita no log', async () => {
    const r = await (await fetch(`http://127.0.0.1:${porta}/api/check?t=${TOKEN_REAL}`)).json();
    expect(r.data.venue.demo).not.toBe(true);
    expect(r.data.venue.payerTaxId.required).toBe(true);
    expect(log.some((l) => l.startsWith('[demo-token]') && l.includes(conta.id))).toBe(true);
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

describe('o censo: o token da demo não decide sozinho em lugar nenhum', () => {
  const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

  test('só as duas curas comparam o token direto — e as duas passam por quem prova a casa', () => {
    const linhas = ROUTER.split('\n').filter((l) => /[!=]==\s*DEMO_TABLE_TOKEN|DEMO_TABLE_TOKEN\s*[!=]==/.test(l));
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

  test('cada decisão "é a demo" do roteador passa por `tokenEDaDemo`', () => {
    // /api/check (uma vez por leitura), /api/pay e /api/pay/stripe-intent.
    expect((ROUTER.match(/await tokenEDaDemo\(store, /g) || []).length).toBe(3);
  });
});
