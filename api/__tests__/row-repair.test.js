'use strict';

/**
 * A LINHA que ficou pra trás — e a que não pode ser derrubada.
 *
 * O aplicador faz duas escritas: o razão (`appendEvent`, a verdade) e a linha
 * de `payments` (`recordPayment`, uma projeção). Entre as duas cabe uma falha,
 * e a reentrega do PSP — que existe exatamente pra isso — não reparava: os
 * três curto-circuitos de idempotência devolvem `duplicate` ANTES da linha.
 *
 * O resultado era permanente: o razão dizendo que o cliente pagou, a linha
 * `pendente`, o faturamento e a GORJETA (base da folha, Lei 13.419) perdidos,
 * e `ledger_drift` crítico até alguém escrever SQL na mão. A conciliação ativa
 * também não alcançava — ela chama o mesmo aplicador e recebe `duplicate`.
 *
 * Achado pela revisão de segurança de 2026-09-08.
 */

const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');

async function mesa({ falharAoGravar = 0 } = {}) {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 3082 }]);
  await store.registerCharge({
    checkId: check.id, txid: 'ch_1', amountCents: 3082, tipCents: 308,
    payerLabel: 'Ana', method: 'pix',
  });
  let restantes = falharAoGravar;
  const deps = {
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    seenPspEvent: store.seenPspEvent.bind(store),
    getPayment: store.getPayment.bind(store),
    repairPaymentRow: store.repairPaymentRow.bind(store),
    recordPayment: async (p) => {
      if (restantes > 0) { restantes -= 1; throw new Error('supabase 503'); }
      return store.recordPayment(p);
    },
  };
  return { store, check, deps };
}

const confirmacao = {
  kind: 'payment_confirmed', txid: 'ch_1', amountCents: 3082, tipCents: 308,
  method: 'pix', eventId: 'evt_1',
};

describe('entrega parcial: razão gravado, linha não', () => {
  test('a REENTREGA repara a linha em vez de dizer `duplicate` e ir embora', async () => {
    const { store, check, deps } = await mesa({ falharAoGravar: 1 });

    // 1ª entrega: o razão entra, a linha explode.
    await expect(applyConfirmedPayment(confirmacao, deps)).rejects.toThrow('supabase 503');
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(3082);
    expect((await store.getPayment('ch_1')).status).toBe('pendente');   // o buraco

    // 2ª entrega (o PSP reenvia depois do 500): mesma `evt_`, então é
    // `duplicate` — e é aí que a reparação tem que acontecer.
    const r = await applyConfirmedPayment(confirmacao, deps);
    expect(r.status).toBe('duplicate');

    const linha = await store.getPayment('ch_1');
    expect(linha.status).toBe('confirmado');
    expect(linha.confirmedAt).toBeTruthy();      // sem data o pagamento some da série semanal
    expect(linha.confirmedAmountCents).toBe(3082);
    expect(linha.confirmedTipCents).toBe(308);   // a gorjeta volta pra folha
  });

  test('a reparação NÃO reescreve a data de quem já estava confirmado', async () => {
    // Reescrever moveria o faturamento de dia sozinho — o defeito que o
    // `confirmedAt` condicional já tinha corrigido do outro lado.
    const { store, deps } = await mesa();
    await applyConfirmedPayment(confirmacao, deps);
    const antes = (await store.getPayment('ch_1')).confirmedAt;

    await new Promise((r) => setTimeout(r, 5));
    const r = await applyConfirmedPayment(confirmacao, deps);
    expect(r.status).toBe('duplicate');
    expect((await store.getPayment('ch_1')).confirmedAt).toBe(antes);
  });

  test('a reparação falhando não vira 500 — a reentrega segue inofensiva', async () => {
    const { store, check, deps } = await mesa();
    await applyConfirmedPayment(confirmacao, deps);
    const quebrado = { ...deps, getPayment: async () => { throw new Error('leitura caiu'); } };
    const r = await applyConfirmedPayment(confirmacao, quebrado);
    expect(r.status).toBe('duplicate');
    expect(reduce(await store.loadEvents(check.id)).paidCents).toBe(3082);
  });
});

