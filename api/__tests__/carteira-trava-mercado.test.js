'use strict';

/**
 * A CARTEIRA DA CASA NÃO ABRE EM MERCADO QUE NÃO ESTÁ LIBERADO.
 *
 * Ela coleta nome e telefone. Em Espanha isso é titular europeu com o banco em
 * São Paulo — sem a papelada, o primeiro cliente espanhol não pode existir. A
 * rota lia `.market` do par `{ venue, table }` e a trava nunca disparava.
 */
const http = require('node:http');

describe('/api/house/open respeita o mercado da casa', () => {
  let srv; let porta; let store; const antes = process.env.RACHA_ES_ENABLED;
  beforeAll(async () => {
    delete process.env.RACHA_ES_ENABLED;
    let route;
    jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(async () => {
    if (antes === undefined) delete process.env.RACHA_ES_ENABLED; else process.env.RACHA_ES_ENABLED = antes;
    await new Promise((r) => srv.close(r));
  });

  const abrir = (token) => fetch(`http://127.0.0.1:${porta}/api/house/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, phone: '11987654321', name: 'Cliente' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  test('casa espanhola com a Espanha desligada: 400 market_not_live, e nenhuma carteira criada', async () => {
    const casa = await store.seedVenue({ name: 'Bar Pepe', cnpj: 'B12345678', market: 'es' });
    await store.setHouseConfig(casa.id, { enabled: true, bonusBp: 1000, validityDays: 90 });
    const mesa = await store.seedTable(casa.id, 'Mesa 4');
    const r = await abrir(mesa.qrToken);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('market_not_live');
    expect(await store.countHouseAccounts(casa.id)).toBe(0);
  });

  test('casa brasileira segue abrindo', async () => {
    const casa = await store.seedVenue({ name: 'Bar do Zé', cnpj: '12.345.678/0001-99' });
    await store.setHouseConfig(casa.id, { enabled: true, bonusBp: 1000, validityDays: 90 });
    const mesa = await store.seedTable(casa.id, 'Mesa 1');
    const r = await abrir(mesa.qrToken);
    expect([r.status, r.body.code]).toEqual([200, undefined]);
    expect(await store.countHouseAccounts(casa.id)).toBe(1);   // a contagem conta de verdade
  });
});

describe('o SERVIÇO carrega a trava — nenhum chamador de openAccount a pula', () => {
  const { createMemoryStore } = require('../_lib/store/memory');
  const { MockPsp } = require('../_lib/pay/mock-psp');
  const { createHouseService } = require('../_lib/house/house-service');
  const antes = process.env.RACHA_ES_ENABLED;
  afterEach(() => { if (antes === undefined) delete process.env.RACHA_ES_ENABLED; else process.env.RACHA_ES_ENABLED = antes; });

  async function montar(market) {
    const store = createMemoryStore();
    const svc = createHouseService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(32) }) });
    const casa = await store.seedVenue({ name: 'Casa', cnpj: 'B12345678', market });
    await store.setHouseConfig(casa.id, { enabled: true, bonusBp: 1000, validityDays: 90 });
    const mesa = await store.seedTable(casa.id, 'Mesa 1');
    return { store, svc, casa, mesa };
  }

  test('Espanha desligada: openAccount recusa com market_not_live e publicConfig não oferece', async () => {
    delete process.env.RACHA_ES_ENABLED;
    const { store, svc, casa, mesa } = await montar('es');
    await expect(svc.openAccount({ tableQrToken: mesa.qrToken, phone: '11987654321', name: 'Cliente' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'market_not_live' });
    expect(await store.countHouseAccounts(casa.id)).toBe(0);
    expect((await svc.publicConfig(mesa.qrToken)).enabled).toBe(false);
  });

  test('Espanha ligada: abre e oferece — a trava é do mercado, não da casa', async () => {
    process.env.RACHA_ES_ENABLED = 'true';
    const { store, svc, casa, mesa } = await montar('es');
    expect((await svc.publicConfig(mesa.qrToken)).enabled).toBe(true);
    await svc.openAccount({ tableQrToken: mesa.qrToken, phone: '11987654321', name: 'Cliente' });   // o normalizador de telefone é só BR (TASKS)
    expect(await store.countHouseAccounts(casa.id)).toBe(1);
  });
});
