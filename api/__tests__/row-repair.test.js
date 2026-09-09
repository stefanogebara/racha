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

describe('restituir por inteiro ZERA a marca — ponta a ponta', () => {
  /**
   * A afirmação "é fechável devolvendo pelo trilho, o que zera a marca" era
   * FALSA sempre que havia gorjeta, que é o caso padrão. O rateio proporcional
   * deixava um resíduo, e a marca convergia geometricamente sem nunca chegar a
   * zero: o painel seguia pedindo devolução e a tela do cliente seguia dizendo
   * que ele era credor, depois de uma restituição completa.
   */
  async function contaPagaAMais() {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    // Conta de 100,00. O serviço de 10,00 é escolha do cliente.
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 10000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 10000, tipCents: 1000,
      payerLabel: 'Ana', method: 'pix',
    });
    // O cliente digitou 200,00 no app do banco: o excedente (90,00) entra no
    // CONSUMO, como `parseCharge` faz.
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_1', amountCents: 19000, tipCents: 1000,
      // `excessCents` é o que o `parseCharge` carrega: quanto DESTE pagamento
      // entrou a mais. É por pagamento, não por conta — ver `alocarDevolucao`.
      excessCents: 9000,
      method: 'pix', eventId: 'evt_pago',
    }, deps);
    return { store, check, deps };
  }

  test('devolver exatamente o excedente zera a marca e não toca a gorjeta', async () => {
    const { store, check, deps } = await contaPagaAMais();
    let st = reduce(await store.loadEvents(check.id));
    expect(st.overpaidCents).toBe(9000);
    const gorjetaAntes = st.tipCents;

    // A casa devolve exatamente o que o painel e a tela do cliente pedem.
    await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_1', cumulativeRefundedCents: 9000, method: 'pix', eventId: 'evt_dev',
    }, deps);

    st = reduce(await store.loadEvents(check.id));
    expect(st.overpaidCents).toBe(0);            // a marca FECHA
    expect(st.tipCents).toBe(gorjetaAntes);      // a folha não pagou a conta
    // `paidCents` é só o CONSUMO (a gorjeta anda em `tipCents`): a conta de
    // 100,00 fica exatamente quitada, e os 10,00 de serviço seguem à parte.
    expect(st.paidCents).toBe(10000);
    expect(st.tipCents).toBe(1000);
    expect(st.status).toBe('paga');

    // E o cliente para de ser avisado de que é credor.
    const { publicCheckState } = require('../_lib/checks/public-state');
    expect(publicCheckState(st).notices).toEqual([]);
  });

  test('devolver MAIS que o excedente aí sim toca a gorjeta — é estorno de verdade', async () => {
    const { store, check, deps } = await contaPagaAMais();
    await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_1', cumulativeRefundedCents: 10000, method: 'pix', eventId: 'evt_dev',
    }, deps);
    const st = reduce(await store.loadEvents(check.id));
    expect(st.overpaidCents).toBe(0);
    expect(st.tipCents).toBeLessThan(1000);      // os 10,00 além do excedente rateiam
    // Entrou 200,00, voltou 100,00: sobra 100,00 nos livros, somando as duas
    // partes. Nem um centavo criado ou perdido no caminho.
    expect(st.paidCents + st.tipCents).toBe(10000);
  });
});

