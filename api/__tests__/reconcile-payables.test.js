'use strict';

/**
 * A TERCEIRA PERNA: o razão do adquirente contra o nosso.
 *
 * As duas pernas antigas não são independentes — uma é projeção da outra,
 * escritas pela mesma variável na mesma chamada. Os recebíveis são escritos
 * pela Pagar.me, e é isso que os torna testemunha.
 *
 * O invariante é o inegociável #4 literal: todo o dinheiro vai pra subconta do
 * restaurante. Um recebível de crédito em nome de outro recebedor é
 * conta-bolsão — o que muda o perímetro regulatório da Racha (BACEN Res.
 * 494/2025), não só um número.
 */

const { reconcilePayables } = require('../_lib/checks/reconcile-payables');

const CASA = 're_casa123';
const cred = (recipientId, amountCents, feeCents = 0) =>
  ({ recipientId, amountCents, feeCents, type: 'credit', status: 'waiting_funds' });

describe('recebíveis: o dinheiro foi todo pra casa?', () => {
  test('cobrança normal: `amount` é o BRUTO e a taxa é desconto', () => {
    // A documentação do recebível: `amount` é "valor em centavos que foi pago",
    // `fee` é "valor em centavos que foi cobrado (taxa)", e o recebedor fica
    // com `amount - fee`.
    //
    // Este teste afirmava o contrário — que `amount` vinha líquido e que
    // `amount + fee` reconstruía o capturado. Ele ficaria verde enquanto a
    // produção acusava crítico em toda cobrança saudável.
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 3390,
      payables: [cred(CASA, 3390, 120)],   // bruto 3390, líquido 3270
    });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  test('taxa maior que o recebível é crítico — líquido negativo não passa', () => {
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 100,
      payables: [cred(CASA, 100, 500)],
    });
    expect(r.findings.some((x) => x.code === 'payable_net_negative')).toBe(true);
  });

  test('tipo DESCONHECIDO é alto, não crédito por padrão', () => {
    // `(type || 'credit') === 'credit'` fazia tipo novo virar crédito e
    // envenenar a soma.
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 3390,
      payables: [cred(CASA, 3390, 0), { recipientId: CASA, amountCents: -100, feeCents: 0, type: 'coisa_nova' }],
    });
    expect(r.findings.some((x) => x.code === 'payable_type_unknown')).toBe(true);
  });

  test('recebível SEM recebedor é alto — o destino não é nomeável', () => {
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 3390,
      payables: [{ recipientId: null, amountCents: 3390, feeCents: 0, type: 'credit' }],
    });
    expect(r.findings.some((x) => x.code === 'payable_no_recipient_field')).toBe(true);
    expect(r.ok).toBe(false);
  });

  test('um centavo de recebível pra OUTRO recebedor é CRÍTICO', () => {
    // O caso que a pergunta de custódia levanta: o split é `flat` pelo valor
    // PEDIDO, o cliente pagou a mais, e a sobra caiu em outro lugar.
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 20000,
      payables: [cred(CASA, 11000, 120), cred('re_racha', 9000, 0)],
    });
    const f = r.findings.find((x) => x.code === 'custody_leak');
    expect(f).toBeDefined();
    expect(f.severity).toBe('critical');
    expect(f.recipientId).toBe('re_racha');
    expect(f.amountCents).toBe(9000);
    expect(r.ok).toBe(false);
  });

  test('a casa recebendo MENOS que o capturado é crítico mesmo sem recebedor estranho', () => {
    // A sobra pode simplesmente não gerar recebível pra ninguém que a gente
    // veja. O invariante do valor pega isso de todo jeito.
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 20000,
      payables: [cred(CASA, 11000, 120)],
    });
    const f = r.findings.find((x) => x.code === 'payable_amount_mismatch');
    expect(f.severity).toBe('critical');
    expect(f.deltaCents).toBe(9000);
  });

  test('um centavo de diferença é arredondamento de taxa, não notícia', () => {
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 3390,
      payables: [cred(CASA, 3389, 120)],
    });
    expect(r.findings.find((x) => x.code === 'payable_amount_mismatch').severity).toBe('info');
    expect(r.ok).toBe(true);
  });

  test('estorno e chargeback não contam como destino do dinheiro', () => {
    // `type: 'refund'` é dinheiro VOLTANDO. Contá-lo como crédito faria toda
    // cobrança estornada parecer vazamento de custódia.
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 3390,
      payables: [
        cred(CASA, 3390, 120),
        { recipientId: 're_racha', amountCents: -3390, feeCents: 0, type: 'refund' },
      ],
    });
    expect(r.findings).toEqual([]);
  });

  test('nenhum recebível ainda é INFORMATIVO — latência, não prova de nada', () => {
    // O recebível nasce depois da liquidação. Isso não pode acender o alerta,
    // e também não pode passar como "conferido".
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: CASA, paidAmountCents: 3390, payables: [],
    });
    expect(r.findings[0].code).toBe('payables_absent');
    expect(r.findings[0].severity).toBe('info');
    expect(r.ok).toBe(true);
  });

  test('casa sem recebedor conhecido é CEGO, e cego não é verde', () => {
    const r = reconcilePayables({
      chargeId: 'ch_1', venueRecipientId: null, paidAmountCents: 3390,
      payables: [cred(CASA, 3390, 0)],
    });
    expect(r.findings[0].code).toBe('payables_no_recipient');
    expect(r.ok).toBe(false);
  });

  test('entrada esquisita não estoura — a conciliação é TOTAL', () => {
    for (const p of [null, undefined, [], [null], [{}]]) {
      expect(() => reconcilePayables({
        chargeId: 'ch_x', venueRecipientId: CASA, paidAmountCents: 100, payables: p,
      })).not.toThrow();
    }
  });
});