describe('`expirado` só pisa em `pendente` (migração 0020)', () => {
  test('um `payment_failed` atrasado não derruba um pagamento confirmado', async () => {
    // A Stripe não garante ordem e reenvia o que levou 5xx: a recusa no app do
    // banco pode chegar DEPOIS do sucesso da segunda tentativa no mesmo
    // intent. O UPDATE cego apagava o pagamento do faturamento, da gorjeta e
    // da série semanal, e deixava `ledger_drift` crítico permanente.
    const { store, deps } = await mesa();
    await applyConfirmedPayment(confirmacao, deps);

    expect(await store.expirePaymentIfPending('ch_1')).toBe(false);
    const linha = await store.getPayment('ch_1');
    expect(linha.status).toBe('confirmado');
    expect(linha.confirmedAt).toBeTruthy();       // nunca apagado por este caminho
  });

  test('uma cobrança que ninguém pagou expira, e diz que expirou', async () => {
    const { store } = await mesa();
    expect(await store.expirePaymentIfPending('ch_1')).toBe(true);
    expect((await store.getPayment('ch_1')).status).toBe('expirado');
    // Segunda vez: já não está pendente, então não mexe e não mente.
    expect(await store.expirePaymentIfPending('ch_1')).toBe(false);
  });

  test('txid desconhecido é `false`, não exceção', async () => {
    const { store } = await mesa();
    expect(await store.expirePaymentIfPending('ch_nao_existe')).toBe(false);
  });
});

describe('reversão que chega ANTES do estorno', () => {
  /**
   * A Stripe não garante ordem: `refund.failed` pode chegar antes do
   * `charge.refunded`. O caminho registra a anomalia e devolve 200, contando
   * com a REENTREGA pra convergir quando o estorno entrar.
   *
   * Só que a anomalia era gravada com o `evt_` do próprio evento — e
   * `psp_event_id` é único no banco inteiro. A reentrega batia no
   * curto-circuito e saía como `duplicate`: a reversão nunca era aplicada, o
   * dinheiro voltava pro restaurante, e os nossos dois registros continuavam
   * dizendo que o cliente tinha sido estornado.
   * Achado pela revisão de segurança de 2026-09-08.
   */
  test('a reentrega converge — a anomalia não queima a chave do evento', async () => {
    const { store, check, deps } = await mesa();
    await applyConfirmedPayment(confirmacao, deps);

    const falha = {
      kind: 'refund_failed', txid: 'ch_1', amountCents: 1000, tipCents: 0,
      method: 'pix', eventId: 'evt_falha',
    };
    // 1) fora de ordem: o estorno ainda não entrou.
    const fora = await applyConfirmedPayment(falha, deps);
    expect(fora.status).toBe('out_of_order');

    // 2) o estorno chega.
    await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_1', cumulativeRefundedCents: 1000, method: 'pix', eventId: 'evt_estorno',
    }, deps);
    let st = reduce(await store.loadEvents(check.id));
    expect(st.payments.ch_1.refundedAmountCents + st.payments.ch_1.refundedTipCents).toBe(1000);

    // 3) a Stripe reenvia o `refund.failed` — MESMO evt_. Tem que aplicar.
    const rep = await applyConfirmedPayment({ ...falha }, deps);
    expect(rep.status).toBe('appended');

    st = reduce(await store.loadEvents(check.id));
    expect(st.payments.ch_1.refundedAmountCents + st.payments.ch_1.refundedTipCents).toBe(0);
    // E a marca fica: o cliente continua com dinheiro a receber por fora.
    expect(st.anomalies.some((a) => a.type === 'PAYMENT_REFUND_REVERSED')).toBe(true);
  });

  test('a MESMA reversão entregue duas vezes depois do estorno não reverte duas vezes', async () => {
    const { store, check, deps } = await mesa();
    await applyConfirmedPayment(confirmacao, deps);
    await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_1', cumulativeRefundedCents: 1000, method: 'pix', eventId: 'evt_e',
    }, deps);
    const falha = { kind: 'refund_failed', txid: 'ch_1', amountCents: 1000, tipCents: 0, method: 'pix', eventId: 'evt_f' };
    expect((await applyConfirmedPayment(falha, deps)).status).toBe('appended');
    expect((await applyConfirmedPayment({ ...falha }, deps)).status).toBe('duplicate');
    const st = reduce(await store.loadEvents(check.id));
    expect(st.payments.ch_1.refundedAmountCents).toBe(0);   // uma vez, não duas
    expect(st.paidCents).toBe(3082);
  });
});

