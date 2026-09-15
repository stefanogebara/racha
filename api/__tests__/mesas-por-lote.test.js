'use strict';

/**
 * A LISTA DE MESAS NÃO CRESCE COM A HISTÓRIA DA CASA.
 *
 * `listTables` repassava o razão INTEIRO de cada conta que a casa já teve, uma
 * leitura por conta, em série — a cada carga do /admin, do /qrs, e depois de
 * cada ação numa mesa. Mil contas a ~120 ms por ida são os 120 s do
 * `maxDuration`, e o admin parava de carregar semanas depois de a casa começar
 * (auditoria de onboarding C2, auditoria de backend H3). Agora as FECHADAS são
 * lidas por lote de 200.
 */

const { createSupabaseStore } = require('../_lib/store/supabase');
const recebedor = require('../_lib/pay/recebedor');

/** Um cliente falso do PostgREST: conta as idas por tabela e responde pelo filtro. */
function clienteFalso({ mesas, contas, fechadas }) {
  const idas = [];
  const from = (tabela) => {
    const f = { tabela, filtros: {}, lista: null };
    const b = {
      select() { return b; }, update() { return b; }, order() { return b; }, limit() { return b; },
      single() { return b; }, maybeSingle() { return b; },
      eq(col, val) { f.filtros[col] = val; return b; },
      in(col, vals) { f.lista = vals; return b; },
      then(ok, falha) {
        idas.push(f);
        let data = [];
        if (tabela === 'venue_tables') data = mesas;
        else if (tabela === 'checks') data = contas;
        else if (tabela === 'check_events') data = (f.lista || []).filter((id) => fechadas.has(id)).map((id) => ({ check_id: id }));
        return Promise.resolve({ data, error: null }).then(ok, falha);
      },
    };
    return b;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, idas };
}

const mesa = (id, label) => ({ id, label, qr_token: `qr_${id}`, qr_rotated_at: null, active: true, training: false });

test('as contas fechadas são lidas POR LOTE — 450 contas, três idas, não 450', async () => {
  const contas = Array.from({ length: 450 }, (_, i) => ({ id: `c${i}`, table_id: i < 449 ? 't1' : 't2' }));
  const fechadas = new Set(contas.slice(0, 449).map((c) => c.id));   // a última, da t2, está aberta
  const { client, idas } = clienteFalso({ mesas: [mesa('t1', 'Mesa 1'), mesa('t2', 'Mesa 2')], contas, fechadas });
  const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
  const lista = await store.listTables('v1');
  expect(lista.map((t) => [t.id, t.hasOpenCheck])).toEqual([['t1', false], ['t2', true]]);
  expect(idas.filter((i) => i.tabela === 'check_events').length).toBe(3);
});

test('desativar uma mesa com conta aberta recusa — pelo mesmo lote', async () => {
  const contas = [{ id: 'c1', table_id: 't1' }, { id: 'c2', table_id: 't1' }];
  const { client, idas } = clienteFalso({ mesas: [mesa('t1', 'Mesa 1')], contas, fechadas: new Set(['c1']) });
  const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
  await expect(store.setTableActive('t1', false)).rejects.toThrow(/open check/);
  expect(idas.filter((i) => i.tabela === 'check_events').length).toBe(1);
});

describe('o recebedor — pra onde o dinheiro da casa liquida', () => {
  // Um soluço do adquirente trocava o recebedor ativo de uma casa (auditoria de
  // onboarding, C3).
  test('só um 404 do adquirente é "recebedor inexistente"; timeout e 5xx são "indisponível"', () => {
    expect(recebedor.classificarFalhaDoRecebedor({ httpStatus: 404 })).toEqual({ status: 404, code: 'recipient_not_found' });
    for (const h of [0, 500, 502, 401, undefined]) {
      expect({ h, r: recebedor.classificarFalhaDoRecebedor({ httpStatus: h }) }).toEqual({ h, r: { status: 503, code: 'psp_unavailable' } });
    }
  });
  test('substituir o recebedor de verdade exige pedido EXPLÍCITO', () => {
    const comRecebedor = { pspRecipientId: 're_ativo' };
    expect(recebedor.podeCriarRecebedor(comRecebedor, {})).toEqual({ ok: false, status: 409, code: 'recipient_exists' });
    expect(recebedor.podeCriarRecebedor(comRecebedor, { replace: 'true' })).toEqual({ ok: false, status: 409, code: 'recipient_exists' });
    expect(recebedor.podeCriarRecebedor(comRecebedor, { replace: true })).toEqual({ ok: true, substitui: true });
    expect(recebedor.podeCriarRecebedor({ pspRecipientId: 'rcpt_demo' }, {})).toEqual({ ok: true, substitui: false });
    expect(recebedor.podeCriarRecebedor({ pspRecipientId: null }, {})).toEqual({ ok: true, substitui: false });
  });
  test('a falha na criação sai com código, não com o texto do gateway', () => {
    expect(recebedor.classificarFalhaNaCriacao(Object.assign(new Error('pagarme POST /recipients: {…}'), { httpStatus: 422 })))
      .toEqual({ status: 400, code: 'psp_recipient_rejected' });
    expect(recebedor.classificarFalhaNaCriacao(new TypeError('createRecipient: … obrigatórios'))).toEqual({ status: 400, code: 'recipient_fields_invalid' });
    expect(recebedor.classificarFalhaNaCriacao(Object.assign(new Error('timeout'), { httpStatus: 0 }))).toEqual({ status: 503, code: 'psp_unavailable' });
  });
  test('as rotas usam as regras', () => {
    const R = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '_app', 'router.js'), 'utf8');
    const i = R.indexOf("url.pathname === '/api/psp/recipient'");
    const rotas = R.slice(i, R.indexOf("url.pathname === '/api/psp/stripe-connect'", i));
    expect(rotas).toMatch(/classificarFalhaDoRecebedor\(e\)/);
    expect(rotas).toMatch(/const criacao = podeCriarRecebedor\(venueDoRecebedor, b\);/);
    expect(rotas).toMatch(/classificarFalhaNaCriacao\(e\)/);
  });
});