describe('a perna chega ao ALERTA diário, não só ao cálculo', () => {
  const { reconcileOneVenue, reconcilePayablesLeg, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');
  const { reconcileAllVenues } = require('../_lib/checks/reconcile-daily');

  const storeVazio = (cobrancas) => ({
    listChecksForReconcile: async () => [],
    listHouseAccountsForReconcile: async () => [],
    listRecentConfirmedCharges: async () => cobrancas,
    listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: CASA }],
    listOpenOrphanMoneyEvents: async () => [],
  });

  test('vazamento de custódia pinta a casa de CRÍTICO e sai no alerta', async () => {
    const store = storeVazio([{ txid: 'ch_1', checkId: 'c1', paidAmountCents: 20000, method: 'pix' }]);
    const psp = {
      listChargePayables: async () => [cred(CASA, 11000, 120), cred('re_racha', 9000, 0)],
    };
    const r = await reconcileAllVenues(store, { psp });
    expect(r.worstSeverity).toBe('critical');
    const msg = formatReconcileAlert(r);
    expect(msg).toMatch(/dinheiro fora da subconta/);
  });

  test('sem PSP a varredura segue — a perna some, o resto não quebra', async () => {
    const store = storeVazio([{ txid: 'ch_1', checkId: 'c1', paidAmountCents: 20000, method: 'pix' }]);
    const r = await reconcileAllVenues(store, {});   // nenhum psp
    expect(r.worstSeverity).toBe('ok');
    expect(r.venuesRed).toBe(0);
  });

  test('adquirente fora do ar é `info`, não silêncio nem falso crítico', async () => {
    const store = storeVazio([{ txid: 'ch_1', checkId: 'c1', paidAmountCents: 3390, method: 'pix' }]);
    const psp = { listChargePayables: async () => { throw new Error('502 bad gateway'); } };
    const achados = await reconcilePayablesLeg(store, psp, { id: 'v1', pspRecipientId: CASA }, {});
    expect(achados).toHaveLength(1);
    expect(achados[0].code).toBe('payables_unchecked');
    expect(achados[0].severity).toBe('info');
  });

  test('carteira da casa não passa por adquirente e fica fora da conferência', async () => {
    // `house_account` é saldo interno: não tem recebível, e cobrá-lo geraria
    // um `payables_absent` em toda mesa que pagou com saldo.
    const store = {
      ...storeVazio([]),
      listRecentConfirmedCharges: async () => [],   // o store já filtra
    };
    const psp = { listChargePayables: async () => [] };
    const achados = await reconcilePayablesLeg(store, psp, { id: 'v1', pspRecipientId: CASA }, {});
    expect(achados).toEqual([]);
  });

  test('a janela e o teto são respeitados — a varredura não vira mil chamadas', async () => {
    const chamadas = [];
    const store = {
      ...storeVazio([]),
      listRecentConfirmedCharges: async (_v, opts) => { chamadas.push(opts); return []; },
    };
    await reconcilePayablesLeg(store, { listChargePayables: async () => [] },
      { id: 'v1', pspRecipientId: CASA }, { sinceIso: '2026-09-07T00:00:00Z', limit: 25 });
    expect(chamadas[0]).toEqual({ sinceIso: '2026-09-07T00:00:00Z', limit: 25 });
  });
});

