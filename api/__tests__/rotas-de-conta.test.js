'use strict';

/**
 * AS ROTAS DO DONO SOBRE A CONTA — `/api/checks`, `/api/checks/adjust`,
 * `/api/checks/close` — de ponta a ponta pelo router, com login DE VERDADE no
 * caminho (o `guardUser` e a posse da casa), sem rede: o cliente Supabase é
 * trocado por um falso que reconhece um token de teste. (Segurança, PR #21:
 * as rotas não tinham teste de rota — o `code` na resposta e o 500 do erro
 * interno.)
 */
const http = require('node:http');

describe('rotas /api/checks*', () => {
  let srv; let porta; let store;
  const DONO = { id: '00000000-0000-4000-8000-00000000d0e0', email: 'dono@teste.example' };
  const OUTRO = { id: '00000000-0000-4000-8000-0000000000aa', email: 'outro@teste.example' };
  const env0 = { ...process.env };

  beforeAll(async () => {
    process.env.SUPABASE_URL = 'http://supabase.falso';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-falsa';
    delete process.env.RACHA_STORE;   // store em memória; só o AUTH é "Supabase"
    let route;
    jest.isolateModules(() => {
      jest.doMock('../_lib/store/cliente-supabase', () => ({
        ...jest.requireActual('../_lib/store/cliente-supabase'),
        criarClienteSupabase: () => ({
          auth: {
            getUser: async (tok) => (tok === 'tok-dono' ? { data: { user: DONO }, error: null }
              : tok === 'tok-outro' ? { data: { user: OUTRO }, error: null }
                // O token recusado tem a FORMA do GoTrue (`code: 'bad_jwt'`) — é por ela
                // que o auth separa 'recusou' (401) de 'não deu pra perguntar' (503).
                : { data: { user: null }, error: { status: 403, code: 'bad_jwt', message: 'invalid JWT' } }),
          },
        }),
      }));
      ({ route, store } = require('../_app/router'));
    });
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(async () => {
    await new Promise((r) => srv.close(r));
    process.env = env0;
  });

  const post = (caminho, corpo, tok) => fetch(`http://127.0.0.1:${porta}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(corpo),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  async function casaDoDono() {
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000, pspRecipientId: 'rcpt_t' });
    await store.addVenueMember(venue.id, DONO.id, 'owner');
    const table = store.seedTable(venue.id, `Mesa ${Math.random().toString(36).slice(2, 6)}`);
    return { venue, table };
  }

  test('sem token: 401; token de quem não é dono: 404 (nunca revela que a casa existe)', async () => {
    const { table } = await casaDoDono();
    expect((await post('/api/checks', { tableId: table.id, totalCents: 1000 })).status).toBe(401);
    expect((await post('/api/checks', { tableId: table.id, totalCents: 1000 }, 'tok-invalido')).status).toBe(401);
    expect((await post('/api/checks', { tableId: table.id, totalCents: 1000 }, 'tok-outro')).status).toBe(404);
  });

  test('/api/house/admin/recredit: sem token 401; dono de OUTRA casa e não-dono: o mesmo 404, e nada estornado; o dono chega ao serviço (segurança, PR #44, L-1/L-2)', async () => {
    const { venue, table } = await casaDoDono();
    const outraCasa = store.seedVenue({ name: 'Outra', servicoBp: 1000, pspRecipientId: 'rcpt_o' });
    await store.addVenueMember(outraCasa.id, OUTRO.id, 'owner');
    const conta = await store.createHouseAccount({ venueId: venue.id, phone: '11955554444', name: 'C' });
    await store.registerHouseLoad({ accountId: conta.id, txid: `l_${conta.id.slice(0, 6)}`, amountCents: 5000, bonusCents: 0, validityDays: 30 });
    await store.confirmHouseLoad({ txid: `l_${conta.id.slice(0, 6)}`, confirmedAt: new Date().toISOString() });
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 3000 }]);
    const txid = `ha_rota_${conta.id.slice(0, 6)}`;
    await store.redeemHouse({ accountId: conta.id, checkId: check.id, txid, amountCents: 1000, nowIso: new Date().toISOString() });
    const corpo = { accountId: conta.id, txid };
    expect((await post('/api/house/admin/recredit', corpo)).status).toBe(401);
    const doOutro = await post('/api/house/admin/recredit', corpo, 'tok-outro');
    const inexistente = await post('/api/house/admin/recredit', { accountId: '00000000-0000-4000-8000-00000000beef', txid }, 'tok-outro');
    expect(doOutro).toMatchObject({ status: 404, body: { code: 'house_recredit_not_flagged' } });
    expect(inexistente).toMatchObject({ status: 404, body: { code: 'house_recredit_not_flagged' } });   // indistinguíveis
    // O dono chega ao serviço — e o débito de agora é recente demais (pagamento pode estar em voo).
    expect(await post('/api/house/admin/recredit', corpo, 'tok-dono'))
      .toMatchObject({ status: 409, body: { code: 'house_recredit_too_soon' } });
    const eventos = await store.loadHouseEvents(conta.id);
    expect(eventos.some((e) => e.type === 'REDEEM_REVERSED')).toBe(false);
  });

  test('campo obrigatório faltando: 400 com CÓDIGO', async () => {
    expect(await post('/api/checks', {}, 'tok-dono')).toMatchObject({ status: 400, body: { code: 'table_id_required' } });
    expect(await post('/api/checks/adjust', {}, 'tok-dono')).toMatchObject({ status: 400, body: { code: 'check_id_required' } });
    expect(await post('/api/checks/close', { checkId: '00000000-0000-4000-8000-000000000999' }, 'tok-dono'))
      .toMatchObject({ status: 404, body: { code: 'check_not_found' } });
  });

  test('o ciclo do dono: abre, repete (409), ajusta, fecha, fecha de novo (400), não ajusta fechada', async () => {
    const { table } = await casaDoDono();
    const aberta = await post('/api/checks', { tableId: table.id, items: [{ name: 'A', priceCents: 1000 }] }, 'tok-dono');
    expect(aberta.status).toBe(200);
    const { checkId } = aberta.body.data;
    expect(await post('/api/checks', { tableId: table.id, totalCents: 500 }, 'tok-dono'))
      .toMatchObject({ status: 409, body: { code: 'check_already_open' } });
    const ajuste = await post('/api/checks/adjust', { checkId, items: [{ name: 'A', priceCents: 1000 }, { name: 'B', priceCents: 700 }] }, 'tok-dono');
    expect(ajuste).toMatchObject({ status: 200, body: { data: { totalCents: 1700 } } });
    expect(await post('/api/checks/adjust', { checkId, items: [{ name: 'X', priceCents: 1 }] }, 'tok-outro')).toMatchObject({ status: 404 });
    expect(await post('/api/checks/close', { checkId }, 'tok-dono')).toMatchObject({ status: 200, body: { data: { status: 'fechada' } } });
    // Fechar DE NOVO à mão é erro do chamador (400); a corrida de dois toques é
    // que é idempotente (check-service, `primeira`). Com código, não a frase.
    expect(await post('/api/checks/close', { checkId }, 'tok-dono')).toMatchObject({ status: 400, body: { code: 'check_closed' } });
    expect(await post('/api/checks/adjust', { checkId, totalCents: 2000 }, 'tok-dono')).toMatchObject({ status: 400, body: { code: 'check_closed' } });
  });

  test('erro INTERNO: 500 genérico — a mensagem do driver não sai', async () => {
    const { table } = await casaDoDono();
    const original = store.openCheck;
    store.openCheck = async () => { throw new Error('supabase store openCheck: connection to 10.0.0.7:5432 refused (senha=xyz)'); };
    try {
      const r = await post('/api/checks', { tableId: table.id, totalCents: 1000 }, 'tok-dono');
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/10\.0\.0\.7|senha|supabase store/);
    } finally { store.openCheck = original; }
  });
});
