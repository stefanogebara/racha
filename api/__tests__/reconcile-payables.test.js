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
    listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: CASA, isTest: false, recebedorOk: true }],
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
    const achados = await reconcilePayablesLeg(store, psp, { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, {});
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
    const achados = await reconcilePayablesLeg(store, psp, { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, {});
    expect(achados).toEqual([]);
  });

  test('a janela e o teto são respeitados — a varredura não vira mil chamadas', async () => {
    const chamadas = [];
    const store = {
      ...storeVazio([]),
      listRecentConfirmedCharges: async (_v, opts) => { chamadas.push(opts); return []; },
    };
    await reconcilePayablesLeg(store, { listChargePayables: async () => [] },
      { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, { sinceIso: '2026-09-07T00:00:00Z', limit: 25 });
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
    // SEM COMENTÁRIO antes de fatiar: o censo lê CÓDIGO. Uma janela de N
    // caracteres sobre o fonte cru mede o tamanho da explicação, não o da
    // chamada — comentar melhor a chamada quebrava o teste dela.
    const src = fs.readFileSync(path.join(raiz, '_app', 'router.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const i = src.indexOf('reconcileAllVenues(store,');
    expect(i).toBeGreaterThan(0);
    const chamada = src.slice(i, i + 1400);
    expect(chamada).toMatch(/\bpsp,/);
    expect(chamada).toMatch(/sinceIso/);
    expect(chamada).toMatch(/limit/);
    // A janela dá pra apontar pra trás: sem isso a perna de custódia roda
    // contra as últimas 24h pra sempre, e as cobranças reais são de julho.
    expect(chamada).toMatch(/searchParams\.get\('since'\)/);
    // E o interruptor: a perna precisa poder ser desligada sem deploy, porque
    // é a única coisa desta série que faz I/O externo dentro do cron.
    expect(chamada).toMatch(/RACHA_PAYABLES_LEG/);
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
    // MARCADOR, não `[]`: `[]` é a resposta de uma cobrança REAL cujo recebível
    // ainda não nasceu, e confundir as duas fazia um txid `mock*` sair como
    // "nenhum recebível ainda" — um "ainda" que nunca vai chegar.
    expect(await psp.listChargePayables('mock123')).toEqual({ notFromAcquirer: true });
    expect(await psp.listChargePayables(null)).toEqual({ notFromAcquirer: true });
    expect(chamadas).toHaveLength(0);
  });

  test('e a perna traduz o marcador em achado próprio, não em latência', () => {
    const { reconcilePayables } = require('../_lib/checks/reconcile-payables');
    const { findings } = reconcilePayables({
      chargeId: 'mock123', paidAmountCents: 23710, venueRecipientId: CASA,
      payables: { notFromAcquirer: true },
    });
    const f = findings.find((x) => x.code === 'charge_not_from_acquirer');
    expect(f).toBeTruthy();
    expect(f.severity).toBe('high');
    // E NÃO diz "ainda".
    expect(findings.some((x) => x.code === 'payables_absent')).toBe(false);
  });

  test('cobrança REAL sem recebível segue sendo latência (`info`)', () => {
    const { reconcilePayables } = require('../_lib/checks/reconcile-payables');
    const { findings } = reconcilePayables({
      chargeId: 'ch_real', paidAmountCents: 23710, venueRecipientId: CASA, payables: [],
    });
    expect(findings.some((x) => x.code === 'payables_absent' && x.severity === 'info')).toBe(true);
    expect(findings.some((x) => x.code === 'charge_not_from_acquirer')).toBe(false);
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
      { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, {},
    );
    const f = achados.find((x) => x.code === 'payables_never_verified');
    expect(f).toBeDefined();
    expect(f.severity).toBe('high');
    expect(f.considered).toBe(10);
  });

  test('amostra pequena não acusa — duas cobranças recentes é latência normal', async () => {
    const achados = await reconcilePayablesLeg(
      storeCom(2), { listChargePayables: async () => [] },
      { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, {},
    );
    expect(achados.some((x) => x.code === 'payables_never_verified')).toBe(false);
  });

  test('uma verificada entre dez já tira o achado agregado', async () => {
    let n = 0;
    const achados = await reconcilePayablesLeg(
      storeCom(10),
      { listChargePayables: async () => (n++ === 0 ? [cred(CASA, 3390, 0)] : []) },
      { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, {},
    );
    expect(achados.some((x) => x.code === 'payables_never_verified')).toBe(false);
  });

  test('o ORÇAMENTO de tempo corta e DIZ quantas ficaram', async () => {
    // Sem orçamento, 30 casas × 25 cobranças matam a função na plataforma — e
    // uma função morta não produz relatório nem alerta: o caminho silencioso.
    const achados = await reconcilePayablesLeg(
      storeCom(10),
      { listChargePayables: async () => { await new Promise((r) => setTimeout(r, 12)); return [cred(CASA, 3390, 0)]; } },
      { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, { budgetMs: 25 },
    );
    const f = achados.find((x) => x.code === 'payables_unchecked' && x.unchecked > 0);
    expect(f).toBeDefined();
    expect(f.message).toMatch(/sem conferir/);
  });
});

test('a perna tem INTERRUPTOR — `RACHA_PAYABLES_LEG=off` desliga sem deploy', () => {
  /**
   * É a única coisa desta série que faz I/O externo dentro do cron: N chamadas
   * a um terceiro numa função com limite de tempo. O modo de falha é a
   * varredura morrer calada, e varredura morta não conta nada a ninguém. Um
   * caminho que pode emudecer o canário precisa de um jeito de desligar mais
   * rápido que um deploy.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const i = src.indexOf('reconcileAllVenues(store,');
  const chamada = src.slice(i, i + 1200);
  expect(chamada).toMatch(/RACHA_PAYABLES_LEG === 'off'/);
  // Desligada, a varredura roda sem `psp` — e a perna some sem quebrar nada,
  // que é o caso já coberto acima ("sem PSP a varredura segue").
  expect(chamada).toMatch(/\bpsp,/);
});

test('DESLIGAR a perna muda o relatório — não é silêncio', async () => {
  /**
   * Com o interruptor em `off` o relatório saía idêntico a uma noite saudável:
   * `ok`, zero casas vermelhas, alerta nenhum — e o `custody_leak`, o achado
   * que responde a pergunta do inegociável #4, simplesmente não existia. É o
   * estado em que alguém entra numa madrugada e nunca mais sai.
   *
   * O teste anterior deste bloco afirmava que a STRING `RACHA_PAYABLES_LEG`
   * aparecia no fonte da rota. Provava que o interruptor existe; não podia
   * falhar se apertá-lo fosse silencioso.
   */
  const { reconcilePayablesLeg, reconcileAllVenues, formatReconcileAlert } =
    require('../_lib/checks/reconcile-daily');

  const achados = await reconcilePayablesLeg(
    { listRecentConfirmedCharges: async () => [] }, null,
    { id: 'v1', pspRecipientId: CASA, isTest: false, recebedorOk: true }, { legDisabled: true },
  );
  expect(achados).toHaveLength(1);
  expect(achados[0].code).toBe('payables_leg_disabled');
  expect(achados[0].severity).toBe('high');

  // E o relatório inteiro deixa de sair verde.
  const store = {
    listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: CASA, isTest: false, recebedorOk: true }],
    listChecksForReconcile: async () => [],
    listHouseAccountsForReconcile: async () => [],
    listOpenOrphanMoneyEvents: async () => [],
    listRecentConfirmedCharges: async () => [],
  };
  const desligada = await reconcileAllVenues(store, { legDisabled: true });
  expect(desligada.worstSeverity).toBe('high');
  expect(formatReconcileAlert(desligada)).toMatch(/DESLIGADA/);

  // Sem o interruptor, e sem psp por outro motivo, segue silêncio legítimo.
  const semPsp = await reconcileAllVenues(store, {});
  expect(semPsp.worstSeverity).toBe('ok');
});

/**
 * RECEBEDOR DE MENTIRA NUMA CASA DE PRODUÇÃO.
 *
 * `seedVenue` põe `pspRecipientId: 'rcpt_demo'` por padrão, e `isDemoVenue`
 * exige as DUAS marcas (`isTest === true` E o placeholder). Uma casa semeada
 * sem `isTest` fica com o placeholder e SEM a identidade de demo: a varredura
 * noturna a trata como produção, e o adquirente não conhece esse id.
 *
 * Medido em produção em 2026-09-10, na primeira execução real da perna: das 9
 * casas conferidas, 7 eram semeadas com `rcpt_demo` sem `isTest`; as duas
 * únicas com recebedor de verdade estavam marcadas `isTest` e ficaram FORA. O
 * controle do inegociável #4 apontado só pra onde ele não pode funcionar.
 */
describe('casa de produção com recebedor inutilizável', () => {
  const { reconcilePayablesLeg } = require('../_lib/checks/reconcile-daily');

  const pspQualquer = { listChargePayables: async () => [] };
  /**
   * O duplo espelha o store: `contarCobrancasConfirmadas` SEM janela (é uma
   * propriedade permanente da casa) e `listRecentConfirmedCharges` COM janela.
   * A primeira versão deste duplo ignorava as opções por inteiro, então
   * `sinceIso` era invisível aos cinco casos — e era justamente o parâmetro que
   * decidia se o guarda voltava a rodar no dia seguinte.
   */
  /**
   * A ASSINATURA é a da produção: `(venueId, { sinceIso, limit })`.
   *
   * A primeira versão deste duplo era `async ({ sinceIso } = {})` — um
   * argumento. A chamada real passa DOIS, então o duplo recebia `venue.id` no
   * lugar das opções, desestruturava `sinceIso` de uma string, achava
   * `undefined`, e devolvia a contagem cheia. Resultado: o teste que eu escrevi
   * pra pegar a regressão da janela não pegava — a mutação que faz o guarda
   * contar pela janela passava verde. Duplo com aridade errada é duplo que
   * responde outra pergunta.
   */
  const storeCom = (n, naJanela = n) => ({
    contarCobrancasConfirmadas: async () => n,
    listRecentConfirmedCharges: async (_venueId, { sinceIso } = {}) =>
      Array.from({ length: sinceIso ? naJanela : n }, (_, i) => ({
        txid: `ch_${i}`, paidAmountCents: 1000,
      })),
  });

  test('placeholder + cobrança confirmada = `high`, e a perna PARA aí', async () => {
    const achados = await reconcilePayablesLeg(
      storeCom(3), pspQualquer,
      { id: 'v1', pspRecipientId: 'rcpt_demo', isTest: false, recebedorOk: false },
      { custodyChecks: true },
    );
    expect(achados).toHaveLength(1);
    expect(achados[0].code).toBe('venue_recipient_unusable');
    expect(achados[0].severity).toBe('high');
    expect(achados[0].charges).toBe(3);
    // E não sai um monte de `payables_absent` por cima: a pergunta já foi
    // respondida, e responder duas vezes vira ruído.
    expect(achados.some((f) => f.code === 'payables_absent')).toBe(false);
  });

  test('SEM recebedor e com cobrança confirmada, idem', async () => {
    const achados = await reconcilePayablesLeg(
      storeCom(1), pspQualquer, { id: 'v1', pspRecipientId: null, isTest: false, recebedorOk: false },
      { custodyChecks: true },
    );
    expect(achados[0].code).toBe('venue_recipient_unusable');
    expect(achados[0].recipientId).toBe(null);
  });

  test('a JANELA vazia no dia seguinte não cala o guarda', async () => {
    /**
     * A regressão que a compliance descreveu, agora com teste. `storeCom(3, 0)`
     * é a casa que confirmou 3 cobranças na vida e NENHUMA nas últimas 24h — o
     * estado de produção no dia seguinte, com as cobranças de julho fora da
     * janela do cron. A primeira versão do guarda contava pela janela e ficava
     * muda; ela disparou no meu ensaio só porque eu passei `?since=`.
     */
    const achados = await reconcilePayablesLeg(
      storeCom(3, 0), pspQualquer,
      { id: 'v1', pspRecipientId: 'rcpt_demo', isTest: false, recebedorOk: false },
      { sinceIso: '2026-09-09T00:00:00Z', custodyChecks: true },
    );
    const f = achados.find((x) => x.code === 'venue_recipient_unusable');
    expect(f).toBeTruthy();
    expect(f.charges).toBe(3);   // a contagem é da VIDA, não da janela
  });

  test('casa de TESTE com placeholder é normal — não acusa', async () => {
    const achados = await reconcilePayablesLeg(
      storeCom(3), pspQualquer,
      { id: 'v1', pspRecipientId: 'rcpt_demo', isTest: true, recebedorOk: false },
      { custodyChecks: true },
    );
    expect(achados.some((f) => f.code === 'venue_recipient_unusable')).toBe(false);
  });

  test('cadastro novo (sem recebedor, SEM cobrança) é do radar de ativação, não daqui', async () => {
    // Uma casa que acabou de se cadastrar não tem recebedor ainda. Acusar isso
    // aqui faria o canário noturno gritar por todo cadastro incompleto — e é
    // assim que um canário morre.
    const achados = await reconcilePayablesLeg(
      storeCom(0), pspQualquer, { id: 'v1', pspRecipientId: null, isTest: false, recebedorOk: false }, {},
    );
    expect(achados.some((f) => f.code === 'venue_recipient_unusable')).toBe(false);
  });

  test('recebedor de VERDADE segue pro caminho normal', async () => {
    const achados = await reconcilePayablesLeg(
      storeCom(1), pspQualquer,
      { id: 'v1', pspRecipientId: 're_cmrtc9vppm8xq0l9tae7a4ru6', isTest: false, recebedorOk: true },
      { custodyChecks: true },
    );
    expect(achados.some((f) => f.code === 'venue_recipient_unusable')).toBe(false);
  });
});

/**
 * CASA DE TESTE COM RECEBEDOR VIVO — a metade que não tinha testemunha nenhuma.
 *
 * `is_test` não gateia nada no caminho de pagamento: só a identidade da demo,
 * quem entra na varredura e quem o radar ignora. Uma casa marcada `is_test` com
 * recebedor `re_...` aceita Pix e cartão de gente de verdade, e NENHUMA das três
 * pernas roda nela. O inegociável #8 diz "por restaurante, ao centavo"; pras
 * duas únicas casas onde o adquirente saberia responder, não estava rodando.
 *
 * Medido em produção em 2026-09-10. Achado pela revisão de compliance (HIGH-2).
 */
describe('casa de teste com recebedor de verdade é achado de plataforma', () => {
  const { reconcileAllVenues, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');

  const storeCom = (venues) => ({
    listVenueActivation: async () => venues,
    listChecksForReconcile: async () => [],
    listHouseAccountsForReconcile: async () => [],
    listOpenOrphanMoneyEvents: async () => [],
    listRecentConfirmedCharges: async () => [],
    contarCobrancasConfirmadas: async () => 0,
  });

  test('acusa, entra na severidade e SAI NA MENSAGEM', async () => {
    const rel = await reconcileAllVenues(storeCom([
      { id: 'a', name: 'Beira Mar', isTest: true, recebedorOk: true, recipientStatus: 'active', pspRecipientId: 're_x' },
      { id: 'b', name: 'Kitos Food', isTest: true, recebedorOk: true, recipientStatus: 'affiliation', pspRecipientId: 're_y' },
    ]), {});

    // Nenhuma casa é conferida — elas estão fora por `isTest`.
    expect(rel.venuesChecked).toBe(0);
    // Mas a condição não fica invisível por isso.
    const f = rel.platformFindings.find((x) => x.code === 'test_venue_with_live_recipient');
    expect(f).toBeTruthy();
    expect(f.severity).toBe('high');
    expect(f.venues.map((v) => v.name).sort()).toEqual(['Beira Mar', 'Kitos Food']);
    // E a noite NÃO sai verde.
    expect(rel.worstSeverity).toBe('high');
    const alerta = formatReconcileAlert(rel);
    expect(alerta).toMatch(/marcadas como TESTE têm recebedor de verdade/);
    expect(alerta).toMatch(/Beira Mar/);
  });

  test('casa de teste com recebedor de MENTIRA não acusa — é demo de verdade', async () => {
    const rel = await reconcileAllVenues(storeCom([
      { id: 'a', name: 'Bar do Racha — demonstração', isTest: true, recebedorOk: false, pspRecipientId: 'rcpt_demo' },
    ]), {});
    expect(rel.platformFindings).toEqual([]);
    expect(formatReconcileAlert(rel)).toBe(null);
  });

  test('com `?test=1` não acusa — quem pediu já está olhando pra elas', async () => {
    const rel = await reconcileAllVenues(storeCom([
      { id: 'a', name: 'Beira Mar', isTest: true, recebedorOk: true, pspRecipientId: 're_x' },
    ]), { includeTest: true });
    expect(rel.platformFindings).toEqual([]);
  });
});

/**
 * O PAINEL NÃO PODE FICAR VERMELHO POR CAUSA DA FORMA DO OBJETO.
 *
 * Os guardas de casa (forma e recebedor) ficam ACIMA do `return` por falta de
 * `psp` — de propósito, pra que um adaptador quebrado não desligue justo o
 * achado que diz "não dá pra conferir". Mas eu os gateei em
 * `typeof store.contarCobrancasConfirmadas === 'function'`, que é propriedade do
 * STORE e não de quem chama: em produção o store é o Supabase, que tem o método,
 * então eles disparavam no PAINEL — que passa `{ id, name }` montado à mão.
 *
 * Medido: o painel recebia `severity: high` pra toda casa, em toda carga,
 * cacheado 60s, e o dono lia "Divergência entre o registro e os pagamentos —
 * fale com a gente antes de fechar o caixa". Afirmação falsa sobre o dinheiro
 * dele (CDC art. 6º III, art. 31) — e nenhum teste podia ver, porque todos os
 * duplos omitem `contarCobrancasConfirmadas`.
 *
 * Achado pela revisão de compliance de 2026-09-10 (HIGH-1).
 */
describe('censo: a chamada do painel não vira vermelho', () => {
  const { reconcileOneVenue } = require('../_lib/checks/reconcile-daily');
  const fs = require('fs');
  const path = require('path');

  /** Store COM o contador — como a produção, não como os outros duplos. */
  const storeDeProducao = (cobrancas = 3) => ({
    contarCobrancasConfirmadas: async () => cobrancas,
    listChecksForReconcile: async () => [],
    listHouseAccountsForReconcile: async () => [],
    listOpenOrphanMoneyEvents: async () => [],
    listRecentConfirmedCharges: async () => [],
  });

  test('com o objeto EXATO que o `router.js` passa, o painel sai `ok`', async () => {
    const r = await reconcileOneVenue(storeDeProducao(), { id: 'v1', name: 'Boteco do Zé' }, { repair: false });
    expect(r.severity).not.toBe('high');
    expect(r.findings.some((f) => f.code === 'payables_venue_shape_unknown')).toBe(false);
    expect(r.findings.some((f) => f.code === 'venue_recipient_unusable')).toBe(false);
  });

  test('e a VARREDURA, que pede os guardas, continua acusando', async () => {
    const r = await reconcileOneVenue(
      storeDeProducao(), { id: 'v1', name: 'Boteco' },
      { repair: false, custodyChecks: true },
    );
    expect(r.findings.some((f) => f.code === 'payables_venue_shape_unknown')).toBe(true);
  });

  test('o `router.js` não pede os guardas de casa em rota de LEITURA', () => {
    // Censo de fonte: se alguém acrescentar `custodyChecks: true` numa rota, o
    // painel volta a ficar vermelho pela forma de um objeto que ele mesmo monta.
    const fonte = fs.readFileSync(path.join(__dirname, '../_app/router.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(fonte).not.toMatch(/custodyChecks/);
  });

  test('e só a varredura liga — uma origem, não duas', () => {
    const daily = fs.readFileSync(path.join(__dirname, '../_lib/checks/reconcile-daily.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect((daily.match(/custodyChecks: true/g) || []).length).toBe(1);
  });
});

/**
 * A BASE DA FOLHA É POR RESTAURANTE — somar entre casas não é acionável.
 *
 * Eu separei aplicado de pendente DENTRO da casa e depois torrei os dois numa
 * soma de plataforma. Casa A com −500¢ em fev e casa B com −1000¢ em mar
 * imprimiam "1500¢ em 2026-02, 2026-03" — número que não é de período nenhum E
 * de casa nenhuma. O mesmo defeito da rodada anterior, uma agregação adiante, e
 * este VIVO a partir de duas casas por noite.
 *
 * Lei 13.419/2017 (CLT art. 457 §§) põe a escrituração no restaurante, por
 * período. Achado pela revisão de segurança de 2026-09-10 (MEDIUM-1).
 */
test('duas casas, dois meses: cada uma com o seu número', async () => {
  const { reconcileAllVenues, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');
  const linha = (txid, refTip) => ({
    txid, status: 'confirmado', amountCents: 10000, tipCents: 1000,
    confirmedAmountCents: 10000, confirmedTipCents: 1000,
    confirmedAt: `${refTip.mes}-14T12:00:00.000Z`,
    refundedAmountCents: 0, refundedTipCents: 0,
  });
  const conta = (txid, mes, tip) => ({
    checkId: `c_${txid}`,
    events: [
      { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
      { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: 10000, tipCents: 1000, method: 'pix' } },
      { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: 0, tipCents: tip, offRail: true, reference: 'x', by: 'd@b' } },
    ],
    payments: [linha(txid, { mes })],
  });
  const porCasa = {
    A: [conta('ch_a', '2026-02', 500)],
    B: [conta('ch_b', '2026-03', 1000)],
  };
  const store = {
    listVenueActivation: async () => [
      { id: 'A', name: 'Casa A', pspRecipientId: 're_a', isTest: false, recebedorOk: true },
      { id: 'B', name: 'Casa B', pspRecipientId: 're_b', isTest: false, recebedorOk: true },
    ],
    listChecksForReconcile: async (id) => porCasa[id],
    listHouseAccountsForReconcile: async () => [],
    listOpenOrphanMoneyEvents: async () => [],
    listRecentConfirmedCharges: async () => [],
    contarCobrancasConfirmadas: async () => 1,
    repairPaymentRow: async () => true,
  };

  const rel = await reconcileAllVenues(store, { repair: true });
  const alerta = formatReconcileAlert(rel);

  // Cada casa nomeada, com o SEU número e o SEU mês.
  expect(alerta).toMatch(/• Casa A[\s\S]*?500¢ em 2026-02/);
  expect(alerta).toMatch(/• Casa B[\s\S]*?1000¢ em 2026-03/);
  // E NUNCA a soma entre casas.
  expect(alerta).not.toMatch(/1500¢/);
});

/**
 * `charge_not_from_acquirer` num achado SÓ, com contagem.
 *
 * É fato permanente de linha histórica — ninguém conserta um txid `mock*`. Um
 * `high` por cobrança, toda noite, sobre algo sem remediação, é canário
 * vermelho pra sempre. E o marcador do adaptador não é array, então
 * `payables.length > 0` dava `undefined > 0`: o `payables_never_verified`
 * disparava POR CIMA, contando duas vezes a mesma coisa.
 */
test('cobranças fora do adquirente viram UM achado, não um por cobrança', async () => {
  const psp = { listChargePayables: async () => ({ notFromAcquirer: true }) };
  const store = {
    contarCobrancasConfirmadas: async () => 6,
    listRecentConfirmedCharges: async () => Array.from({ length: 6 }, (_, i) => ({
      txid: `mock${i}`, paidAmountCents: 1000,
    })),
  };
  const { reconcilePayablesLeg: perna } = require('../_lib/checks/reconcile-daily');
  const achados = await perna(
    store, psp,
    { id: 'v1', name: 'Demo', pspRecipientId: 're_x', isTest: true, recebedorOk: true },
    { custodyChecks: true },
  );
  const fora = achados.filter((f) => f.code === 'charge_not_from_acquirer');
  expect(fora).toHaveLength(1);
  expect(fora[0].charges).toBe(6);
  expect(fora[0].severity).toBe('high');
  // E o agregado NÃO dispara por cima: a pergunta já foi respondida.
  expect(achados.some((f) => f.code === 'payables_never_verified')).toBe(false);
});

describe('cobrança de OUTRO trilho na perna deste adquirente', () => {
  /**
   * Eu escrevi na rodada doze uma guarda `payables_leg_missing` pro adaptador
   * que não sabe listar repasse. Ela era INALCANÇÁVEL: o `psp` da conciliação é
   * o adaptador único do processo, que em produção é a Pagar.me — e ela TEM a
   * perna. A guarda nunca dispararia, nem pra casa que cobra por outro trilho
   * (compliance MEDIUM-D da rodada treze).
   *
   * O caso já era coberto, e melhor: uma cobrança que este adquirente não
   * reconhece vira `charge_not_from_acquirer`, `high`, uma por casa com a
   * contagem. O que estava errado ali era a FRASE — ela dizia que a cobrança
   * "não passou pelo adquirente", e uma cobrança da Stripe passou por um; só não
   * por este.
   */
  const { reconcilePayablesLeg } = require('../_lib/checks/reconcile-daily');
  const casa = { id: 'v1', name: 'Casa', pspRecipientId: 're_x', recebedorOk: true, isTest: false };

  test('a frase nomeia ESTE adquirente, e não afirma que não houve nenhum', async () => {
    const store = {
      listRecentConfirmedCharges: async () => [
        { txid: 'pi_3Q', checkId: 'c1', paidAmountCents: 5000, method: 'card' },
      ],
    };
    const psp = { provider: 'pagarme', listChargePayables: async () => ({ notFromAcquirer: true }) };
    const achados = await reconcilePayablesLeg(store, psp, casa, {});
    const fora = achados.filter((f) => f.code === 'charge_not_from_acquirer');
    expect(fora.length).toBe(1);
    expect(fora[0].severity).toBe('high');
    // O provider entra na frase: é o que diz QUAL perna não alcança a cobrança.
    expect(fora[0].message).toMatch(/pagarme/);
    expect(fora[0].message).toMatch(/ESTE adquirente/);
  });

  test('sem adquirente nenhum (store de memória) continua silêncio', async () => {
    expect(await reconcilePayablesLeg({ listRecentConfirmedCharges: async () => [] }, null, casa, {})).toEqual([]);
  });
});
