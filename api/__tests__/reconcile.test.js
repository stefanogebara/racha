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

    test('pagou a MAIS: mesma ideia, do outro lado', () => {
      const r = reconcileCheck({
        checkId: 'c1',
        events: [opened(10000), paid('tx1', 4000, 339)],
        payments: [row('tx1', 3390, 339, 'confirmado', [4000, 339])],
      });
      const f = r.findings.find((x) => x.code === 'overpayment');
      expect(f.severity).toBe('info');
      expect(f.deltaCents).toBe(610);
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
    const venue = store.seedVenue({ name: 'Recon', servicoBp: 1000, pspRecipientId: 'r' });
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
