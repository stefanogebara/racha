'use strict';

/**
 * Reconciliation canary — cross-checks the two independent money ledgers
 * (event log vs payments table) and flags any drift ≥ 1 centavo.
 */

const { reconcileCheck, reconcileVenue } = require('../_lib/checks/reconcile');
const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');

const opened = (t) => ({ type: 'OPENED', payload: { totalCents: t } });
const paid = (txid, a, tip = 0) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: tip, method: 'pix' } });
const refunded = (txid, a, tip = 0) => ({ type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: a, tipCents: tip } });
/**
 * Uma linha de `payments` como as de hoje: o pedido E o confirmado.
 *
 * O confirmado espelha o pedido por padrão, que é o caso normal — o cliente
 * pagou o que a cobrança pediu. Quando os dois divergem (Pix `underpaid` ou
 * `overpaid`), passe `confirmed` explicitamente.
 */
const row = (txid, a, tip, status = 'confirmado', confirmed = null) => ({
  txid, amountCents: a, tipCents: tip, status,
  confirmedAmountCents: confirmed ? confirmed[0] : a,
  confirmedTipCents: confirmed ? confirmed[1] : tip,
  // A DATA faz parte de uma linha confirmada saudável, e faltava aqui.
  //
  // `getPanelView`, `listRecentConfirmedCharges` e o funil filtram por ela: uma
  // linha `confirmado` sem data some do faturamento, da base de gorjeta e da
  // conferência de destino. O duplo omitia a coluna e por isso o estado
  // "confirmada sem data" era indistinguível de uma linha sadia aqui dentro —
  // a mesma forma de todos os defeitos desta série (o duplo dizendo menos que a
  // produção). Ver `confirmed_at_missing`.
  confirmedAt: status === 'confirmado' || status === 'devolvido'
    ? '2026-07-20T12:00:00.000Z' : null,
});
/** Linha ANTERIOR à migração 0015: sem os valores confirmados. */
const legacyRow = (txid, a, tip, status = 'confirmado') => ({ txid, amountCents: a, tipCents: tip, status });