describe('duas entregas em voo: a reparação não pisa em quem sabe mais', () => {
  /**
   * A reparação roda em todo caminho de `duplicate` — ou seja, exatamente
   * quando há duas cópias do mesmo webhook em voo. Escrita às cegas, ela
   * perdia a escrita da outra entrega: uma reentrega de `charge.paid` lia
   * `refunded = 0`, o `charge.refunded` gravava `devolvido` no meio, e a
   * reparação escrevia `confirmado`/`refunded 0` por cima — o painel voltava a
   * contar como faturamento (e como base da folha) um pagamento devolvido por
   * inteiro. Migração 0023, inegociável #7.
   */
  test('a linha que mudou no meio do caminho não é sobrescrita', async () => {
    const { store, deps } = await mesa();
    await applyConfirmedPayment(confirmacao, deps);

    // O estorno total entra: a linha vira `devolvido`.
    await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_1', cumulativeRefundedCents: 3390, method: 'pix', eventId: 'evt_e',
    }, deps);
    expect((await store.getPayment('ch_1')).status).toBe('devolvido');

    // Uma reparação com a leitura VELHA (o que a outra entrega tinha na mão).
    const perdeu = await store.repairPaymentRow({
      txid: 'ch_1',
      expectedStatus: 'confirmado',            // leitura de antes do estorno
      expectedRefundedAmountCents: 0,
      expectedRefundedTipCents: 0,
      status: 'confirmado',
      confirmedAmountCents: 3082, confirmedTipCents: 308,
      refundedAmountCents: 0, refundedTipCents: 0,
    });
    expect(perdeu).toBe(false);                // perder a corrida é NORMAL

    const linha = await store.getPayment('ch_1');
    expect(linha.status).toBe('devolvido');    // quem sabia mais continua de pé
    expect(linha.refundedAmountCents + linha.refundedTipCents).toBe(3390);
  });

  test('com a leitura ATUAL, repara', async () => {
    const { store, deps } = await mesa({ falharAoGravar: 1 });
    await expect(applyConfirmedPayment(confirmacao, deps)).rejects.toThrow();
    const antes = await store.getPayment('ch_1');
    const ok = await store.repairPaymentRow({
      txid: 'ch_1',
      expectedStatus: antes.status,
      expectedRefundedAmountCents: antes.refundedAmountCents || 0,
      expectedRefundedTipCents: antes.refundedTipCents || 0,
      status: 'confirmado',
      confirmedAmountCents: 3082, confirmedTipCents: 308,
      refundedAmountCents: 0, refundedTipCents: 0,
      confirmedAt: new Date().toISOString(),
    });
    expect(ok).toBe(true);
    expect((await store.getPayment('ch_1')).status).toBe('confirmado');
  });
});

test('o valor da reversão chega ao aviso do cliente ponta a ponta', async () => {
  // O caminho inteiro: estorno parcial → falha do estorno → o que o telefone
  // da mesa mostra. É onde o número errado aparecia.
  const { publicCheckState } = require('../_lib/checks/public-state');
  const { store, check, deps } = await mesa();
  await applyConfirmedPayment(confirmacao, deps);
  await applyConfirmedPayment({
    kind: 'refund', txid: 'ch_1', cumulativeRefundedCents: 1000, method: 'pix', eventId: 'evt_e',
  }, deps);
  await applyConfirmedPayment({
    kind: 'refund_failed', txid: 'ch_1', amountCents: 1000, tipCents: 0, method: 'pix', eventId: 'evt_f',
  }, deps);

  const publico = publicCheckState(reduce(await store.loadEvents(check.id)));
  expect(publico.notices).toEqual([{ code: 'refund_reversed', amountCents: 1000 }]);
});