describe('conta RACHADA: a sobra de um não rege o estorno do outro', () => {
  /**
   * `state.overpaidCents` é da CONTA. Numa conta rachada são dinheiros
   * diferentes: se B pagou a mais e depois A (que pagou exato) é estornado, a
   * sobra de B fazia o estorno de A sair todo do consumo — e a gorjeta que
   * devia voltar ficava na base da folha, com encargos por cima de dinheiro
   * que voltou pro cliente. Achado pela revisão de segurança de 2026-09-08.
   */
  const { allocateRefund } = require('../_lib/checks/split-engine');

  test('A pagou exato, B pagou a mais: o estorno de A rateia normalmente', async () => {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 10000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    for (const [txid, amount, tip] of [['ch_a', 5000, 500], ['ch_b', 7050, 500]]) {
      await store.registerCharge({ checkId: check.id, txid, amountCents: amount, tipCents: tip, method: 'pix' });
    }
    // A pagou exatamente a parte dele.
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_a', amountCents: 5000, tipCents: 500,
      excessCents: 0, method: 'pix', eventId: 'evt_a',
    }, deps);
    // B digitou mais no app do banco: 2050 de excedente, parado no consumo.
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_b', amountCents: 7050, tipCents: 500,
      excessCents: 2050, method: 'pix', eventId: 'evt_b',
    }, deps);
    expect(reduce(await store.loadEvents(check.id)).overpaidCents).toBeGreaterThan(0);

    // Agora estorna 1000 de A — quem não tem sobra nenhuma.
    await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_a', cumulativeRefundedCents: 1000, method: 'pix', eventId: 'evt_ra',
    }, deps);

    const st = reduce(await store.loadEvents(check.id));
    const esperado = allocateRefund(5000, 500, 1000);
    expect(st.payments.ch_a.refundedTipCents).toBe(esperado.tipCents);
    expect(st.payments.ch_a.refundedAmountCents).toBe(esperado.amountCents);
    expect(esperado.tipCents).toBeGreaterThan(0);   // a gorjeta de A volta mesmo
  });

  test('e o estorno de B, que TEM sobra, sai do consumo', async () => {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 10000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    for (const [txid, amount, tip] of [['ch_a', 5000, 500], ['ch_b', 7050, 500]]) {
      await store.registerCharge({ checkId: check.id, txid, amountCents: amount, tipCents: tip, method: 'pix' });
    }
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_a', amountCents: 5000, tipCents: 500,
      excessCents: 0, method: 'pix', eventId: 'evt_a',
    }, deps);
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_b', amountCents: 7050, tipCents: 500,
      excessCents: 2050, method: 'pix', eventId: 'evt_b',
    }, deps);
    await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_b', cumulativeRefundedCents: 2050, method: 'pix', eventId: 'evt_rb',
    }, deps);

    const st = reduce(await store.loadEvents(check.id));
    expect(st.payments.ch_b.refundedTipCents).toBe(0);        // a folha não paga
    expect(st.payments.ch_b.refundedAmountCents).toBe(2050);
    expect(st.overpaidCents).toBe(0);                          // e a marca fecha
  });
});

describe('restituição registrada À MÃO fecha a marca', () => {
  /**
   * `overpaidCents` só caía com um `PAYMENT_REFUNDED`, e o único autor desse
   * evento era o caminho do PSP. Mas a devolução Pix tem prazo de 90 dias e às
   * vezes a casa devolve em dinheiro — o runbook prevê os dois. Sem um caminho,
   * fazer a coisa certa deixava a marca `critical` pra sempre e o telefone do
   * cliente dizendo que a casa ainda devia.
   * Achado pela revisão de compliance de 2026-09-08.
   */
  const { appendValidated } = require('../_lib/checks/append-validated');
  const { allocateRestitution } = require('../_lib/checks/split-engine');
  const { publicCheckState } = require('../_lib/checks/public-state');

  async function contaComSobra() {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Rodízio', priceCents: 10000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix',
    });
    // Digitou 200,00 no app do banco. O excedente é DERIVADO pelo razão.
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_1', amountCents: 19000, tipCents: 1000,
      method: 'pix', eventId: 'evt_p',
    }, deps);
    return { store, check };
  }

  test('devolução em dinheiro, registrada com referência, zera a sobra', async () => {
    const { store, check } = await contaComSobra();
    let st = reduce(await store.loadEvents(check.id));
    expect(st.payments.ch_1.excessCents).toBe(9000);   // derivado, sem o PSP dizer
    const gorjetaAntes = st.tipCents;

    // O que a rota faz: rateia pelo MESMO motor e grava o evento com o meio.
    const pg = st.payments.ch_1;
    const partes = allocateRestitution(
      pg.amountCents - pg.refundedAmountCents,
      pg.tipCents - pg.refundedTipCents,
      9000,
      9000,
    );
    await appendValidated(store, check.id, 'PAYMENT_REFUNDED', {
      txid: 'ch_1', ...partes, offRail: true, reference: 'Pix manual E2E-abc123', by: 'dona@bar',
    });

    st = reduce(await store.loadEvents(check.id));
    expect(st.overpaidCents).toBe(0);              // a marca FECHA
    expect(st.tipCents).toBe(gorjetaAntes);        // e a folha não pagou nada
    expect(publicCheckState(st).notices).toEqual([]);
  });

  test('o MEIO e a REFERÊNCIA ficam no razão — é o que prova a devolução num MED', async () => {
    const { store, check } = await contaComSobra();
    await appendValidated(store, check.id, 'PAYMENT_REFUNDED', {
      txid: 'ch_1', amountCents: 9000, tipCents: 0,
      offRail: true, reference: 'Pix manual E2E-abc123', by: 'dona@bar',
    });
    const eventos = await store.loadEvents(check.id);
    const ev = eventos.find((e) => e.type === 'PAYMENT_REFUNDED');
    expect(ev.payload.offRail).toBe(true);
    expect(ev.payload.reference).toBe('Pix manual E2E-abc123');
    expect(ev.payload.by).toBe('dona@bar');
  });
});