describe('reconcileCheck — event log vs payments table', () => {
  test('clean match → ok, zero drift', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000, 600), paid('tx2', 4000, 0)],
      payments: [row('tx1', 6000, 600), row('tx2', 4000, 0)],
    });
    expect(r.ok).toBe(true);
    expect(r.driftCents).toBe(0);
    expect(r.findings).toEqual([]);
  });

  test('duas moedas na mesma conta é CRÍTICO, não zero de divergência', () => {
    // O buraco que este teste fecha: a conciliação soma centavos e compara com
    // centavos. Sem olhar a moeda ela soma 2450 de real com 2450 de euro e
    // reporta 0,00 — o inegociável #8 derrotado exatamente onde ele deveria
    // gritar. Duas revisões independentes apontaram isto no mesmo dia.
    //
    // Gravar a moeda na linha (0014_payment_currency.sql) foi metade; conferir
    // aqui é a outra. Um campo que ninguém lê é um campo, não uma defesa.
    const eur = (txid, a) => ({ ...row(txid, a, 0), currency: 'EUR' });
    const brl = (txid, a) => ({ ...row(txid, a, 0), currency: 'BRL' });
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(4900), paid('tx1', 2450), paid('tx2', 2450)],
      payments: [brl('tx1', 2450), eur('tx2', 2450)],
    });
    // A soma bate — é justamente por isso que passava sem ser vista.
    expect(r.driftCents).toBe(0);
    expect(r.ok).toBe(false);
    const f = r.findings.find((x) => x.code === 'mixed_currency');
    expect(f).toBeDefined();
    expect(f.severity).toBe('critical');
    expect(f.currencies).toEqual(['BRL', 'EUR']);
  });

  test('moeda AUSENTE é histórico, não divergência', () => {
    // Um pagamento gravado antes da coluna existir não tem moeda. Isso não é
    // uma segunda moeda — é a ausência de um campo novo, e tratar como
    // divergência faria a conciliação gritar sobre todo o passado.
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000), paid('tx2', 4000)],
      payments: [row('tx1', 6000, 0), { ...row('tx2', 4000, 0), currency: 'BRL' }],
    });
    expect(r.findings.some((f) => f.code === 'mixed_currency')).toBe(false);
    expect(r.ok).toBe(true);
  });

  test('webhook appended to log but payments row missing → critical + drift', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000), paid('tx2', 4000)],
      payments: [row('tx1', 6000, 0)], // tx2 row never written
    });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.code === 'missing_payment_row' && f.txid === 'tx2')).toBe(true);
    expect(r.driftCents).toBe(-4000); // payments table short by 4000
  });

  test('confirmed payments row with no matching log event → critical (lost from state)', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000)],
      payments: [row('tx1', 6000, 0), row('ghost', 4000, 0)],
    });
    expect(r.findings.some((f) => f.code === 'missing_log_event' && f.txid === 'ghost')).toBe(true);
    expect(r.driftCents).toBe(4000);
  });

  test('amount mismatch on the same txid → critical', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000, 600)],
      // O CONFIRMADO da linha diz 5000, o razão diz 6000.
      payments: [row('tx1', 6000, 600, 'confirmado', [5000, 600])],
    });
    expect(r.findings.some((f) => f.code === 'amount_mismatch')).toBe(true);
  });

  test('a GORJETA confirmada sozinha também é conferida — é a base da folha', () => {
    // As duas partes podem somar igual e estar trocadas entre si. O número
    // trocado é o que o dono leva pra folha (Lei 13.419 / STJ Tema 1102).
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000, 600)],
      payments: [row('tx1', 6600, 0, 'confirmado', [6300, 300])],
    });
    expect(r.findings.some((f) => f.code === 'tip_mismatch')).toBe(true);
  });

  test('linha SEM valor confirmado é histórico — a divergência ainda aparece na soma', () => {
    // Pagamento anterior à migração 0015. Não dá pra comparar coluna que não
    // existe, mas as duas contagens continuam tendo que fechar.
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000, 600)],
      payments: [legacyRow('tx1', 5000, 600)],
    });
    expect(r.findings.some((f) => f.code === 'amount_mismatch')).toBe(false);
    expect(r.findings.some((f) => f.code === 'ledger_drift')).toBe(true);
    expect(r.driftCents).toBe(-1000);
  });

  describe('pagar valor diferente do pedido é FATO DO NEGÓCIO, não defeito', () => {
    /**
     * No Pix o cliente digita o valor no app do banco. Depois que `underpaid`
     * passou a entrar como dinheiro recebido, "pedido ≠ razão" deixou de ser
     * defeito por definição — e um crítico que dispara em comportamento
     * correto está morto em duas semanas.
     */
    test('pagou a MENOS: achado informativo com os centavos, canário não fica vermelho', () => {
      const r = reconcileCheck({
        checkId: 'c1',
        events: [opened(10000), paid('tx1', 3390, 0)],           // serviço recusado
        payments: [row('tx1', 3390, 339, 'confirmado', [3390, 0])],
      });
      const f = r.findings.find((x) => x.code === 'underpayment');
      expect(f).toBeDefined();
      expect(f.severity).toBe('info');
      expect(f.deltaCents).toBe(-339);
      expect(r.driftCents).toBe(0);                              // nada saiu do lugar
      expect(r.findings.some((x) => x.severity === 'critical' || x.severity === 'high')).toBe(false);
    });

    test('pagou a MAIS é ALTO, não informativo — o pagador não escolhe isso', () => {
      // Numa cobrança Pix com valor, o pagador não tem como pagar além. Então
      // excedente não é "fato do negócio": é ou um defeito de medição nosso,
      // ou dinheiro que a casa tem que devolver. Nos dois casos alguém precisa
      // ver hoje. (O `underpayment` pequeno segue `info`: aquele o cliente
      // escolhe, digitando outro valor no app do banco.)
      const r = reconcileCheck({
        checkId: 'c1',
        events: [opened(10000), paid('tx1', 4000, 339)],
        payments: [row('tx1', 3390, 339, 'confirmado', [4000, 339])],
      });
      const f = r.findings.find((x) => x.code === 'overpayment');
      expect(f.severity).toBe('high');
      expect(f.deltaCents).toBe(610);
    });

    test('pagou GROTESCAMENTE menos é defeito de MEDIÇÃO, não gorjeta recusada', () => {
      // Um adaptador lendo o campo errado depois de uma virada de versão da
      // API confirmaria 1 centavo pra uma cobrança de 37,29. A coluna
      // confirmada e o razão saem da MESMA variável, então eles concordariam e
      // o canário ficaria verde — e a conta seguiria aberta pra ser cobrada de
      // novo. Esta é a última testemunha independente que sobrou.
      const r = reconcileCheck({
        checkId: 'c1',
        events: [opened(10000), paid('tx1', 1, 0)],
        payments: [row('tx1', 3390, 339, 'confirmado', [1, 0])],
      });
      const f = r.findings.find((x) => x.code === 'underpayment');
      expect(f.severity).toBe('high');
      expect(r.ok).toBe(false);
    });

    test('o serviço recusado por inteiro continua sendo `info`', () => {
      // 3390 de 3729: o cliente tirou os 10%. Nada errado, e o canário não
      // pode acender por isso — um alerta que dispara em comportamento correto
      // está morto em duas semanas.
      const r = reconcileCheck({
        checkId: 'c1',
        events: [opened(10000), paid('tx1', 3390, 0)],
        payments: [row('tx1', 3390, 339, 'confirmado', [3390, 0])],
      });
      expect(r.findings.find((x) => x.code === 'underpayment').severity).toBe('info');
      expect(r.ok).toBe(true);
    });

    test('a casa NÃO é contada como falhando por um pagamento a menor', async () => {
      // `checksFailed` alimenta o "ok" do painel do dono. Um fato do negócio
      // não pode fazer a casa aparecer com contas com problema.
      const store = {
        listChecksForReconcile: async () => ([{
          checkId: 'c1',
          events: [opened(10000), paid('tx1', 3390, 0)],
          payments: [row('tx1', 3390, 339, 'confirmado', [3390, 0])],
        }]),
      };
      const v = await reconcileVenue(store, 'v1');
      expect(v.checksFailed).toBe(0);
      expect(v.worstSeverity).toBe('info');   // visível, sem pintar de vermelho
    });
  });

  test('refund reflected in log but row status still confirmado → status_lag', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000), refunded('tx1', 6000)],
      payments: [row('tx1', 6000, 0, 'confirmado')], // should be devolvido
    });
    expect(r.findings.some((f) => f.code === 'status_lag')).toBe(true);
    // Log net = 0; row confirmed counts 6000 → drift surfaces the divergence.
    expect(r.driftCents).toBe(6000);
  });

  test('event-log anomaly (divergent replay) surfaces as a finding', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 6000), paid('tx1', 9000)], // divergent replay
      payments: [row('tx1', 6000, 0)],
    });
    expect(r.findings.some((f) => f.code === 'log_anomaly')).toBe(true);
  });

  test('malformed input never throws', () => {
    expect(() => reconcileCheck({ checkId: 'c1', events: null, payments: null })).not.toThrow();
    const r = reconcileCheck({ checkId: 'c1', events: [], payments: [row('x', 100, 0)] });
    expect(r.findings.some((f) => f.code === 'missing_log_event')).toBe(true);
  });
});

