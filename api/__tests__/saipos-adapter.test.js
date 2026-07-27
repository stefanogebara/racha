'use strict';

/**
 * Adaptador Saipos (order-api.saipos.com) — o primeiro POS real do Racha.
 *
 * O que a API dá (doc pública, jul/2026):
 *   POST /auth {idPartner, secret} → token (pedir com parcimônia: excesso = bloqueio)
 *   GET  /sale-status-by-table-or-pad?table=N → a conta viva da mesa
 *   PUT  /close-sale?cod_store&order_id → NÃO registra pagamento; marca a mesa
 *        em laranja pro garçom ir fechar (confirmado na doc)
 *
 * Shapes de resposta NÃO são públicos → parser tolerante + validação real no
 * sandbox quando a credencial chegar. Tudo aqui roda com fetch MOCKADO.
 */

const { createSaiposAdapter } = require('../_lib/pos/saipos');

// fetch fake programável: fila de respostas + registro de chamadas.
function fetchFake(plano) {
  const chamadas = [];
  const fn = async (url, opts = {}) => {
    chamadas.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const próx = plano.shift();
    if (!próx) throw new Error('fetchFake: plano esgotado');
    if (próx.throws) throw próx.throws;
    return {
      ok: próx.status >= 200 && próx.status < 300,
      status: próx.status,
      json: async () => próx.json ?? {},
      text: async () => JSON.stringify(próx.json ?? {}),
    };
  };
  fn.chamadas = chamadas;
  return fn;
}

const CFG = { idPartner: 'partner-x', secret: 's3cr3t', codStore: '42' };
const auth200 = { status: 200, json: { token: 'tok-1' } };

describe('auth — token é cacheado e renovado só quando morre', () => {
  test('duas leituras = UMA chamada de auth (doc: excesso de auth bloqueia)', async () => {
    const f = fetchFake([
      auth200,
      { status: 200, json: { sales: [] } },
      { status: 200, json: { sales: [] } },
    ]);
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    await pos.pullOpenCheck({ table: '12' });
    await pos.pullOpenCheck({ table: '12' });
    const auths = f.chamadas.filter((c) => c.url.endsWith('/auth'));
    expect(auths).toHaveLength(1);
    expect(auths[0].body).toEqual({ idPartner: 'partner-x', secret: 's3cr3t' });
  });

  test('401 na leitura → renova o token UMA vez e refaz; segundo 401 propaga', async () => {
    const f = fetchFake([
      auth200,
      { status: 401, json: {} },       // token morreu
      { status: 200, json: { token: 'tok-2' } },
      { status: 200, json: { sales: [] } },
    ]);
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    await pos.pullOpenCheck({ table: '12' });
    const auths = f.chamadas.filter((c) => c.url.endsWith('/auth'));
    expect(auths).toHaveLength(2);
    // o retry usa o token novo
    const últimaLeitura = f.chamadas[f.chamadas.length - 1];
    expect(últimaLeitura.headers.Authorization).toBe('tok-2');

    const f2 = fetchFake([auth200, { status: 401, json: {} }, auth200, { status: 401, json: {} }]);
    const pos2 = createSaiposAdapter({ ...CFG, fetchImpl: f2 });
    await expect(pos2.pullOpenCheck({ table: '12' })).rejects.toThrow(/401/);
  });
});

describe('pullOpenCheck — a conta viva da mesa vira o shape do Racha', () => {
  // Shape plausível baseado na doc (itens com preço em REAIS decimais — o
  // parser converte pra centavos com arredondamento; validar no sandbox).
  const venda = {
    sales: [{
      order_id: 'ord-77',
      cod_store: '42',
      items: [
        { desc_store_item: 'Picanha na chapa', quantity: 1, unit_price: 89.9 },
        { desc_store_item: 'Chopp', quantity: 4, unit_price: 13.9 },
      ],
      total: 145.5,
    }],
  };

  test('itens e total em centavos, com quantidade multiplicada', async () => {
    const f = fetchFake([auth200, { status: 200, json: venda }]);
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    const out = await pos.pullOpenCheck({ table: '12' });
    expect(out.orderId).toBe('ord-77');
    expect(out.totalCents).toBe(14550);
    expect(out.items).toEqual([
      { id: expect.any(String), name: 'Picanha na chapa', priceCents: 8990 },
      { id: expect.any(String), name: 'Chopp (4x)', priceCents: 5560 },
    ]);
    // a query foi pra mesa certa
    const leitura = f.chamadas.find((c) => c.url.includes('sale-status-by-table-or-pad'));
    expect(leitura.url).toContain('table=12');
  });

  test('mesa sem conta aberta → null (não é erro)', async () => {
    for (const resp of [{ status: 200, json: { sales: [] } }, { status: 404, json: {} }]) {
      const f = fetchFake([auth200, resp]);
      const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
      expect(await pos.pullOpenCheck({ table: '9' })).toBeNull();
    }
  });

  test('resposta com shape inesperado não explode — vira null com aviso', async () => {
    const f = fetchFake([auth200, { status: 200, json: { alguma_coisa: true } }]);
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    expect(await pos.pullOpenCheck({ table: '12' })).toBeNull();
  });

  test('centavos: 3 x 0,10 não vira 0,30000000000000004', async () => {
    const f = fetchFake([auth200, {
      status: 200,
      json: { sales: [{ order_id: 'o1', items: [{ desc_store_item: 'Bala', quantity: 3, unit_price: 0.1 }], total: 0.3 }] },
    }]);
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    const out = await pos.pullOpenCheck({ table: '1' });
    expect(out.items[0].priceCents).toBe(30);
    expect(out.totalCents).toBe(30);
  });
});

