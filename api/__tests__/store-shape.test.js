'use strict';

/**
 * O CENSO DE FORMA entre os dois stores — a costura que enganou esta série.
 *
 * O `store-contract.test.js` compara COMPORTAMENTO: abre conta, cobra, confirma,
 * e afirma que os dois stores chegam ao mesmo resultado. Ele é bom e não pegou
 * nada disto, porque o defeito nunca foi de comportamento — foi de CAMPO
 * AUSENTE:
 *
 *  - `getPayment` não trazia os acumulados estornados, então a guarda de versão
 *    do reparo (0023) recebia zero e ficava inerte em toda linha com estorno;
 *  - `listVenueActivation` não trazia `pspRecipientId`, então a perna de
 *    custódia rodava cega e devolvia ALTO pra toda casa, toda noite;
 *  - o `select` do painel perdeu `txid`, e o mapa de sobras virou zero — a
 *    série semanal seguiu contando dívida como receita;
 *  - e a RPC de ativação perdeu `is_test` quando eu a reescrevi a partir de um
 *    arquivo que já havia derivado da produção.
 *
 * Todos passaram porque o store de MEMÓRIA devolve o objeto inteiro que tem na
 * mão, enquanto o do Supabase devolve só o que o `select` pediu. O dublê relata
 * MAIS que a produção — a armadilha ao contrário da que este repositório já
 * documentava.
 *
 * Este arquivo dirige o store do SUPABASE com um cliente falso encadeável e
 * compara o conjunto de chaves com o de memória. Sem credencial, sem rede, e
 * pega a classe inteira. Achado pelas revisões de 2026-09-08.
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { createSupabaseStore } = require('../_lib/store/supabase');

/**
 * Cliente PostgREST falso: encadeia qualquer método e resolve na linha dada.
 * `maybeSingle`/`single` devolvem a primeira; o resto devolve a lista.
 */
/**
 * Cliente PostgREST falso que HONRA o `select`.
 *
 * A primeira versão ignorava `.select()` e devolvia a linha inteira que o teste
 * escrevia à mão — então o censo não podia detectar a classe pela qual ele foi
 * escrito. Provado por mutação: apagar `venue_id, amount_cents, tip_cents,
 * currency, confirmed_amount_cents, confirmed_tip_cents` do `select` do
 * `getPayment`, ou `txid` do `select` do painel (que é O defeito que a rodada
 * anterior consertou), deixava a suíte inteira VERDE.
 *
 * Duas causas, as duas fechadas aqui: o `select` era ignorado, e a comparação
 * era `Object.keys`, que lista chave com valor `undefined` — o mapeador atribui
 * `venueId: data.venue_id` sem condição, então a chave existe mesmo quando a
 * coluna nunca foi pedida.
 *
 * Agora a linha é PROJETADA pelo `select`, e a comparação só conta chave com
 * valor definido. Achado pela revisão de segurança de 2026-09-09.
 */
function fakeClient(rows) {
  let colunas = null;   // o último `.select(...)` visto

  const projeta = (linha) => {
    if (!linha || !colunas) return linha;
    const pedidas = colunas.split(',').map((c) => c.trim()).filter(Boolean);
    if (pedidas.includes('*')) return linha;
    return Object.fromEntries(
      pedidas.filter((c) => c in linha).map((c) => [c, linha[c]]),
    );
  };
  const lista = () => (Array.isArray(rows) ? rows.map(projeta) : projeta(rows));

  const thenable = {
    then: (res) => Promise.resolve({ data: lista(), error: null }).then(res),
    catch: () => thenable,
  };
  const builder = new Proxy(thenable, {
    get(t, prop) {
      if (prop === 'then' || prop === 'catch') return t[prop];
      if (prop === 'select') {
        return (cols) => { colunas = typeof cols === 'string' ? cols : null; return builder; };
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return async () => ({
          data: projeta(Array.isArray(rows) ? rows[0] : rows), error: null,
        });
      }
      return () => builder;
    },
  });
  return { from: () => builder, rpc: async () => ({ data: rows, error: null }) };
}

/**
 * Chaves com valor DEFINIDO.
 *
 * `Object.keys` lista `{ venueId: undefined }` — e o mapeador do Supabase
 * atribui todo campo sem condição, então uma coluna ausente do `select`
 * aparecia como chave presente. A comparação media a existência da linha de
 * código, não a chegada do dado.
 */
const chaves = (o) => (o ? Object.keys(o).filter((k) => o[k] !== undefined).sort() : []);