describe('reconcileVenue — live money paths reconcile clean', () => {
  const SECRET = 'reconcile-secret-0123456789ab';

  async function world() {
    const store = createMemoryStore();
    const psp = new MockPsp({ webhookSecret: SECRET });
    const handler = createWebhookHandler({
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      psp,
    });
    const charge = createChargeService({ store, psp });
    const venue = store.seedVenue({ name: 'Recon', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    const table = store.seedTable(venue.id, 'M1');
    return { store, psp, handler, charge, venue, table };
  }

  test('the normal flow leaves zero drift and no findings', async () => {
    const { store, psp, handler, charge, venue, table } = await world();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 10000 }]);
    const c = await charge({ checkId: check.id, amountCents: 10000, tipCents: 1000, payerLabel: 'Ana' });
    const wh = psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 10000, tipCents: 1000 });
    await handler(wh.rawBody, wh.signature);

    const report = await reconcileVenue(store, venue.id);
    expect(report.checksFailed).toBe(0);
    expect(report.totalDriftCents).toBe(0);
    expect(report.worstSeverity).toBe('ok');
  });

  test('a divergent webhook makes the venue report page (worstSeverity high)', async () => {
    const { store, psp, handler, charge, venue, table } = await world();
    const check = await store.openCheck(table.qrToken, [{ id: 'a', name: 'A', priceCents: 10000 }]);
    const c = await charge({ checkId: check.id, amountCents: 6000 });
    await handler(...Object.values(psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 6000 })));
    // divergent replay: appends a log anomaly
    await handler(...Object.values(psp.buildConfirmationWebhook({ txid: c.txid, amountCents: 9000 })));

    const report = await reconcileVenue(store, venue.id);
    expect(report.checksFailed).toBe(1);
    expect(['high', 'critical']).toContain(report.worstSeverity);
  });
});