describe('a restituição fora do trilho deixa o canário VERDE', () => {
  /**
   * O invariante que faltava: fazer a coisa certa não pode fabricar
   * divergência. A rota gravava o evento e não projetava a linha — o razão
   * dizia 9000 estornados, a linha dizia zero, e a conciliação acusava
   * `refund_mismatch` CRÍTICO e `ledger_drift` de 9000¢. O alerta do fundador
   * passava a dizer "drift 90,00" pra sempre por uma dívida corretamente
   * quitada, e fabricar divergência destrói o instrumento que o inegociável #8
   * exige. Meu teste afirmava o razão e nunca rodava o reconciliador.
   * Achado pelas duas revisões de 2026-09-08.
   */
  const { reconcileCheck } = require('../_lib/checks/reconcile');
  const { appendValidated } = require('../_lib/checks/append-validated');
  const { allocateRestitution } = require('../_lib/checks/split-engine');

  async function contaPagaAMais() {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 're_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 10000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_1', amountCents: 19000, tipCents: 1000,
      method: 'pix', eventId: 'evt_p',
    }, deps);
    return { store, check, venue };
  }

  /** O que a rota faz: grava o evento E projeta a linha do razão. */
  async function registraRestituicao(store, checkId, txid, valor) {
    const st = reduce(await store.loadEvents(checkId));
    const pg = st.payments[txid];
    const excedente = Math.max(0, (pg.excessCents || 0) - (pg.refundedAmountCents || 0));
    const partes = allocateRestitution(
      pg.amountCents - pg.refundedAmountCents,
      pg.tipCents - pg.refundedTipCents,
      valor, excedente,
    );
    await appendValidated(store, checkId, 'PAYMENT_REFUNDED', {
      txid, ...partes, offRail: true, reference: 'Pix manual E2E-1', by: 'dona@bar',
    });
    const depois = reduce(await store.loadEvents(checkId));
    const pgD = depois.payments[txid];
    const linha = await store.getPayment(txid);
    const total = pgD.refundedAmountCents === pgD.amountCents
      && pgD.refundedTipCents === pgD.tipCents;
    await store.repairPaymentRow({
      txid,
      expectedStatus: linha.status,
      expectedRefundedAmountCents: linha.refundedAmountCents || 0,
      expectedRefundedTipCents: linha.refundedTipCents || 0,
      status: total ? 'devolvido' : 'confirmado',
      confirmedAmountCents: pgD.amountCents,
      confirmedTipCents: pgD.tipCents,
      refundedAmountCents: pgD.refundedAmountCents,
      refundedTipCents: pgD.refundedTipCents,
    });
    return partes;
  }

  test('sem divergência fabricada, e a conta sai da lista vermelha', async () => {
    const { store, check, venue } = await contaPagaAMais();
    const antes = reconcileCheck((await store.listChecksForReconcile(venue.id))[0]);
    expect(antes.ok).toBe(false);   // há dívida: vermelho é o certo aqui

    await registraRestituicao(store, check.id, 'ch_1', 9000);

    const r = reconcileCheck((await store.listChecksForReconcile(venue.id))[0]);
    expect(r.driftCents).toBe(0);                 // ZERO, não 9000
    expect(r.findings.filter((f) => f.severity === 'critical')).toEqual([]);
    expect(r.findings.some((f) => f.code === 'refund_mismatch')).toBe(false);
    expect(r.findings.some((f) => f.code === 'overpaid_pending_restitution')).toBe(false);
    expect(r.ok).toBe(true);                      // a casa fica VERDE
  });

  test('e o faturamento e a GORJETA da linha param de mentir', async () => {
    const { store, check } = await contaPagaAMais();
    await registraRestituicao(store, check.id, 'ch_1', 9000);
    const { confirmedMoney } = require('../_lib/store/confirmed-money');
    const linha = await store.getPayment('ch_1');
    // O excedente saiu do consumo, e a gorjeta ficou inteira (é remuneração do
    // time, não fundo de restituição).
    expect(confirmedMoney(linha)).toEqual({ amountCents: 10000, tipCents: 1000 });
    expect(linha.refundedTipCents).toBe(0);
  });
});