describe('os dois stores devolvem a MESMA forma', () => {
  test('getPayment', async () => {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'B', servicoBp: 1000, pspRecipientId: 're_x' });
    const table = await store.seedTable(venue.id, 'M1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 5000 }]);
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 5000, tipCents: 500,
      payerLabel: 'Ana', method: 'pix',
    });
    await store.recordPayment({
      txid: 'ch_1', status: 'confirmado', confirmedAt: '2026-01-01T00:00:00Z',
      confirmedAmountCents: 5000, confirmedTipCents: 500,
    });
    const doMemoria = await store.getPayment('ch_1');

    const sup = createSupabaseStore({
      // A linha COMO A PRODUÇÃO devolveria: todas as colunas da tabela. Se o
      // `select` pedir menos, a projeção do cliente falso entrega menos — que
      // é o ponto do censo.
      client: fakeClient([{
        txid: 'ch_1', check_id: check.id, venue_id: venue.id,
        amount_cents: 5000, tip_cents: 500, currency: 'BRL',
        confirmed_amount_cents: 5000, confirmed_tip_cents: 500,
        payer_label: 'Ana', status: 'confirmado', method: 'pix', psp_payload_masked: null,
        confirmed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
        refunded_amount_cents: 0, refunded_tip_cents: 0,
      }]),
    });
    const doSupabase = await sup.getPayment('ch_1');

    /**
     * O de MEMÓRIA pode ter campos a mais (ele guarda a linha inteira). O que
     * não pode acontecer é o contrário: um campo que o de memória devolve e o
     * do Supabase não, porque é nele que o código de dinheiro confia.
     */
    const soNoMemoria = chaves(doMemoria).filter((k) => !chaves(doSupabase).includes(k));
    expect(soNoMemoria).toEqual([]);
  });

  test('listVenueActivation', async () => {
    const store = createMemoryStore();
    await store.seedVenue({ name: 'B', servicoBp: 1000, pspRecipientId: 're_x' });
    const [doMemoria] = await store.listVenueActivation();

    const sup = createSupabaseStore({
      client: fakeClient([{
        id: 'v1', name: 'B', created_at: '2026-01-01T00:00:00Z', is_test: false,
        recebedor_ok: true, psp_recipient_id: 're_x', psp_recipient_status: 'active',
        mesas_reais: 1, mesas_total: 1, contas: 0, pagos_confirmados: 0,
        valor_cents: 0, ultimo_pagamento: null,
      }]),
    });
    const [doSupabase] = await sup.listVenueActivation();

    const soNoMemoria = chaves(doMemoria).filter((k) => !chaves(doSupabase).includes(k));
    expect(soNoMemoria).toEqual([]);
    // E o campo que faltava, explicitamente: a perna de custódia depende dele.
    expect(chaves(doSupabase)).toContain('pspRecipientId');
    expect(chaves(doSupabase)).toContain('isTest');
  });

  test('listRecentConfirmedCharges', async () => {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'B', servicoBp: 1000, pspRecipientId: 're_x' });
    const table = await store.seedTable(venue.id, 'M1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 5000 }]);
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 5000, tipCents: 500, method: 'pix',
    });
    await store.recordPayment({ txid: 'ch_1', status: 'confirmado', confirmedAt: new Date().toISOString() });
    const [doMemoria] = await store.listRecentConfirmedCharges(venue.id, {});

    const sup = createSupabaseStore({
      client: fakeClient([{
        txid: 'ch_1', check_id: check.id, amount_cents: 5000, tip_cents: 500,
        confirmed_amount_cents: 5000, confirmed_tip_cents: 500, method: 'pix',
        confirmed_at: new Date().toISOString(),
      }]),
    });
    const [doSupabase] = await sup.listRecentConfirmedCharges('v1', {});

    expect(chaves(doMemoria).filter((k) => !chaves(doSupabase).includes(k))).toEqual([]);
  });

  test('listChecksForReconcile: as LINHAS de pagamento têm a mesma forma', async () => {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'B', servicoBp: 1000, pspRecipientId: 're_x' });
    const table = await store.seedTable(venue.id, 'M1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 5000 }]);
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 5000, tipCents: 500, method: 'pix',
    });
    await store.recordPayment({ txid: 'ch_1', status: 'confirmado', confirmedAt: new Date().toISOString() });
    const [contaMemoria] = await store.listChecksForReconcile(venue.id);

    const sup = createSupabaseStore({
      client: fakeClient([{
        id: check.id,
        // `check_id`: as duas leituras (razão e pagamentos) vêm POR LOTE e
        // agrupam por esta coluna — sem ela a linha cai num balde inexistente
        // e a forma comparada aqui seria a de uma lista vazia.
        check_id: check.id,
        // `opened_at`: a conciliação lê a idade da conta pra separar a que
        // está abrindo agora da órfã (`conta-sem-opened.js`).
        opened_at: new Date().toISOString(),
        status: 'aberta',
        txid: 'ch_1', amount_cents: 5000, tip_cents: 500,
        confirmed_amount_cents: 5000, confirmed_tip_cents: 500,
        refunded_amount_cents: 0, refunded_tip_cents: 0,
        status: 'confirmado', method: 'pix', currency: 'BRL',
        confirmed_at: new Date().toISOString(),
        seq: 1, type: 'OPENED', payload: {},
      }]),
    });
    const [contaSupabase] = await sup.listChecksForReconcile('v1');

    expect(chaves(contaMemoria).filter((k) => !chaves(contaSupabase).includes(k))).toEqual([]);
    const soNoMemoria = chaves(contaMemoria.payments[0])
      .filter((k) => !chaves(contaSupabase.payments[0]).includes(k));
    expect(soNoMemoria).toEqual([]);
  });

  test('listPendingCharges', async () => {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'B', servicoBp: 1000, pspRecipientId: 're_x' });
    const table = await store.seedTable(venue.id, 'M1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 5000 }]);
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 5000, tipCents: 500, method: 'pix',
    });
    const [doMemoria] = await store.listPendingCharges({ checkId: check.id });

    const sup = createSupabaseStore({
      client: fakeClient([{
        txid: 'ch_1', check_id: check.id, amount_cents: 5000, tip_cents: 500,
        method: 'pix', currency: 'BRL', created_at: new Date().toISOString(),
      }]),
    });
    const [doSupabase] = await sup.listPendingCharges({});

    expect(chaves(doMemoria).filter((k) => !chaves(doSupabase).includes(k))).toEqual([]);
  });
});