describe('dinheiro a DEVOLVER envelhece', () => {
  /**
   * `high` na primeira noite e na nonagésima é a mesma coisa que não escalar:
   * uma dívida com o consumidor que nunca sobe de tom é uma dívida que a casa
   * pode ir guardando (CC art. 884). Passadas 48h vira `critical`, que é o que
   * pinta o relatório diário e sai no alerta.
   * Achado pela revisão de compliance de 2026-09-08.
   */
  const pagoAMais = (confirmedAt) => reconcileCheck({
    checkId: 'c1',
    events: [opened(10000), paid('tx1', 19000, 1000)],   // 90,00 de excedente
    payments: [{ ...row('tx1', 19000, 1000), confirmedAt }],
  });

  test('recém-aberta é ALTA — pede ação, não acorda ninguém de madrugada', () => {
    const f = pagoAMais(new Date().toISOString())
      .findings.find((x) => x.code === 'overpaid_pending_restitution');
    expect(f.severity).toBe('high');
    // 19000 de consumo contra 10000 de conta: 9000 a devolver. A gorjeta anda
    // em `tipCents` e não entra nessa comparação.
    expect(f.overpaidCents).toBe(9000);
  });

  test('passadas 48h é CRÍTICA, e diz há quantos dias', () => {
    const tresDias = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const f = pagoAMais(tresDias)
      .findings.find((x) => x.code === 'overpaid_pending_restitution');
    expect(f.severity).toBe('critical');
    expect(f.message).toMatch(/há 3 dia\(s\)/);
    expect(f.since).toBe(tresDias);
  });

  test('sem data não inventa idade — segue alta', () => {
    const f = reconcileCheck({
      checkId: 'c1',
      events: [opened(10000), paid('tx1', 19000, 1000)],
      // SEM data, de propósito — é o assunto do teste. O `row()` passou a pôr
      // uma, porque linha confirmada saudável TEM data; aqui a ausência é a
      // condição sob teste, então ela é escrita à mão.
      payments: [{ ...row('tx1', 19000, 1000), confirmedAt: null }],
    }).findings.find((x) => x.code === 'overpaid_pending_restitution');
    expect(f.severity).toBe('high');
  });

  test('devolvido o excedente, o achado SAI — a marca fecha', () => {
    const r = reconcileCheck({
      checkId: 'c1',
      events: [
        opened(10000), paid('tx1', 19000, 1000),
        // A devolução sai toda do consumo (ver `allocateRestitution`).
        refunded('tx1', 9000, 0),
      ],
      payments: [{
        ...row('tx1', 19000, 1000), refundedAmountCents: 9000, refundedTipCents: 0,
        confirmedAt: new Date().toISOString(),
      }],
    });
    expect(r.findings.some((x) => x.code === 'overpaid_pending_restitution')).toBe(false);
    expect(r.driftCents).toBe(0);
  });
});