describe('a restituição fora do trilho: o caminho de ERRO', () => {
  /**
   * O caminho de erro era pior que não ter projeção nenhuma.
   *
   * O lançamento e a projeção estavam no mesmo `try`. Uma falha transitória na
   * projeção devolvia **400** com o texto interno do PostgREST, o dono lia "não
   * foi possível registrar a devolução" sobre um lançamento que JÁ ESTAVA no
   * razão, tentava de novo e recebia `nothing_to_restitute` — dois erros
   * contraditórios e nenhuma saída. E a linha ficava atrás do razão pra sempre:
   * `refund_mismatch` + `ledger_drift` CRÍTICOS por uma dívida corretamente
   * quitada. Antes da projeção existir, a mesma falha só significava
   * "restituição não registrada".
   *
   * Dois consertos, os dois exercitados aqui: a resposta deixa de depender da
   * projeção, e a CONCILIAÇÃO passa a reparar a linha que ficou atrás.
   * Achado pela revisão de segurança de 2026-09-09.
   */
  const { reconcileVenue } = require('../_lib/checks/reconcile');
  const { appendValidated } = require('../_lib/checks/append-validated');
  const { allocateRestitution } = require('../_lib/checks/split-engine');

  async function contaPagaAMais() {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 0, pspRecipientId: 're_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 10000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 10000, tipCents: 0, method: 'pix',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_1', amountCents: 19000, tipCents: 0,
      method: 'pix', eventId: 'evt_p',
    }, deps);
    return { store, check, venue };
  }

  test('a projeção falha, e a CONCILIAÇÃO repara — a divergência não fica', async () => {
    const { store, check, venue } = await contaPagaAMais();

    // O lançamento entra no razão…
    const st = reduce(await store.loadEvents(check.id));
    const pg = st.payments.ch_1;
    const partes = allocateRestitution(pg.amountCents, pg.tipCents, 9000, pg.excessCents);
    await appendValidated(store, check.id, 'PAYMENT_REFUNDED', {
      txid: 'ch_1', ...partes, offRail: true, reference: 'dinheiro no caixa', by: 'dona@bar',
    });
    // …e a projeção NÃO acontece (é o que uma falha transitória deixa).
    const linhaAntes = await store.getPayment('ch_1');
    expect(linhaAntes.refundedAmountCents || 0).toBe(0);

    // A varredura vê a linha atrás do razão — e agora fecha a própria detecção.
    const v = await reconcileVenue(store, venue.id);
    expect(v.rowsRepaired).toBe(1);
    expect(v.failed.filter((f) => f.findings.some((x) => x.code === 'refund_mismatch'))).toEqual([]);
    expect(v.totalDriftCents).toBe(0);

    const linhaDepois = await store.getPayment('ch_1');
    expect(linhaDepois.refundedAmountCents).toBe(9000);
  });

  test('a varredura NÃO reprojeta uma linha à FRENTE do razão', async () => {
    // Linha à frente significa que o razão perdeu um evento — reprojetar
    // apagaria a evidência do que aconteceu. Só a direção segura.
    const { store, venue } = await contaPagaAMais();
    await store.repairPaymentRow({
      txid: 'ch_1', expectedStatus: 'confirmado',
      expectedRefundedAmountCents: 0, expectedRefundedTipCents: 0,
      status: 'confirmado', confirmedAmountCents: 19000, confirmedTipCents: 0,
      refundedAmountCents: 5000, refundedTipCents: 0,   // a linha inventou um estorno
    });
    const v = await reconcileVenue(store, venue.id);
    expect(v.rowsRepaired).toBe(0);
    // E a divergência CONTINUA sendo acusada, que é o certo.
    expect(v.failed.some((f) => f.findings.some((x) => x.code === 'refund_mismatch'))).toBe(true);
  });
});

