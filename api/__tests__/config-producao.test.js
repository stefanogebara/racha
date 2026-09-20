'use strict';

/**
 * PRODUÇÃO NÃO COBRA EM MODO DE DEMO.
 *
 * Sem `RACHA_STORE=supabase` o store é o mapa em memória de UMA instância —
 * a cobrança Pix de verdade seria gravada numa instância e o webhook, noutra,
 * receberia "txid desconhecido". Sem `RACHA_PSP=pagarme`, casa de verdade
 * entregava BR Code de mentira. Nada impedia (auditoria de backend C1).
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

beforeAll(() => { jest.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterAll(() => { jest.restoreAllMocks(); });

describe('produção sem a loja e o adquirente de verdade', () => {
  let srv; let porta;
  beforeAll(async () => {
    const antes = { VERCEL_ENV: process.env.VERCEL_ENV, RACHA_STORE: process.env.RACHA_STORE, RACHA_PSP: process.env.RACHA_PSP };
    process.env.VERCEL_ENV = 'production';
    delete process.env.RACHA_STORE;
    delete process.env.RACHA_PSP;
    let route;
    jest.isolateModules(() => { ({ route } = require('../_app/router')); });
    // O router lê a env no LOAD: devolve ela já, pra não vazar pros outros
    // arquivos do mesmo processo.
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv && srv.close());

  test('as rotas de dinheiro RECUSAM com código — e a leitura segue de pé', async () => {
    const base = `http://127.0.0.1:${porta}`;
    const pagar = await fetch(`${base}/api/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'qualquer', amountCents: 100, tipCents: 0 }),
    });
    expect({ status: pagar.status, code: (await pagar.json()).code }).toEqual({ status: 503, code: 'platform_misconfigured' });
    const webhook = await fetch(`${base}/api/webhooks/psp`, { method: 'POST', body: '{}' });
    expect(webhook.status).toBe(503);
    const recarga = await fetch(`${base}/api/house/load`, { method: 'POST', body: '{}' });
    expect(recarga.status).toBe(503);
    const leitura = await fetch(`${base}/api/check?t=inexistente`);
    expect(leitura.status).not.toBe(503);
  });
});

test('a redenção do saldo devolve o estado da conta pela PROJEÇÃO PÚBLICA', () => {
  // Saía cru: txids reais, motivo e prazo de disputa, e as notas livres do
  // dono (auditoria de backend H2).
  const R = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const i = R.indexOf("url.pathname === '/api/house/redeem'");
  const rota = R.slice(i, R.indexOf("url.pathname === '", i + 40));
  expect(rota).toMatch(/check: \{ \.\.\.conta, state: publicCheckState\(conta\.state\) \}/);
  expect(rota).not.toMatch(/return json\(res, 200, \{ success: true, data \}\);/);
});