describe('a testemunha AGREGADA: serviço cobrado que nunca chega', () => {
  /**
   * Nenhuma faixa por pagamento separa os dois casos, porque eles dão o mesmo
   * número: com serviço de 10%, quem recusa a linha opcional paga
   * `pedido / 1,1` — e um adaptador que passe a ler o campo errado confirma
   * exatamente isso, em todo pagamento. A coluna confirmada e o razão saem da
   * mesma variável na mesma chamada, então concordam.
   *
   * O que distingue é a FREQUÊNCIA. Cem pessoas recusando o serviço no mesmo
   * dia não é fato do negócio; é um adaptador.
   * Achado pela revisão de segurança de 2026-09-08.
   */
  const { acharServicoNuncaArrecadado } = require('../_lib/checks/reconcile');

  const pgto = (tip, confirmedTip) => ({
    txid: `tx${Math.random()}`, amountCents: 3390, tipCents: tip,
    confirmedAmountCents: 3390, confirmedTipCents: confirmedTip, status: 'confirmado',
  });
  const conta = (...pagamentos) => ({ checkId: 'c', events: [], payments: pagamentos });

  test('serviço cobrado em toda mesa e ZERO arrecadado é ALTO', () => {
    const inputs = [conta(...Array.from({ length: 10 }, () => pgto(339, 0)))];
    const f = acharServicoNuncaArrecadado(inputs);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('high');
    expect(f[0].code).toBe('service_never_collected');
    expect(f[0].chargedTipCents).toBe(3390);
    expect(f[0].collectedTipCents).toBe(0);
  });

  test('amostra pequena não acusa — três mesas tirando o serviço é uma terça', () => {
    const inputs = [conta(pgto(339, 0), pgto(339, 0), pgto(339, 0))];
    expect(acharServicoNuncaArrecadado(inputs)).toEqual([]);
  });

  test('arrecadação parcial não acusa — é a regra funcionando', () => {
    // Metade das mesas tirou o serviço. Fato do negócio, e o painel mostra a
    // diferença na linha de cobrado vs arrecadado.
    const inputs = [conta(
      ...Array.from({ length: 5 }, () => pgto(339, 339)),
      ...Array.from({ length: 5 }, () => pgto(339, 0)),
    )];
    expect(acharServicoNuncaArrecadado(inputs)).toEqual([]);
  });

  test('casa que não cobra serviço nunca acusa', () => {
    const inputs = [conta(...Array.from({ length: 10 }, () => pgto(0, 0)))];
    expect(acharServicoNuncaArrecadado(inputs)).toEqual([]);
  });

  test('e o achado chega ao RELATÓRIO diário, sozinho, pintando a casa', async () => {
    const { reconcileOneVenue } = require('../_lib/checks/reconcile-daily');
    // Uma conta COERENTE: cada linha tem o evento dela no razão, e o valor
    // confirmado bate. O único problema é o agregado — que é o ponto: sem esta
    // ligação, o achado era calculado e não relatado, e a casa saía verde com
    // a base da folha zerada.
    const eventos = [{ type: 'OPENED', payload: { totalCents: 33900 } }];
    const linhas = [];
    for (let i = 0; i < 10; i += 1) {
      const txid = `tx${i}`;
      eventos.push({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: 3390, tipCents: 0, method: 'pix' } });
      linhas.push({
        txid, amountCents: 3390, tipCents: 339,
        confirmedAmountCents: 3390, confirmedTipCents: 0,
        status: 'confirmado', confirmedAt: new Date().toISOString(),
      });
    }
    const store = {
      listChecksForReconcile: async () => [{ checkId: 'c1', events: eventos, payments: linhas }],
      listHouseAccountsForReconcile: async () => [],
    };
    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true });
    // Nada crítico: as contas fecham. O que sobra é o agregado.
    expect(r.findings.filter((f) => f.severity === 'critical')).toEqual([]);
    expect(r.findings.some((f) => f.code === 'service_never_collected')).toBe(true);
    expect(r.severity).toBe('high');
  });
});