/**
 * O CENSO DE COLUNAS — a única forma de teste que pega esta classe.
 *
 * O teste "não reprojeta uma linha à FRENTE" acima primava `refundedAmount:
 * 5000` contra um razão de 0: a linha vinha à frente NA MESMA escalar que o
 * guarda comparava. Ele não podia falhar, porque o guarda era a SOMA das duas
 * pernas de estorno — e a `repair_payment_row` escreve CINCO colunas. Duas
 * consequências, as duas medidas pela revisão de segurança de 2026-09-09
 * (HIGH-1) e as duas verdes na suíte inteira:
 *
 *  - linha 500/0 contra razão 0/1000: a soma diz "atrás" (500 < 1000) e o
 *    reparo apagava os 500¢ que só a linha conhecia — um evento de devolução
 *    PERDIDO, dinheiro que saiu de verdade. Os dois críticos sumiam.
 *  - linha `confirmed_tip` 1400 contra razão 1000: o reparo reescrevia a BASE
 *    DA FOLHA (inegociável #2, Lei 13.419/2017) e zerava R$ 64,00 de drift —
 *    o alarme que o inegociável #8 manda tocar.
 *
 * Então o teste deixa de ser um caso e passa a ser um CENSO: pra cada coluna
 * que a RPC escreve, um caso em que ELA vem à frente enquanto outra fica
 * atrás. O que o `MEMORY.md` chama de "censo ganha de conserto pontual" — o
 * conserto pontual prova o caminho que já estava certo.
 */
describe('censo das colunas que o reparo escreve', () => {
  const { reconcileVenue } = require('../_lib/checks/reconcile');
  const { appendValidated } = require('../_lib/checks/append-validated');

  /** As cinco colunas de `repair_payment_row`, e como pôr cada uma À FRENTE. */
  const COLUNAS = [
    {
      coluna: 'refunded_amount_cents',
      // Atrás na gorjeta, À FRENTE no principal: a SOMA dizia "atrás".
      linha: { refundedAmountCents: 500, refundedTipCents: 0 },
      razao: { refundedAmountCents: 0, refundedTipCents: 1000 },
    },
    {
      coluna: 'refunded_tip_cents',
      linha: { refundedAmountCents: 0, refundedTipCents: 500 },
      razao: { refundedAmountCents: 1000, refundedTipCents: 0 },
    },
    {
      coluna: 'confirmed_amount_cents',
      linha: { refundedAmountCents: 0, refundedTipCents: 0, confirmedAmountCents: 14000 },
      razao: { refundedAmountCents: 2000, refundedTipCents: 0 },
    },
    {
      coluna: 'confirmed_tip_cents',
      linha: { refundedAmountCents: 0, refundedTipCents: 0, confirmedTipCents: 1400 },
      razao: { refundedAmountCents: 2000, refundedTipCents: 0 },
    },
    {
      coluna: 'status',
      // `expirado` contra um razão confirmado é CONFLITO, não atraso.
      linha: { refundedAmountCents: 0, refundedTipCents: 0, status: 'expirado' },
      razao: { refundedAmountCents: 2000, refundedTipCents: 0 },
    },
  ];

  /**
   * Monta uma conta paga com gorjeta, põe o razão no estado pedido e a linha
   * de `payments` no estado pedido — sem passar pelo reparo, escrevendo direto
   * na linha do store de memória, que é o que um backfill ou um SQL na mão faz.
   */
  async function cenario({ linha, razao }) {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 0, pspRecipientId: 're_x' });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 10000 }]);
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix',
    });
    await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_1', amountCents: 10000, tipCents: 1000,
      method: 'pix', eventId: 'evt_p',
    }, deps);
    // O RAZÃO ganha o estorno pedido (a verdade). Só o razão: `appendValidated`
    // não projeta, então a linha fica onde o prime a deixou.
    if (razao.refundedAmountCents || razao.refundedTipCents) {
      // O payload do evento usa `amountCents`/`tipCents` — as colunas
      // `refunded_*` são a PROJEÇÃO desses valores, não o nome do evento.
      await appendValidated(store, check.id, 'PAYMENT_REFUNDED', {
        txid: 'ch_1',
        amountCents: razao.refundedAmountCents,
        tipCents: razao.refundedTipCents,
        offRail: true, reference: 'caixa', by: 'dona@bar',
      });
    }
    // A LINHA vai pro estado divergente — pela própria RPC de reparo, que é o
    // único jeito de escrever nela sem alcançar o privado do store. É o que um
    // backfill ou um SQL na mão deixaria pra trás.
    const antes = await store.getPayment('ch_1');
    const ok = await store.repairPaymentRow({
      txid: 'ch_1',
      expectedStatus: antes.status,
      expectedRefundedAmountCents: antes.refundedAmountCents || 0,
      expectedRefundedTipCents: antes.refundedTipCents || 0,
      status: linha.status ?? antes.status,
      confirmedAmountCents: linha.confirmedAmountCents ?? antes.confirmedAmountCents,
      confirmedTipCents: linha.confirmedTipCents ?? antes.confirmedTipCents,
      refundedAmountCents: linha.refundedAmountCents ?? (antes.refundedAmountCents || 0),
      refundedTipCents: linha.refundedTipCents ?? (antes.refundedTipCents || 0),
    });
    expect(ok).toBe(true);
    return { store, venue, check };
  }

  for (const caso of COLUNAS) {
    test(`${caso.coluna} à frente do razão: NÃO repara, e o achado sobrevive`, async () => {
      const { store, venue } = await cenario(caso);
      const linhaAntes = await store.getPayment('ch_1');

      const v = await reconcileVenue(store, venue.id);

      // 1. Não escreveu.
      expect(v.rowsRepaired).toBe(0);
      // 2. A linha ficou EXATAMENTE como estava — nenhuma coluna tocada.
      expect(await store.getPayment('ch_1')).toEqual(linhaAntes);
      // 3. E a divergência continua sendo acusada: apagar o alarme é o dano.
      expect(v.worstSeverity).toBe('critical');
      expect(v.checksFailed).toBe(1);
    });
  }

  test('o caso LEGÍTIMO segue reparado — o guarda não fechou a porta certa', async () => {
    // Atrás nas duas pernas, confirmado batendo: puro atraso de projeção, que
    // é a razão de este reparo existir. Sem esta afirmação o censo acima
    // passaria com um `return 0` no topo da função.
    const { store, venue } = await cenario({
      linha: { refundedAmountCents: 0, refundedTipCents: 0 },
      razao: { refundedAmountCents: 2000, refundedTipCents: 0 },
    });
    const v = await reconcileVenue(store, venue.id);
    expect(v.rowsRepaired).toBe(1);
    expect((await store.getPayment('ch_1')).refundedAmountCents).toBe(2000);
  });
});