test('o store FILTRA carteira da casa: ela não tem recebível', async () => {
  const { createMemoryStore } = require('../_lib/store/memory');
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: CASA });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 5000 }]);
  await store.registerCharge({ checkId: check.id, txid: 'ch_pix', amountCents: 2000, tipCents: 0, method: 'pix' });
  await store.registerCharge({ checkId: check.id, txid: 'ha_saldo', amountCents: 3000, tipCents: 0, method: 'house_account' });
  for (const txid of ['ch_pix', 'ha_saldo']) {
    await store.recordPayment({ txid, status: 'confirmado', confirmedAt: new Date().toISOString() });
  }
  const lista = await store.listRecentConfirmedCharges(venue.id, {});
  expect(lista.map((x) => x.txid)).toEqual(['ch_pix']);
});

describe('a perna não pode ser desligada em silêncio', () => {
  /**
   * O achado agregado da rodada anterior ficou CALCULADO e não RELATADO por uma
   * linha que faltava no `reconcile-daily`. Um censo é mais barato que descobrir
   * isso na terceira revisão.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');

  test('o job diário monta os achados com TODAS as pernas', () => {
    const src = fs.readFileSync(path.join(raiz, '_lib', 'checks', 'reconcile-daily.js'), 'utf8');
    const bloco = src.match(/const findings = \[([\s\S]*?)\];/);
    expect(bloco).not.toBeNull();
    for (const perna of ['checkFindings', 'houseFindings', 'venueFindings', 'payables']) {
      expect(bloco[1]).toContain(perna);
    }
  });

  test('a rota do cron PASSA o psp — sem ele a perna existe e não roda', () => {
    const src = fs.readFileSync(path.join(raiz, '_app', 'router.js'), 'utf8');
    const i = src.indexOf('reconcileAllVenues(store,');
    expect(i).toBeGreaterThan(0);
    const chamada = src.slice(i, i + 900);
    expect(chamada).toMatch(/\bpsp,/);
    expect(chamada).toMatch(/sinceIso/);
    expect(chamada).toMatch(/limit/);
  });

  test('o adaptador de produção implementa a leitura de recebíveis', () => {
    const { createPagarmePsp } = require('../_lib/pay/pagarme-psp');
    const psp = createPagarmePsp({ secretKey: 'sk_test_x', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }) });
    expect(typeof psp.listChargePayables).toBe('function');
  });

  test('id fora do padrão não vira chamada de API', async () => {
    const { createPagarmePsp } = require('../_lib/pay/pagarme-psp');
    const chamadas = [];
    const psp = createPagarmePsp({
      secretKey: 'sk_test_x',
      fetchImpl: async (u) => { chamadas.push(u); return { ok: true, status: 200, text: async () => '[]' }; },
    });
    expect(await psp.listChargePayables('mock123')).toEqual([]);
    expect(await psp.listChargePayables(null)).toEqual([]);
    expect(chamadas).toHaveLength(0);
  });

  test('a resposta do adquirente é NORMALIZADA — snake_case não vaza pro puro', async () => {
    const { createPagarmePsp } = require('../_lib/pay/pagarme-psp');
    const psp = createPagarmePsp({
      secretKey: 'sk_test_x',
      fetchImpl: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ data: [
          { recipient_id: 're_a', amount: 3270, fee: 120, type: 'credit', status: 'paid', charge_id: 'ch_1' },
        ] }),
      }),
    });
    expect(await psp.listChargePayables('ch_1')).toEqual([
      { recipientId: 're_a', amountCents: 3270, feeCents: 120, type: 'credit', status: 'paid', chargeId: 'ch_1' },
    ]);
  });
});

describe('a perna sabe a diferença entre CONFERIDO e não-verificável', () => {
  const { reconcilePayablesLeg } = require('../_lib/checks/reconcile-daily');

  const storeCom = (n) => ({
    listRecentConfirmedCharges: async () => Array.from({ length: n }, (_, i) => ({
      txid: `ch_${i}`, checkId: 'c1', paidAmountCents: 3390, method: 'pix',
    })),
  });

  test('nada verificado a noite inteira é ALTO, não um relatório verde', async () => {
    /**
     * `payables_absent` e `payables_unchecked` são `info` um por um, e devem
     * ser: o recebível nasce depois da liquidação e um 502 não é achado de
     * dinheiro. Mas isso fazia "verificou tudo" e "não verificou NADA" saírem
     * no mesmo verde. O que distingue é o agregado — a mesma forma do serviço
     * nunca arrecadado.
     */
    const achados = await reconcilePayablesLeg(
      storeCom(10), { listChargePayables: async () => [] },
      { id: 'v1', pspRecipientId: CASA }, {},
    );
    const f = achados.find((x) => x.code === 'payables_never_verified');
    expect(f).toBeDefined();
    expect(f.severity).toBe('high');
    expect(f.considered).toBe(10);
  });

  test('amostra pequena não acusa — duas cobranças recentes é latência normal', async () => {
    const achados = await reconcilePayablesLeg(
      storeCom(2), { listChargePayables: async () => [] },
      { id: 'v1', pspRecipientId: CASA }, {},
    );
    expect(achados.some((x) => x.code === 'payables_never_verified')).toBe(false);
  });

  test('uma verificada entre dez já tira o achado agregado', async () => {
    let n = 0;
    const achados = await reconcilePayablesLeg(
      storeCom(10),
      { listChargePayables: async () => (n++ === 0 ? [cred(CASA, 3390, 0)] : []) },
      { id: 'v1', pspRecipientId: CASA }, {},
    );
    expect(achados.some((x) => x.code === 'payables_never_verified')).toBe(false);
  });

  test('o ORÇAMENTO de tempo corta e DIZ quantas ficaram', async () => {
    // Sem orçamento, 30 casas × 25 cobranças matam a função na plataforma — e
    // uma função morta não produz relatório nem alerta: o caminho silencioso.
    const achados = await reconcilePayablesLeg(
      storeCom(10),
      { listChargePayables: async () => { await new Promise((r) => setTimeout(r, 12)); return [cred(CASA, 3390, 0)]; } },
      { id: 'v1', pspRecipientId: CASA }, { budgetMs: 25 },
    );
    const f = achados.find((x) => x.code === 'payables_unchecked' && x.unchecked > 0);
    expect(f).toBeDefined();
    expect(f.message).toMatch(/sem conferir/);
  });
});