test('a conta com sobra e serviço em mais de um pagamento ganha um AVISO', () => {
  /**
   * `sempreDevido` está todo atrás de `late`: duas pessoas pagando a conta
   * inteira ANTES de ela fechar produzem sobra cujo SERVIÇO nunca vira devido, e
   * o painel diz "a devolver R$ 100,00" quando são R$ 110,00. Deduzir o serviço
   * do excedente tiraria da folha o serviço de quem só digitou um número maior
   * no app do banco — por isso a regra não existe e existe o aviso (compliance
   * MEDIUM-1 de 089e8a2; ver a decisão registrada).
   */
  const { reconcileCheck } = require('../_lib/checks/reconcile');
  const ev = (type, payload) => ({ type, payload });
  const duas = [
    ev('OPENED', { totalCents: 10000 }),
    ev('PAYMENT_CONFIRMED', { txid: 'ana', amountCents: 10000, tipCents: 1000, method: 'pix' }),
    ev('PAYMENT_CONFIRMED', { txid: 'bruno', amountCents: 10000, tipCents: 1000, method: 'pix' }),
  ];
  const achados = reconcileCheck({ checkId: 'c1', events: duas, payments: [] }).findings;
  const aviso = achados.find((f) => f.code === 'overpaid_tip_check');
  expect(aviso).toBeTruthy();
  expect(aviso.severity).toBe('info');
  expect(achados.some((f) => f.code === 'overpaid_pending_restitution')).toBe(true);

  // Um pagador só que digitou a mais NÃO ganha o aviso: ali o serviço foi dele.
  const um = [
    ev('OPENED', { totalCents: 10000 }),
    ev('PAYMENT_CONFIRMED', { txid: 'ana', amountCents: 14000, tipCents: 1000, method: 'pix' }),
  ];
  expect(reconcileCheck({ checkId: 'c2', events: um, payments: [] }).findings
    .some((f) => f.code === 'overpaid_tip_check')).toBe(false);
});