/**
 * O REPARO TEM TESTEMUNHA — senão a varredura conserta e reporta verde.
 *
 * A conciliação passou a ESCREVER em `payments`, em toda casa, toda noite, sem
 * ninguém olhando. E o relatório saía idêntico ao de uma noite parada:
 * `reconcileOneVenue` nunca lia `rowsRepaired`, o `formatReconcileAlert` nunca
 * falava dele, e o único rastro durável (`payment_repair_log`, migração 0026)
 * não é lido por nada — diferente de `orphan_money_events`, que o relatório
 * diário lê. Um bug de projeção que se repete seria remendado toda noite e
 * reportado verde pra sempre: a forma exata dos 12 dias do incidente do
 * Seatable, e o oposto do que o cabeçalho do `reconcile-daily` promete
 * ("ela grita e um humano decide").
 *
 * Os dois testes de reparo acima afirmavam sobre o retorno de `reconcileVenue`,
 * que NÃO é o que o cron relata. Este dirige a varredura inteira e a mensagem
 * que o fundador recebe — o mesmo formato do teste do interruptor da perna dos
 * recebíveis, que já existia neste repositório e não tinha sido aplicado a esta
 * metade do mesmo commit. Achado pela revisão de segurança de 2026-09-09
 * (HIGH-2): o chamador esquecido.
 */