describe('writeBackPayment — sinaliza fechamento, NUNCA finge dar baixa', () => {
  test('conta 100% paga → PUT /close-sale com cod_store e order_id', async () => {
    const f = fetchFake([auth200, { status: 200, json: {} }]);
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    const out = await pos.writeBackPayment({ orderId: 'ord-77', fullyPaid: true });
    expect(out.ok).toBe(true);
    expect(out.ref).toBe('ord-77');
    const put = f.chamadas.find((c) => c.url.includes('close-sale'));
    expect(put.method).toBe('PUT');
    expect(put.url).toContain('cod_store=42');
    expect(put.url).toContain('order_id=ord-77');
  });

  test('pagamento PARCIAL não chama a Saipos (garçom iria à mesa à toa)', async () => {
    const f = fetchFake([]); // nenhuma chamada permitida
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    const out = await pos.writeBackPayment({ orderId: 'ord-77', fullyPaid: false });
    expect(out.ok).toBe(true);
    expect(out.skipped).toMatch(/parcial/i);
    expect(f.chamadas).toHaveLength(0);
  });

  test('pedido manual do PDV (sem order_id) → skip declarado, não erro', async () => {
    // Doc: 'Pedidos que são feitos manuais pela Saipos não possuem order_id'.
    const f = fetchFake([]);
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: f });
    const out = await pos.writeBackPayment({ orderId: null, fullyPaid: true });
    expect(out.ok).toBe(true);
    expect(out.skipped).toMatch(/order_id/i);
    expect(f.chamadas).toHaveLength(0);
  });
});

describe('contrato PosAdapter + registro', () => {
  test('capabilities dizem a verdade: pull sim, writeBack como SINALIZAÇÃO', async () => {
    const pos = createSaiposAdapter({ ...CFG, fetchImpl: fetchFake([]) });
    expect(pos.provider).toBe('saipos');
    expect(pos.capabilities.pull).toBe(true);
    // writeBack=true no sentido do router (há ação pós-confirmação), mas a
    // semântica real (sinalizar, não baixar) fica no próprio adapter.
    expect(pos.capabilities.writeBack).toBe(true);
  });

  test('config faltando lança na CRIAÇÃO, não no meio do jantar', () => {
    expect(() => createSaiposAdapter({ secret: 'x', codStore: '1' })).toThrow(/idPartner/);
    expect(() => createSaiposAdapter({ idPartner: 'x', codStore: '1' })).toThrow(/secret/);
    expect(() => createSaiposAdapter({ idPartner: 'x', secret: 'y' })).toThrow(/codStore/);
  });

  test("resolvePosAdapter('saipos') resolve quando a env está completa", () => {
    const { resolvePosAdapter } = require('../_lib/pos/adapter');
    const OLD = { ...process.env };
    try {
      process.env.SAIPOS_ID_PARTNER = 'p';
      process.env.SAIPOS_SECRET = 's';
      process.env.SAIPOS_COD_STORE = '1';
      const pos = resolvePosAdapter({ posProvider: 'saipos' });
      expect(pos.provider).toBe('saipos');
      delete process.env.SAIPOS_ID_PARTNER;
      expect(() => resolvePosAdapter({ posProvider: 'saipos' })).toThrow(/SAIPOS_/);
    } finally {
      process.env.SAIPOS_ID_PARTNER = OLD.SAIPOS_ID_PARTNER;
      process.env.SAIPOS_SECRET = OLD.SAIPOS_SECRET;
      process.env.SAIPOS_COD_STORE = OLD.SAIPOS_COD_STORE;
      for (const k of ['SAIPOS_ID_PARTNER', 'SAIPOS_SECRET', 'SAIPOS_COD_STORE']) {
        if (OLD[k] === undefined) delete process.env[k];
      }
    }
  });
});