describe('a conta que voltou a cobrar', () => {
  /**
   * Uma mesa paga em cheio, a casa devolve SÓ O SERVIÇO pelo painel do
   * adquirente, e a conta volta de `paga` pra `parcial`: o rateio do estorno
   * abate `paidCents` e o `totalCents` não se mexe. O telefone de quem está na
   * mesa passa a mostrar R$ 9,09 "faltando" e o botão de pagar, num QR que
   * qualquer um daquela mesa recarrega — cobrança de dívida já quitada (CDC
   * art. 42; repetição em dobro no parágrafo único se alguém pagar).
   *
   * Silencioso: as duas projeções concordam, porque as duas derivam do mesmo
   * razão. Não existia detector nenhum (compliance HIGH-3/MEDIUM-3 da rodada
   * dez), e o runbook avisava da mesma mecânica cem linhas acima, só pro estorno
   * TOTAL.
   */
  const { reconcileCheck } = require('../_lib/checks/reconcile');
  const ev = (type, payload) => ({ type, payload });
  const quitada = [
    ev('OPENED', { totalCents: 10000 }),
    ev('PAYMENT_CONFIRMED', { txid: 'pi', amountCents: 10000, tipCents: 1000, method: 'pix' }),
  ];
  // Os DOIS códigos: o simples e o do caso misto (com chargeback no meio), que
  // tem frase própria porque carrega dois números.
  const achado = (evs) => reconcileCheck({ checkId: 'c', events: evs, payments: [] })
    .findings.filter((x) => /^reopened_by_refund/.test(x.code));

  test('quitada e reaberta por devolução: CRÍTICO, com o número que a mesa vê', () => {
    const r = achado([...quitada, ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 909, tipCents: 91 })]);
    expect(r.length).toBe(1);
    // `high`: nada se perdeu, mas a operação não terminou — e o achado some
    // quando alguém fecha ou ajusta.
    expect(r[0].severity).toBe('high');
    expect(r[0].deltaCents).toBe(909);
    // O próximo passo tem que estar na mensagem: quem lê isto é quem vai ou não
    // pedir o resto à mesa.
    expect(r[0].message).toMatch(/não peça o resto à mesa/);
  });

  test('um ajuste para baixo é o remédio — e some do painel', () => {
    // Não porque o achado ignore `ADJUSTED`: porque o ajuste devolve a conta
    // pra `paga`, e é disso que o achado trata. Um ajuste que fechasse só parte
    // da diferença continuaria acusando, e deve mesmo — a mesa continuaria
    // vendo saldo.
    expect(achado([...quitada,
      ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 909, tipCents: 91 }),
      ev('ADJUSTED', { totalCents: 9091 })]).length).toBe(0);
  });

  test('um ajuste que fecha SÓ PARTE da diferença continua acusando', () => {
    const r = achado([...quitada,
      ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 909, tipCents: 91 }),
      ev('ADJUSTED', { totalCents: 9500 })]);
    expect(r.length).toBe(1);
    expect(r[0].deltaCents).toBe(409);
  });

  /**
   * A DEVOLUÇÃO INTEIRA é o caso MÁXIMO, e era o que o detector não via:
   * `recompute` manda `paidCents === 0` pra `aberta`, não pra `parcial`, então
   * ele gritava por R$ 9,09 e calava por R$ 110,00 — com `ok: true` e zero
   * achados. É justamente o caso que o runbook já avisava em prosa há meses
   * (segurança MEDIUM-1 da rodada onze).
   */
  test('a devolução INTEIRA também reabre — e é a que mais reabre', () => {
    const r = achado([...quitada, ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 10000, tipCents: 1000 })]);
    expect(r.length).toBe(1);
    expect(r[0].deltaCents).toBe(10000);
  });

  /**
   * O CASO MISTO: chargeback grande + devolução pequena na mesma conta.
   *
   * `houveEstorno` é um `some` — basta uma devolução do trilho pro achado
   * nascer —, e o buraco pode ser majoritariamente chargeback. A frase manda
   * "fechar ou ajustar para baixo, não peça o resto à mesa": aplicada sobre a
   * parte disputada, é instruir a apagar dos livros um prejuízo real
   * (compliance MEDIUM-B da rodada doze).
   */
  test('no caso MISTO, o achado carrega os DOIS números e usa a frase dos dois', () => {
    const r = achado([
      ev('OPENED', { totalCents: 20000 }),
      ev('PAYMENT_CONFIRMED', { txid: 'pi', amountCents: 20000, tipCents: 2000, method: 'pix' }),
      ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 10000, tipCents: 1000, disputeId: 'dp_1' }),
      ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 1818, tipCents: 182 }),
    ]);
    expect(r.length).toBe(1);
    /**
     * `deltaCents` é o BURACO (11818) — é ele que a cadeia do painel imprime, e a
     * frase diz "a mesa está vendo {amount} faltando". Pôr ali a parte devolvível
     * fazia o painel afirmar que dois números diferentes eram o mesmo: o dono lia
     * R$ 18,18, a mesa via R$ 118,18, ele ajustava pelo menor e quem sentasse ali
     * pagava o resto — que a rede já tinha levado (CDC art. 42 § único;
     * segurança HIGH-1 da rodada treze).
     */
    expect(r[0].deltaCents).toBe(11818);
    // A parte devolvível tem nome próprio, e a frase do caso misto nomeia as duas.
    expect(r[0].refundableCents).toBe(1818);
    expect(r[0].code).toBe('reopened_by_refund_mixed');
    expect(r[0].message).toMatch(/chargeback, que a casa perdeu mesmo/);
  });

  /**
   * A DEVOLUÇÃO QUE O DONO FEZ NO CAIXA é devolução — e era a que sumia.
   *
   * A conta da parte disputada era `refundedAmount − refundedPeloTrilhoAmount`,
   * e o acumulado do trilho exclui TRÊS coisas: disputa, disputa sem `dp_` e o
   * `offRail`. A diferença carregava a devolução do dono junto, `porDevolucao`
   * dava zero e o achado NÃO SAÍA — no caminho exato que o runbook manda o
   * operador seguir quando o estorno falha (compliance HIGH-1 da rodada treze).
   */
  test('devolução do DONO no caixa também reabre — e o achado sai', () => {
    const r = achado([...quitada, ev('PAYMENT_REFUNDED', {
      txid: 'pi', amountCents: 909, tipCents: 91, offRail: true, reference: 'caixa', by: 'u-1',
    })]);
    expect(r.length).toBe(1);
    expect(r[0].deltaCents).toBe(909);
    // E a frase NÃO fala de chargeback: não houve nenhum.
    expect(r[0].message).not.toMatch(/chargeback/);
  });

  test('quitada sem devolução nenhuma não é achado', () => {
    expect(achado(quitada).length).toBe(0);
  });

  /**
   * CHARGEBACK NÃO É DEVOLUÇÃO. Numa disputa perdida a dívida não está quitada:
   * a rede levou o dinheiro. A frase do achado manda "fechar ou ajustar para
   * baixo, não peça o resto à mesa" — sobre um chargeback, isso é instruir a
   * apagar dos livros um prejuízo real (compliance MEDIUM-2 da rodada onze).
   */
  test('chargeback não é devolução — a dívida não está quitada', () => {
    expect(achado([...quitada,
      ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 909, tipCents: 91, disputeId: 'dp_1' })]).length).toBe(0);
  });

  /**
   * O que ENTROU sai do REDUTOR, não da soma dos payloads: `divergent_appended`
   * grava um SEGUNDO `PAYMENT_CONFIRMED` do mesmo txid de propósito, e somar
   * payloads conta o pagamento duas vezes — fazendo o achado mandar NÃO COBRAR
   * metade de uma conta que a mesa realmente deve.
   */
  test('a reapresentação divergente não faz a conta parecer quitada', () => {
    const r = achado([
      ev('OPENED', { totalCents: 20000 }),
      ev('PAYMENT_CONFIRMED', { txid: 'pi', amountCents: 10000, tipCents: 0, method: 'pix' }),
      // O MESMO txid de novo, com OUTRO valor — o caminho `divergent_appended`,
      // que grava um segundo `PAYMENT_CONFIRMED` de propósito. Com o mesmo
      // valor o redutor curto-circuita como reentrega limpa e este teste
      // cobriria outro caminho que não o que o comentário promete.
      ev('PAYMENT_CONFIRMED', { txid: 'pi', amountCents: 12000, tipCents: 0, method: 'pix' }),
      ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 100, tipCents: 0 }),
    ]);
    expect(r.length).toBe(0);
  });

  test('conta que NUNCA foi quitada não é achado — falta é falta', () => {
    expect(achado([
      ev('OPENED', { totalCents: 10000 }),
      ev('PAYMENT_CONFIRMED', { txid: 'pi', amountCents: 5000, tipCents: 0, method: 'pix' }),
      ev('PAYMENT_REFUNDED', { txid: 'pi', amountCents: 100, tipCents: 0 }),
    ]).length).toBe(0);
  });
});