describe('o reparo aparece no relatório e no alerta', () => {
  const { reconcileAllVenues, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');

  /** Um store cujo `listChecksForReconcile` entrega uma linha ATRÁS do razão. */
  function storeComLinhaAtrasada({ falha = false, quantas = 1 } = {}) {
    const venue = { id: 'v1', name: 'Boteco', pspRecipientId: 're_x' };
    const reparados = [];
    const inputs = [];
    for (let i = 0; i < quantas; i += 1) {
      const txid = `ch_${i}`;
      inputs.push({
        checkId: `c_${i}`,
        events: [
          { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
          { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: 10000, tipCents: 0, method: 'pix' } },
          { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid, amountCents: 2000, tipCents: 0, offRail: true, reference: 'caixa', by: 'dona@bar' } },
        ],
        // A linha não sabe do estorno: puro atraso de projeção.
        payments: [{
          txid, status: 'confirmado', amountCents: 10000, tipCents: 0,
          confirmedAmountCents: 10000, confirmedTipCents: 0,
          refundedAmountCents: 0, refundedTipCents: 0,
        }],
      });
    }
    return {
      reparados,
      listVenueActivation: async () => [venue],
      listChecksForReconcile: async () => inputs,
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      async repairPaymentRow(p) {
        if (falha) throw new Error('grant revogado');
        reparados.push(p.txid);
        // Reprojeta o input pra releitura não acusar o que acabou de fechar.
        for (const inp of inputs) {
          for (const row of inp.payments) {
            if (row.txid === p.txid) {
              row.refundedAmountCents = p.refundedAmountCents;
              row.refundedTipCents = p.refundedTipCents;
              row.status = p.status;
            }
          }
        }
        return true;
      },
    };
  }

  test('uma linha reparada SAI no relatório — e não como noite parada', async () => {
    const store = storeComLinhaAtrasada();
    const rel = await reconcileAllVenues(store, {});

    expect(store.reparados).toEqual(['ch_0']);
    // O contador da varredura inteira — é o que a resposta do cron carrega, e
    // era exatamente ele que não existia: sem isto esta noite e uma noite em
    // que nada foi escrito produzem o MESMO relatório.
    expect(rel.rowsRepaired).toBe(1);
    expect(rel.rowsRepairFailed).toBe(0);
    expect(rel.venues[0].rowsRepaired).toBe(1);
    // E a casa deixa de sair `ok`: uma linha de dinheiro foi reescrita, e isso
    // não é uma noite verde. Um reparo isolado é `info` de propósito — não
    // acorda ninguém às 4 da manhã —, mas aparece.
    expect(rel.venues[0].severity).toBe('info');
    expect(rel.worstSeverity).toBe('info');
    // A divergência que existia ANTES foi de fato fechada (é pra isso que o
    // reparo existe); o que sobra no relatório é o registro de que houve reparo.
    expect(rel.venuesRed).toBe(0);
    expect(rel.totalDriftCents).toBe(0);
  });

  test('reparo que FALHA é `high`, vira casa vermelha e entra no alerta', async () => {
    const store = storeComLinhaAtrasada({ falha: true });
    const rel = await reconcileAllVenues(store, {});

    expect(rel.rowsRepaired).toBe(0);
    expect(rel.rowsRepairFailed).toBe(1);
    expect(rel.worstSeverity).toBe('critical'); // a divergência segue lá também
    expect(rel.venuesRed).toBe(1);

    const alerta = formatReconcileAlert(rel);
    // O ALERTA diz que a varredura tentou escrever e não conseguiu. Sem isto um
    // grant revogado é uma linha de stderr que ninguém lê.
    expect(alerta).toMatch(/FALHOU em 1/);
    expect(rel.red[0].findings.some((f) => f.code === 'payment_row_repair_failed'
      && f.severity === 'high')).toBe(true);
  });

  test('atraso SISTEMÁTICO (muitas linhas) deixa de ser `info` e pede gente', async () => {
    // Uma linha atrás é soluço; muitas é bug de projeção, e a diferença tem que
    // aparecer no alerta — senão o remendo noturno esconde a causa raiz.
    const store = storeComLinhaAtrasada({ quantas: 5 });
    const rel = await reconcileAllVenues(store, {});

    expect(rel.rowsRepaired).toBe(5);
    expect(rel.venuesRed).toBe(1);
    const alerta = formatReconcileAlert(rel);
    expect(alerta).toMatch(/reprojetou 5 linha/);
    expect(rel.red[0].findings.some((f) => f.code === 'payment_row_repaired'
      && f.severity === 'high')).toBe(true);
  });

  test('noite parada segue parada — o contador não inventa escrita', async () => {
    const store = {
      listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: 're_x' }],
      listChecksForReconcile: async () => [],
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      repairPaymentRow: async () => true,
    };
    const rel = await reconcileAllVenues(store, {});
    expect(rel.rowsRepaired).toBe(0);
    expect(rel.rowsRepairFailed).toBe(0);
    expect(formatReconcileAlert(rel)).toBe(null);
  });
});
