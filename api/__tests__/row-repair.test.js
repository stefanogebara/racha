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
    // `repair: true` explícito: a escrita é OPT-IN desde o CRITICAL-1 da
    // revisão de compliance de 2026-09-09, e só a varredura noturna a pede.
    const v = await reconcileVenue(store, venue.id, { repair: true });
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
    const v = await reconcileVenue(store, venue.id, { repair: true });
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
    {
      /**
       * `devolvido` — o REBAIXAMENTO que a migração 0021 se recusa a fazer
       * sozinha.
       *
       * A guarda de `status` era pertencimento a uma lista (`['pendente',
       * 'confirmado', 'devolvido']`) enquanto as outras quatro colunas ganharam
       * guarda de DIREÇÃO. `devolvido` estava na lista e é justamente o valor
       * que pode estar À FRENTE: era o único registro de que o dinheiro
       * voltou, e virava `confirmado` — devolvendo a gorjeta estornada pra
       * `tipsCents`, a base da folha, e levando junto o `status_lag` e o
       * `ledger_drift`.
       *
       * A 0021 faz esse mesmo flip e o trata como o comando de maior risco do
       * arquivo: rodado à mão, com imagem anterior, dizendo "REVER A FOLHA do
       * periodo" e "o restaurante PRECISA ser avisado". A varredura fazia igual,
       * de madrugada, em `info`. Achado pela revisão de segurança de
       * 2026-09-09 (HIGH-2); fechado por escopo — o reparo não escreve
       * `status`, ponto.
       */
      coluna: 'status (devolvido, sem estorno no razão)',
      linha: { refundedAmountCents: 0, refundedTipCents: 0, status: 'devolvido' },
      razao: { refundedAmountCents: 2000, refundedTipCents: 0 },
    },
    {
      /**
       * A linha NUNCA PROJETADA (`confirmed_*` nulo) não é reparável.
       *
       * É a população que a 0021 EXCLUI de propósito (`and
       * p.confirmed_amount_cents is not null`), e virá-la pra `confirmado` sem
       * `confirmed_at` a fazia sumir de `getPanelView`, de
       * `listRecentConfirmedCharges` e do funil — dinheiro ausente dos livros
       * da casa e cobrança fora da perna de custódia, pra sempre, com o
       * canário verde. Achado pela revisão de segurança de 2026-09-09 (HIGH-1).
       */
      coluna: 'confirmed_* nulo (nunca projetada)',
      linha: { refundedAmountCents: 0, refundedTipCents: 0, status: 'pendente',
        confirmedAmountCents: null, confirmedTipCents: null },
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

      // Pede a escrita DE PROPÓSITO: um censo que não a pede provaria o opt-in,
      // não o guarda por coluna. São duas defesas e cada uma tem o seu teste.
      const v = await reconcileVenue(store, venue.id, { repair: true });

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
    const antes = await store.getPayment('ch_1');
    const v = await reconcileVenue(store, venue.id, { repair: true });
    expect(v.rowsRepaired).toBe(1);
    const depois = await store.getPayment('ch_1');
    expect(depois.refundedAmountCents).toBe(2000);

    /**
     * E SÓ as colunas de estorno mudaram. Esta é a promessa do escopo, e é a
     * única forma de afirmá-la: o censo acima prova o que o reparo RECUSA;
     * nada provava a forma da linha quando ele ACEITA.
     *
     * Três revisões seguidas acharam bloqueador no que este reparo escrevia
     * ALÉM do estorno — `status` rebaixado de `devolvido`, `confirmed_at`
     * deixado nulo, `confirmed_*` reprojetado. Escrever menos foi o conserto;
     * esta afirmação é o que impede a superfície de crescer de novo.
     */
    expect(depois.status).toBe(antes.status);
    expect(depois.confirmedAmountCents).toBe(antes.confirmedAmountCents);
    expect(depois.confirmedTipCents).toBe(antes.confirmedTipCents);
    expect(depois.confirmedAt).toBe(antes.confirmedAt);
    // E a linha reparada continua CONTÁVEL: `confirmed_at` não nulo é o que
    // `getPanelView`, `listRecentConfirmedCharges` e o funil filtram.
    expect(depois.confirmedAt).toBeTruthy();
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
    const venue = { id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true };
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
          // A conta FECHA depois da devolução — sem isto ela fica `parcial` e o
          // telefone da mesa volta a mostrar saldo e o botão de pagar, o que hoje
          // é um achado próprio (`reopened_by_refund`). Aqui o assunto é o REPARO
          // da linha; misturar os dois faria este teste falhar por outra razão.
          { seq: 4, type: 'CLOSED', payload: {} },
        ],
        // A linha não sabe do estorno: puro atraso de projeção.
        payments: [{
          txid, status: 'confirmado', amountCents: 10000, tipCents: 0,
          confirmedAmountCents: 10000, confirmedTipCents: 0,
          confirmedAt: '2026-07-20T12:00:00.000Z',
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
    const rel = await reconcileAllVenues(store, { repair: true });

    expect(store.reparados).toEqual(['ch_0']);
    // O contador da varredura inteira — é o que a resposta do cron carrega, e
    // era exatamente ele que não existia: sem isto esta noite e uma noite em
    // que nada foi escrito produzem o MESMO relatório.
    expect(rel.rowsRepaired).toBe(1);
    expect(rel.rowsRepairAckLost).toBe(0);
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
    // E O ALERTA FALA — com UMA linha, não a partir de quatro.
    //
    // O corte era `> 3` pra virar `high`, e sem casa vermelha o
    // `formatReconcileAlert` devolvia `null` ANTES de anexar a linha do
    // reparo: 1, 2 ou 3 reprojeções por noite saíam com alerta nenhum, e o
    // trecho que carrega a linha no ramo verde era código morto. Três por
    // noite é noventa por mês de escrita não anunciada em `payments`.
    // (HIGH-3 da revisão de segurança de 2026-09-09.)
    expect(formatReconcileAlert(rel)).toMatch(/reprojetou 1 linha/);
  });

  test('reparo SEM RESPOSTA é `high`, vira casa vermelha e entra no alerta', async () => {
    /**
     * "Falhou" não é uma saída que dê pra afirmar: a RPC pode ter dado commit
     * com a resposta perdida. Então o achado carrega a DÚVIDA — e continua
     * acordando alguém, porque `refunded_tip_cents` pode ter se movido.
     */
    const store = storeComLinhaAtrasada({ falha: true });
    const rel = await reconcileAllVenues(store, { repair: true });

    expect(rel.rowsRepaired).toBe(0);
    expect(rel.rowsRepairAckLost).toBe(1);
    expect(rel.worstSeverity).toBe('critical'); // a divergência segue lá também
    expect(rel.venuesRed).toBe(1);

    const alerta = formatReconcileAlert(rel);
    expect(alerta).toMatch(/SEM RESPOSTA em 1/);
    expect(rel.red[0].findings.some((f) => f.code === 'payment_repair_ack_lost'
      && f.severity === 'high')).toBe(true);
  });

  test('atraso SISTEMÁTICO (muitas linhas) deixa de ser `info` e pede gente', async () => {
    // Uma linha atrás é soluço; muitas é bug de projeção, e a diferença tem que
    // aparecer no alerta — senão o remendo noturno esconde a causa raiz.
    const store = storeComLinhaAtrasada({ quantas: 5 });
    const rel = await reconcileAllVenues(store, { repair: true });

    expect(rel.rowsRepaired).toBe(5);
    expect(rel.venuesRed).toBe(1);
    const alerta = formatReconcileAlert(rel);
    expect(alerta).toMatch(/reprojetou 5 linha/);
    expect(rel.red[0].findings.some((f) => f.code === 'payment_row_repaired'
      && f.severity === 'high')).toBe(true);
  });

  test('noite parada segue parada — o contador não inventa escrita', async () => {
    const store = {
      listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }],
      listChecksForReconcile: async () => [],
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      repairPaymentRow: async () => true,
    };
    const rel = await reconcileAllVenues(store, { repair: true });
    expect(rel.rowsRepaired).toBe(0);
    expect(rel.rowsRepairAckLost).toBe(0);
    expect(formatReconcileAlert(rel)).toBe(null);
  });
});

/**
 * O CENSO DAS ROTAS QUE LEEM — a terceira instância que não vai acontecer.
 *
 * Duas vezes seguidas eu consertei UMA rota e afirmei que o cron era o único
 * que escrevia. Primeiro o `/api/house/admin` (e o `/api/panel` seguiu
 * escrevendo); a revisão de compliance de 2026-09-09 achou o segundo e chamou
 * de CRITICAL, porque o painel recarrega a cada 4s, autenticado como dono, sem
 * prazo, mexendo em `confirmed_tip_cents` — e mostrando "tudo bate" na mesma
 * carga em que reescreveu a linha.
 *
 * O conserto de verdade foi inverter o padrão: a escrita virou OPT-IN, então um
 * chamador esquecido nasce lendo. Este censo é a segunda defesa — ele não deixa
 * `repair: true` aparecer numa rota, onde quer que ela esteja, sem que alguém
 * tenha que mexer neste arquivo e explicar por quê.
 */
describe('censo: nenhuma ROTA pede a escrita do reparo', () => {
  const fs = require('fs');
  const path = require('path');

  test('`repair: true` não aparece em NENHUM arquivo de rota', () => {
    /**
     * Varre TODOS os arquivos de rota, não só o `router.js`.
     *
     * Hoje `api/*.js` é só o `index.js` e todo o roteamento vive no
     * `_app/router.js`, então ler um arquivo bastava — mas um arquivo de rota
     * novo escapava do censo em silêncio, que é a forma exata do defeito que
     * este censo existe pra impedir (eu consertei uma rota e esqueci a outra,
     * duas vezes). Achado pela revisão de compliance de 2026-09-09 (MEDIUM-4).
     */
    const raiz = path.join(__dirname, '..');
    const rotas = [];
    // Tudo que a Vercel publica como função (`api/*` sem `_`) e o roteador.
    for (const e of fs.readdirSync(raiz, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_')) rotas.push(path.join(raiz, e.name));
    }
    const app = path.join(raiz, '_app');
    if (fs.existsSync(app)) {
      for (const e of fs.readdirSync(app, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.js')) rotas.push(path.join(app, e.name));
      }
    }
    expect(rotas.length).toBeGreaterThan(0);

    // A varredura noturna é chamada pelo cron via `reconcileAllVenues`, que põe
    // o `repair` ela mesma — rota nenhuma precisa (nem pode) pedir.
    const pedintes = rotas.filter((f) => /repair:\s*true/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(raiz, f));
    expect(pedintes).toEqual([]);
  });

  test('a varredura é o ÚNICO lugar que liga a escrita', () => {
    const daily = fs.readFileSync(path.join(__dirname, '../_lib/checks/reconcile-daily.js'), 'utf8');
    const recon = fs.readFileSync(path.join(__dirname, '../_lib/checks/reconcile.js'), 'utf8');
    // Uma única origem, em `reconcileAllVenues` — e ela também é OPT-IN.
    //
    // Era `opts.repair !== false` (opt-OUT): o `reconcileVenue` nascia lendo e
    // esta camada não, então uma rota nova chamando `reconcileAllVenues(store,
    // {})` escrevia calada e o censo de rotas (que procura a string literal)
    // não pegava. O padrão tem que ser o mesmo nos dois níveis.
    expect((daily.match(/repair:\s*opts\.repair\s*===\s*true/g) || []).length).toBe(1);
    expect(daily).not.toMatch(/repair:\s*opts\.repair\s*!==\s*false/);
    // E o guarda é opt-IN: `=== true`, não `!== false`. Se alguém inverter isso
    // de volta, toda rota que chama a conciliação volta a escrever calada.
    //
    // Sem os COMENTÁRIOS: o cabeçalho da função cita o predicado antigo pra
    // explicar por que ele mudou, e um censo que lê prosa acusaria a própria
    // explicação. Censo lê código.
    const semComentario = recon
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(semComentario).toMatch(/opts\.repair === true/);
    expect(semComentario).not.toMatch(/opts\.repair === false/);
  });

  test('a rota do painel NÃO escreve — com um store que grita se chamarem', async () => {
    // O censo de fonte acima pega a string; este pega o COMPORTAMENTO, que é o
    // que de fato importa e o que nenhum teste cobria.
    const { reconcileOneVenue } = require('../_lib/checks/reconcile-daily');
    let chamou = false;
    const store = {
      listChecksForReconcile: async () => [{
        checkId: 'c1',
        events: [
          { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
          { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 0, method: 'pix' } },
          { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 0, offRail: true, reference: 'caixa', by: 'd@b' } },
          // A conta FECHA depois da devolução — sem isto ela fica `parcial` e o
          // telefone da mesa volta a mostrar saldo e o botão de pagar, o que hoje
          // é um achado próprio (`reopened_by_refund`). Aqui o assunto é o REPARO
          // da linha; misturar os dois faria este teste falhar por outra razão.
          { seq: 4, type: 'CLOSED', payload: {} },
        ],
        payments: [{
          txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 0,
          confirmedAmountCents: 10000, confirmedTipCents: 0,
          confirmedAt: '2026-07-20T12:00:00.000Z',
          refundedAmountCents: 0, refundedTipCents: 0,   // ATRÁS do razão: reparável
        }],
      }],
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      async repairPaymentRow() { chamou = true; return true; },
    };

    // Do jeito que o painel chama.
    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }, { repair: false });
    expect(chamou).toBe(false);
    // E o achado da divergência CONTINUA saindo: ler não é fingir que bate.
    expect(r.severity).toBe('critical');

    // Do jeito que a varredura chama — aí sim escreve.
    await reconcileOneVenue(store, { id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }, { repair: true });
    expect(chamou).toBe(true);
  });

  test('por OMISSÃO não escreve — o padrão é o que salva o chamador esquecido', async () => {
    const { reconcileVenue } = require('../_lib/checks/reconcile');
    let chamou = false;
    const store = {
      listChecksForReconcile: async () => [{
        checkId: 'c1',
        events: [
          { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
          { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 0, method: 'pix' } },
          { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 0, offRail: true, reference: 'caixa', by: 'd@b' } },
          // A conta FECHA depois da devolução — sem isto ela fica `parcial` e o
          // telefone da mesa volta a mostrar saldo e o botão de pagar, o que hoje
          // é um achado próprio (`reopened_by_refund`). Aqui o assunto é o REPARO
          // da linha; misturar os dois faria este teste falhar por outra razão.
          { seq: 4, type: 'CLOSED', payload: {} },
        ],
        payments: [{
          txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 0,
          confirmedAmountCents: 10000, confirmedTipCents: 0,
          confirmedAt: '2026-07-20T12:00:00.000Z',
          refundedAmountCents: 0, refundedTipCents: 0,
        }],
      }],
      async repairPaymentRow() { chamou = true; return true; },
    };
    await reconcileVenue(store, 'v1');            // sem opts nenhum
    expect(chamou).toBe(false);
    await reconcileVenue(store, 'v1', {});        // opts vazio
    expect(chamou).toBe(false);
  });
});

/**
 * A PROCEDÊNCIA do reparo — quem pediu, e por quê (migração 0029).
 *
 * O `payment_repair_log` gravava, pros TRÊS chamadores, "reprojecao da linha a
 * partir do razao, na reentrega de um webhook". Só um deles é uma reentrega. O
 * commit anterior fez da varredura noturna o chamador de MAIOR VOLUME, sem
 * ninguém presente, escrevendo `confirmed_tip_cents` — e o log é o único
 * registro durável dessa escrita. Registro que descreve a operação errada é
 * prova PIOR que nenhuma numa discussão trabalhista sobre a gorjeta de um
 * período (CLT art. 11: cinco anos) — LGPD art. 37.
 *
 * Achado pela revisão de compliance de 2026-09-09 (M2 → HIGH-3).
 */
describe('censo: todo reparo declara a sua procedência', () => {
  const fs = require('fs');
  const path = require('path');

  /** Os três chamadores, e a origem que cada um tem que declarar. */
  const CHAMADORES = [
    ['../_lib/checks/reconcile.js', 'reconciler_sweep'],
    ['../_lib/pay/webhook-handler.js', 'webhook_redelivery'],
    ['../_app/router.js', 'owner_offrail_refund'],
  ];

  for (const [arquivo, origem] of CHAMADORES) {
    test(`${arquivo.split('/').pop()} declara \`${origem}\``, () => {
      const fonte = fs.readFileSync(path.join(__dirname, arquivo), 'utf8');
      expect(fonte).toMatch(new RegExp(`source: '${origem}'`));
    });
  }

  test('nenhum chamador de `repairPaymentRow` fica SEM origem', () => {
    // O censo de verdade: não é "os três que eu conheço declaram", é "não
    // existe um quarto". Um chamador novo sem `source` grava
    // 'origem nao declarada' no log — explícito, mas ainda assim uma escrita
    // de dinheiro anônima, e é aqui que ela para.
    const raiz = path.join(__dirname, '..');
    const arquivos = [];
    (function varrer(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p);
        else if (e.name.endsWith('.js')) arquivos.push(p);
      }
    })(raiz);

    const semOrigem = [];
    for (const p of arquivos) {
      const fonte = fs.readFileSync(p, 'utf8');
      let i = fonte.indexOf('repairPaymentRow({');
      while (i !== -1) {
        // Fatia até o fecho da chamada e exige `source:` dentro dela.
        let prof = 0; let fim = i;
        for (let j = fonte.indexOf('{', i); j < fonte.length; j += 1) {
          if (fonte[j] === '{') prof += 1;
          else if (fonte[j] === '}') { prof -= 1; if (prof === 0) { fim = j; break; } }
        }
        const chamada = fonte.slice(i, fim + 1);
        if (!/source:\s*'/.test(chamada)) semOrigem.push(`${path.relative(raiz, p)}`);
        i = fonte.indexOf('repairPaymentRow({', fim);
      }
    }
    expect(semOrigem).toEqual([]);
  });

  test('a migração 0029 fecha o conjunto — origem desconhecida não vira texto livre', () => {
    /**
     * A definição VIGENTE, não um arquivo histórico.
     *
     * Isto lia `0029_repair_log_provenance.sql` pelo nome, e a definição efetiva
     * passou a ser a da 0030. Passava só porque a 0030 preservou o bloco — que
     * é exatamente a coisa sob teste. O helper `sqlNaOrdem()` deste repositório
     * já diz a regra: a ÚLTIMA definição vence.
     * (MEDIUM-F da revisão de compliance de 2026-09-09.)
     */
    const dir = path.join(__dirname, '../../supabase/migrations');
    const vigente = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8')
        .includes('function public.repair_payment_row(')).pop();
    expect(vigente).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, vigente), 'utf8');
    for (const origem of ['webhook_redelivery', 'owner_offrail_refund', 'reconciler_sweep']) {
      expect(sql).toMatch(new RegExp(`when '${origem}'`));
    }
    // E o `else` existe: um `p_source` inventado não escapa pro log.
    expect(sql).toMatch(/else 'origem nao declarada pelo chamador'/);
  });
});

/**
 * O PRAZO e o TETO — contabilidade, que é onde eles machucavam.
 *
 * Medido pela revisão de segurança de 2026-09-09:
 *
 *  - MEDIUM-1: a conferência de prazo estava no TOPO do laço, antes de saber se
 *    a linha era sequer candidata. Estourado o prazo, TODA linha de TODA casa
 *    restante entrava em `payment_rows_unrepaired` (`high`) e a casa saía
 *    vermelha — três linhas em dia perfeito viravam "3 linha(s) não foram nem
 *    olhadas". Com 90s globais isso disparava lá pela quinta casa, e o alerta
 *    noturno viraria "N de M restaurantes com divergência" com quase nenhuma
 *    divergência: a morte por alerta do inegociável #8.
 *  - MEDIUM-2: o teto contava SUCESSOS. Com a RPC falhando em toda chamada — um
 *    grant revogado, a assinatura trocada: a classe do inegociável #7 — 500
 *    linhas atrasadas viravam 500 tentativas e o teto nunca engatava.
 */
describe('prazo e teto: só contam o que era candidato', () => {
  const { repararLinhasAtrasadas } = require('../_lib/checks/reconcile');

  /** N linhas em dia PERFEITO — nada a reparar em nenhuma. */
  function emDia(n) {
    const inputs = [];
    for (let i = 0; i < n; i += 1) {
      inputs.push({
        checkId: `c_${i}`,
        events: [
          { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
          { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: `ch_${i}`, amountCents: 10000, tipCents: 0, method: 'pix' } },
        ],
        payments: [{
          txid: `ch_${i}`, status: 'confirmado', amountCents: 10000, tipCents: 0,
          confirmedAmountCents: 10000, confirmedTipCents: 0,
          confirmedAt: '2026-07-20T12:00:00.000Z',
          refundedAmountCents: 0, refundedTipCents: 0,
        }],
      });
    }
    return inputs;
  }

  /** N linhas ATRASADAS — todas candidatas. */
  function atrasadas(n) {
    const inputs = emDia(n);
    for (const inp of inputs) {
      inp.events.push({
        seq: 3, type: 'PAYMENT_REFUNDED',
        payload: { txid: inp.payments[0].txid, amountCents: 2000, tipCents: 0, offRail: true, reference: 'x', by: 'd@b' },
      });
      // E a conta FECHA. Sem isto ela fica `parcial` e o telefone da mesa volta
      // a mostrar saldo e o botão de pagar — o que hoje é um achado próprio
      // (`reopened_by_refund`). Aqui o assunto é o REPARO da linha; misturar os
      // dois faria estes testes ficarem vermelhos por outra razão.
      inp.events.push({ seq: 4, type: 'CLOSED', payload: {} });
    }
    return inputs;
  }

  test('prazo estourado com tudo EM DIA não acusa nada', async () => {
    const store = { repairPaymentRow: async () => true };
    const r = await repararLinhasAtrasadas(store, emDia(3), { deadline: Date.now() - 1 });
    expect(r.reparadas).toBe(0);
    expect(r.achados).toEqual([]);   // e a casa NÃO fica vermelha
  });

  test('prazo estourado com linhas ATRASADAS acusa — e só as candidatas', async () => {
    const store = { repairPaymentRow: async () => true };
    const r = await repararLinhasAtrasadas(store, atrasadas(3), { deadline: Date.now() - 1 });
    expect(r.reparadas).toBe(0);
    const achado = r.achados.find((f) => f.code === 'payment_rows_unrepaired');
    expect(achado).toBeTruthy();
    // Corta na primeira e para: o resto não foi nem lido, e prometer contagem
    // exata do que não se olhou é inventar número.
    expect(achado.skipped).toBeGreaterThan(0);
  });

  test('o teto conta TENTATIVAS: uma RPC que só falha não gasta a varredura', async () => {
    let chamadas = 0;
    const store = { async repairPaymentRow() { chamadas += 1; throw new Error('grant revogado'); } };
    const r = await repararLinhasAtrasadas(store, atrasadas(300), {});
    expect(r.reparadas).toBe(0);
    expect(chamadas).toBeLessThanOrEqual(200);   // TETO_DE_REPAROS
    expect(r.ackPerdidos).toBe(chamadas);
    expect(r.achados.some((f) => f.code === 'payment_repair_ack_lost' && f.severity === 'high')).toBe(true);
  });

  test('claim que não pega (`false`) é CORRIDA, não falha — e não pinta a casa de vermelho', async () => {
    /**
     * Contar era certo; chamar de FALHA não.
     *
     * `false` deste claim quer dizer que a linha mudou entre a leitura e a
     * escrita — sob concorrência é o desfecho benigno, e o chamador irmão já
     * diz isso por escrito ("Perder a corrida é NORMAL e não é erro: a outra
     * entrega sabia mais"). Como `high`, um webhook que pousasse no meio da
     * varredura e projetasse a linha CORRETAMENTE gerava um alerta afirmando
     * que a projeção está atrás do razão — quando ela acabara de ficar em dia.
     * Alerta falso no único alerta que o inegociável #8 diz que não pode ser
     * ignorável. (MEDIUM-1 da revisão de segurança de 2026-09-09.)
     */
    const store = { repairPaymentRow: async () => false };
    const r = await repararLinhasAtrasadas(store, atrasadas(2), {});
    expect(r.reparadas).toBe(0);
    expect(r.ackPerdidos).toBe(0);     // NÃO é resposta perdida
    expect(r.corridas).toBe(2);        // é corrida, e fica dita
    const achado = r.achados.find((f) => f.code === 'payment_row_repair_raced');
    expect(achado).toBeTruthy();
    expect(achado.severity).toBe('info');
    expect(r.achados.some((f) => f.code === 'payment_repair_ack_lost')).toBe(false);
  });

  test('a corrida perdida NÃO deixa a casa vermelha — a varredura inteira', async () => {
    // O teste acima afirma sobre a função; este sobre o que o cron RELATA, que
    // é o que chega no fundador. Sem ele, o `info` poderia estar certo e o
    // relatório ainda sair vermelho por outro caminho.
    const { reconcileAllVenues } = require('../_lib/checks/reconcile-daily');
    const inputs = atrasadas(1);
    let leituras = 0;
    const store = {
      listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }],
      listChecksForReconcile: async () => {
        // Na PRIMEIRA leitura a linha está atrás (é candidata). Da segunda em
        // diante ela já está em dia: é a outra escrita que pegou, que é o que
        // "perder a corrida" significa. Mutar já na primeira faria a linha
        // nunca ser candidata e o teste passaria por não exercitar nada.
        leituras += 1;
        if (leituras > 1) inputs[0].payments[0].refundedAmountCents = 2000;
        return inputs;
      },
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      repairPaymentRow: async () => false,
    };
    const rel = await reconcileAllVenues(store, { repair: true });
    expect(rel.rowsRepairAckLost).toBe(0);
    // O contador ATRAVESSA a fronteira — era criado e jogado fora aqui.
    expect(rel.rowsRepairRaced).toBe(1);
    expect(rel.venuesRed).toBe(0);
    expect(rel.worstSeverity).toBe('info');
    // E o tier `info` deixa de ser só-escrita: `venues[]` descarta `findings`
    // de casa não-vermelha, então sem isto a noite inteira saía muda.
    expect(rel.venues[0].infoFindings).toContain('payment_row_repair_raced');
  });
});

/**
 * A TESTEMUNHA SOBREVIVE AO ERRO — e a forma do relatório tem UMA fonte.
 *
 * `rowsRepaired`/`rowsRepairFailed` foram acrescentados ao retorno de SUCESSO,
 * ao agregado, ao `formatReconcileAlert` e ao payload do aviso. Quatro lugares.
 * O `base` — a forma que o `catch` devolve — é o quinto, e ficou de fora. Três
 * de quatro, o mesmo padrão de sempre.
 *
 * Medido: a varredura reprojetava `refunded_tip_cents` (a base da folha, o
 * número que o CLT art. 462 diz que não volta), uma das outras pernas
 * estourava, e o relatório afirmava `rowsRepaired: 0`. Ausência silenciosa já
 * seria ruim; isto era uma afirmação FALSA num relatório de dinheiro. E a
 * janela de erro é CAUSADA pelo reparo: a releitura só acontece nas noites em
 * que houve escrita.
 *
 * Achado pela revisão de segurança de 2026-09-09 (HIGH-1).
 */
describe('a escrita sobrevive à leitura que falhou', () => {
  const { reconcileOneVenue, reconcileAllVenues, formatReconcileAlert } =
    require('../_lib/checks/reconcile-daily');

  function storeQueRepara({ quebra }) {
    const inputs = [{
      checkId: 'c1',
      events: [
        { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
        { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix' } },
        { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 500, offRail: true, reference: 'x', by: 'd@b' } },
      ],
      payments: [{
        txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 1000,
        confirmedAmountCents: 10000, confirmedTipCents: 1000,
        confirmedAt: '2026-07-20T12:00:00.000Z',
        refundedAmountCents: 0, refundedTipCents: 0,
      }],
    }];
    const escritas = [];
    return {
      escritas,
      listVenueActivation: async () => [{ id: 'v1', name: 'Casa Um', pspRecipientId: 're_x', isTest: false, recebedorOk: true }],
      listChecksForReconcile: async () => inputs,
      // A perna que estoura — DEPOIS de o reparo já ter escrito.
      listHouseAccountsForReconcile: async () => {
        if (quebra) throw new Error('supabase 503');
        return [];
      },
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      async repairPaymentRow(p) {
        escritas.push(p.txid);
        for (const row of inputs[0].payments) {
          if (row.txid === p.txid) {
            row.refundedAmountCents = p.refundedAmountCents;
            row.refundedTipCents = p.refundedTipCents;
          }
        }
        return true;
      },
    };
  }

  test('uma perna estoura DEPOIS do reparo: o relatório não diz zero', async () => {
    const store = storeQueRepara({ quebra: true });
    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Casa Um', pspRecipientId: 're_x', isTest: false, recebedorOk: true }, { repair: true });

    // A escrita ACONTECEU.
    expect(store.escritas).toEqual(['ch_1']);
    // E o relatório diz isso, apesar do estouro.
    expect(r.rowsRepaired).toBe(1);
    expect(r.severity).toBe('critical');   // a conciliação de fato não fechou
    expect(r.findings.some((f) => f.code === 'venue_reconcile_threw')).toBe(true);
    // E o achado da GORJETA — `high` no primeiro reparo justamente pra não se
    // esconder atrás de contagem — não é descartado junto.
    expect(r.findings.some((f) => f.code === 'payment_tip_base_repaired'
      && f.severity === 'high')).toBe(true);
  });

  test('e o alerta do fundador carrega as duas coisas', async () => {
    const store = storeQueRepara({ quebra: true });
    const rel = await reconcileAllVenues(store, { repair: true });
    expect(rel.rowsRepaired).toBe(1);
    const alerta = formatReconcileAlert(rel);
    expect(alerta).toMatch(/reprojetou 1 linha/);
    expect(alerta).toMatch(/não deu pra conciliar/);
  });

  test('sem estouro, o caminho normal continua igual', async () => {
    const store = storeQueRepara({ quebra: false });
    const rel = await reconcileAllVenues(store, { repair: true });
    expect(rel.rowsRepaired).toBe(1);
    expect(rel.venuesRed).toBe(1);   // a gorjeta mexeu → `high`
    expect(formatReconcileAlert(rel)).toMatch(/base da folha/);
  });

  test('CENSO: toda chave que o relatório LÊ existe em TODO retorno', () => {
    /**
     * O conserto de instância seria pôr dois campos no `base`. Este é o de
     * CLASSE: `base` tem que ser a única fonte da forma do relatório, então
     * toda chave que o `formatReconcileAlert` e o `notifyFounderReconcile`
     * consomem precisa existir lá — e derrubar qualquer uma tem que quebrar a
     * suíte, não produzir um `undefined` num relatório de dinheiro.
     */
    const fs = require('fs');
    const path = require('path');
    const daily = fs.readFileSync(path.join(__dirname, '../_lib/checks/reconcile-daily.js'), 'utf8');

    const corpoBase = daily.match(/const base = \{([\s\S]*?)\n {2}\};/);
    expect(corpoBase).not.toBeNull();
    const chavesBase = new Set([...corpoBase[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));

    /**
     * DERIVADO, não fixado.
     *
     * A primeira versão listava quatro nomes à mão e o cabeçalho dizia "toda
     * chave que o relatório consome". Não era censo, era pino: uma quinta
     * chave acrescentada ao retorno de sucesso e esquecida no `base` passava
     * verde — o defeito exato que a revisão tinha acabado de bloquear, uma
     * chave depois. (`accountsChecked` já estava fora da lista.) Agora o
     * conjunto sai do AGREGADO: tudo que `reconcileAllVenues` soma por casa
     * tem que existir no `base`, senão o `catch` devolve `undefined` num
     * relatório de dinheiro.
     */
    /**
     * A SUPERFÍCIE é o RETORNO DE SUCESSO, não os redutores do agregado.
     *
     * A versão anterior derivava de `r.(\w+)` dentro dos redutores de
     * `reconcileAllVenues` — o que fecha aquela classe, mas o contrato de
     * verdade é uma linha abaixo: `venues: venueReports.map(({ findings,
     * ...rest }) => rest)` projeta TODA chave de `rest`. Uma chave consumida
     * pela projeção e não por um redutor é invisível pra ela — e eu enviei
     * exatamente uma dessas no mesmo commit (`infoFindings`).
     *
     * Então: toda chave do retorno de SUCESSO tem que existir no `base`, senão o
     * `catch` devolve uma casa com a chave faltando e o relatório fica com
     * formas diferentes conforme o dia. (LOW-1 da revisão de segurança.)
     */
    const sucesso = daily.match(/return \{\s*\n\s*\.\.\.base,[\s\S]*?\n {4}\};/);
    expect(sucesso).not.toBeNull();
    const doSucesso = new Set(
      [...sucesso[0].matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]),
    );
    expect(doSucesso.size).toBeGreaterThanOrEqual(4);

    const faltando = [...doSucesso].filter((k) => !chavesBase.has(k)).sort();
    expect(faltando).toEqual([]);

    // E o `catch` devolve a partir do `base`, não de um objeto próprio.
    expect(daily).toMatch(/return \{\s*\.\.\.base,\s*severity: 'critical'/);
  });
});

/**
 * ESCREVEU E A RESPOSTA SE PERDEU — o caso que o duplo antigo não sabia fazer.
 *
 * O teste do `'grant revogado'` lançava de um store que NUNCA mutava, então
 * "lança" e "não escreveu" estavam soldados no duplo — a mesma forma de todos
 * os defeitos desta série: o duplo dizendo menos que a produção. Uma RPC de
 * verdade pode dar COMMIT e a resposta se perder (socket resetado, timeout no
 * retorno, a Vercel matando o fetch), e aí a linha foi escrita e o `catch`
 * roda.
 *
 * Classificar isso como "falhou" produzia uma afirmação falsa na direção
 * CONTRÁRIA — "a projeção segue atrás do razão" sobre uma linha recém-projetada
 * — e mandava o operador caçar um travamento inexistente. Pior: o achado da
 * gorjeta vivia só no ramo do sucesso, então `refunded_tip_cents` (base da
 * folha, CLT art. 462) podia se mover com testemunha NENHUMA.
 *
 * Achado pela revisão de segurança de 2026-09-09 (HIGH-1).
 */
describe('a resposta se perde depois do commit', () => {
  const { repararLinhasAtrasadas } = require('../_lib/checks/reconcile');

  function storeQueEscreveEEstoura() {
    const linha = {
      txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 1000,
      confirmedAmountCents: 10000, confirmedTipCents: 1000,
      confirmedAt: '2026-02-14T12:00:00.000Z',
      refundedAmountCents: 0, refundedTipCents: 0,
    };
    return {
      linha,
      async repairPaymentRow(p) {
        // COMMIT…
        linha.refundedAmountCents = p.refundedAmountCents;
        linha.refundedTipCents = p.refundedTipCents;
        // …e a resposta some.
        throw new Error('fetch failed');
      },
    };
  }

  const entrada = (linha) => [{
    checkId: 'c1',
    events: [
      { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
      { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix' } },
      { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 500, offRail: true, reference: 'x', by: 'd@b' } },
    ],
    payments: [linha],
  }];

  test('a linha É escrita, e o achado carrega a DÚVIDA — não "falhou"', async () => {
    const store = storeQueEscreveEEstoura();
    const r = await repararLinhasAtrasadas(store, entrada(store.linha), {});

    // A escrita aconteceu de verdade.
    expect(store.linha.refundedAmountCents).toBe(2000);
    expect(store.linha.refundedTipCents).toBe(500);

    expect(r.reparadas).toBe(0);       // não dá pra afirmar que reparou
    expect(r.ackPerdidos).toBe(1);     // nem que falhou: a dúvida é o fato

    const achado = r.achados.find((f) => f.code === 'payment_repair_ack_lost');
    expect(achado).toBeTruthy();
    expect(achado.severity).toBe('high');
    expect(achado.message).toMatch(/PODE ter escrito/);
  });

  test('e a GORJETA aparece mesmo sem resposta — com o período', async () => {
    // É o ponto inteiro: a base da folha não pode se mover em silêncio só
    // porque a rede piscou. Lei 13.419/2017 + CLT art. 462.
    const store = storeQueEscreveEEstoura();
    const r = await repararLinhasAtrasadas(store, entrada(store.linha), {});
    const achado = r.achados.find((f) => f.code === 'payment_repair_ack_lost');
    expect(achado.tipDeltaCents).toBe(-500);
    expect(achado.periods).toEqual(['2026-02']);
    expect(achado.message).toMatch(/base da folha de 2026-02/);
  });
});

/**
 * UM ESTOURO DENTRO DO ESCRITOR não apaga o que ele já escreveu.
 *
 * O conserto anterior tirou o `reconcileVenue` do `Promise.all` pra que a
 * escrita sobrevivesse a uma perna IRMÃ. Mas `reparo` só é atribuído quando a
 * função RESOLVE, então um lance de dentro dela — um `reduce()` que estoura na
 * conta seguinte, depois de a anterior já ter sido escrita — apagava os
 * contadores do mesmo jeito: `escritas: ["ch_1"]`, `rowsRepaired: 0`.
 *
 * Achado pela revisão de segurança de 2026-09-09 (MEDIUM-2). Fechado com o
 * sumidouro: quem chama lê o que já aconteceu, sem depender de a gente
 * retornar.
 */
describe('o sumidouro sobrevive a um estouro de dentro', () => {
  const { reconcileOneVenue } = require('../_lib/checks/reconcile-daily');

  test('primeira conta reparada, segunda envenenada: o contador sobrevive', async () => {
    const escritas = [];
    const boa = {
      checkId: 'c1',
      events: [
        { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
        { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 0, method: 'pix' } },
        { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 0, offRail: true, reference: 'x', by: 'd@b' } },
          // A conta FECHA depois da devolução — sem isto ela fica `parcial` e o
          // telefone da mesa volta a mostrar saldo e o botão de pagar, o que hoje
          // é um achado próprio (`reopened_by_refund`). Aqui o assunto é o REPARO
          // da linha; misturar os dois faria este teste falhar por outra razão.
          { seq: 4, type: 'CLOSED', payload: {} },
      ],
      payments: [{
        txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 0,
        confirmedAmountCents: 10000, confirmedTipCents: 0,
        confirmedAt: '2026-07-20T12:00:00.000Z',
        refundedAmountCents: 0, refundedTipCents: 0,
      }],
    };
    // `events` não-array faz o `reduce` estourar (`check-state.js`), que é o
    // que um log corrompido produz — e o laço já escreveu na conta anterior.
    const envenenada = { checkId: 'c2', events: 'não é array', payments: [] };

    const store = {
      listChecksForReconcile: async () => [boa, envenenada],
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      async repairPaymentRow(p) {
        escritas.push(p.txid);
        boa.payments[0].refundedAmountCents = p.refundedAmountCents;
        return true;
      },
    };

    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Casa Um', pspRecipientId: 're_x', isTest: false, recebedorOk: true }, { repair: true });

    expect(escritas).toEqual(['ch_1']);        // escreveu
    expect(r.rowsRepaired).toBe(1);            // e o relatório NÃO diz zero
    expect(r.severity).toBe('critical');       // a conciliação de fato caiu
    expect(r.findings.some((f) => f.code === 'venue_reconcile_threw')).toBe(true);
  });
});

/**
 * `confirmed_at_missing` — o detector que ninguém tinha exercitado.
 *
 * Ele entrou como `high` e nada afirmava que dispara. Pior: o RECORTE dele é a
 * afirmação de projeto inteira — ele tem que ficar CALADO na linha nunca
 * projetada, porque essa já tem o seu achado (`confirmed_amount_missing`) e
 * acusar as duas coisas na mesma linha é barulho. Nada afirmava isso tampouco,
 * e a medição diz que zero linhas de produção estão nesse estado, então nem
 * observar dava. Um `high` sem prova de que dispara é o inegociável #7: guarda
 * que nunca dispara é testada em produção, não confiada.
 *
 * Achado pela revisão de compliance de 2026-09-09 (MEDIUM-A).
 */
describe('confirmed_at_missing: dispara, e só onde deve', () => {
  const { reconcileCheck } = require('../_lib/checks/reconcile');

  const conta = (linha) => reconcileCheck({
    checkId: 'c1',
    events: [
      { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
      { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 0, method: 'pix' } },
    ],
    payments: [linha],
  }).findings;

  const base = {
    txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 0,
    confirmedAmountCents: 10000, confirmedTipCents: 0,
    refundedAmountCents: 0, refundedTipCents: 0,
  };

  test('DISPARA na linha projetada sem data — a população da 0021', () => {
    const f = conta({ ...base, confirmedAt: null })
      .find((x) => x.code === 'confirmed_at_missing');
    expect(f).toBeTruthy();
    expect(f.severity).toBe('high');
    expect(f.txid).toBe('ch_1');
  });

  test('CALA na linha nunca projetada — ela já tem o achado dela', () => {
    // É o recorte inteiro: a 0021 reprojetou os dois valores e nunca escreveu a
    // data, então "sem valor" e "sem data" são populações diferentes. Acusar as
    // duas na mesma linha faz o alerta diário crescer sem dizer nada novo.
    const achados = conta({
      ...base, confirmedAmountCents: null, confirmedTipCents: null, confirmedAt: null,
    });
    expect(achados.some((x) => x.code === 'confirmed_at_missing')).toBe(false);
    expect(achados.some((x) => x.code === 'confirmed_amount_missing')).toBe(true);
  });

  test('CALA na linha sadia — com valor e com data', () => {
    const achados = conta({ ...base, confirmedAt: '2026-07-20T12:00:00.000Z' });
    expect(achados.some((x) => x.code === 'confirmed_at_missing')).toBe(false);
  });

  test('CALA na linha que ainda não confirmou', () => {
    // `pendente` sem data é o estado normal de uma cobrança aberta.
    const achados = conta({ ...base, status: 'pendente', confirmedAt: null });
    expect(achados.some((x) => x.code === 'confirmed_at_missing')).toBe(false);
  });
});

/**
 * O ACHADO DE AGREGADO SOBREVIVE AO ERRO DA PERNA IRMÃ.
 *
 * A troca pela pia fez o `catch` montar os achados de `resumo.achados` — que é
 * só do reparo — no lugar de `checks.venueFindings`, que é
 * `[...daCasa, ...reparo.achados]`. O `service_never_collected` sumiu do
 * caminho de erro sem nada acusar.
 *
 * O estrago: um adaptador de POS passa a ler o campo errado depois de uma
 * virada de versão, toda cobrança confirma em `pedido / 1,1` e a casa arrecada
 * ZERO de serviço. É o achado que só existe no agregado — nenhuma faixa por
 * pagamento separa isso. Numa noite em que a perna da casa toma um 5xx
 * transitório, esse `high` era descartado e a única linha que o fundador lia às
 * 4 da manhã era "não deu pra conciliar: supabase 503": uma mensagem que parece
 * transitória engolindo a que diz que o restaurante está perdendo 10% em toda
 * conta. E `venues[]` descarta `findings`, então nem do JSON dava pra recuperar.
 *
 * O teste que existia afirmava `findings.some(f => f.code === 'venue_reconcile_threw')`.
 * Afirmação de EXISTÊNCIA sobre um array nunca pega uma remoção desse array — e
 * ele ainda envenenava a segunda conta, que é o único caminho em que
 * `venueFindings` está legitimamente vazio. Invisível no cenário escolhido.
 *
 * Achado pela revisão de segurança de 2026-09-09 (HIGH-1).
 */
describe('perna irmã estoura: o achado de agregado fica', () => {
  const { reconcileOneVenue } = require('../_lib/checks/reconcile-daily');

  /** Nove pagamentos confirmados, serviço COBRADO e nada arrecadado. */
  function mundoComServicoNaoArrecadado() {
    const inputs = [];
    for (let i = 0; i < 9; i += 1) {
      inputs.push({
        checkId: `c_${i}`,
        events: [
          { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 1000, currency: 'BRL' } },
          { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: `ch_${i}`, amountCents: 10000, tipCents: 1000, method: 'pix' } },
        ],
        payments: [{
          // COBRADO 1000¢ de serviço, ARRECADADO zero: é o que
          // `acharServicoNuncaArrecadado` procura, e nenhuma faixa por
          // pagamento separa isso — só o agregado.
          txid: `ch_${i}`, status: 'confirmado', amountCents: 10000, tipCents: 1000,
          confirmedAmountCents: 10000, confirmedTipCents: 0,
          confirmedAt: '2026-07-20T12:00:00.000Z',
          refundedAmountCents: 0, refundedTipCents: 0,
        }],
      });
    }
    return {
      listChecksForReconcile: async () => inputs,
      // A perna IRMÃ estoura — DEPOIS de o `reconcileVenue` ter resolvido.
      listHouseAccountsForReconcile: async () => { throw new Error('supabase 503'); },
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      repairPaymentRow: async () => true,
    };
  }

  test('`service_never_collected` continua no relatório da casa que estourou', async () => {
    const store = mundoComServicoNaoArrecadado();
    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }, { repair: true });

    const codigos = r.findings.map((f) => f.code);
    expect(codigos).toContain('venue_reconcile_threw');
    expect(codigos).toContain('service_never_collected');
  });

  test('E CHEGA NA MENSAGEM que o fundador lê — não só no array', async () => {
    /**
     * A afirmação anterior era sobre `r.findings`, uma camada ABAIXO de quem
     * consome — exatamente o vício que o cabeçalho deste bloco descreve
     * ("afirmação de EXISTÊNCIA sobre um array"). E o consumidor mostrava UMA
     * linha por casa, escolhida por `find(critical)`: como
     * `venue_reconcile_threw` é `critical` e entra na frente, ele ganhava
     * sempre. O achado voltou pro array e continuou não chegando em ninguém.
     *
     * `report.red[].findings` só vive no corpo da resposta HTTP do cron, que o
     * invocador da Vercel descarta. `formatReconcileAlert` é o único canal que
     * uma pessoa lê. (HIGH-1 reaberto.)
     */
    const { reconcileAllVenues, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');
    const store = mundoComServicoNaoArrecadado();
    store.listVenueActivation = async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }];
    const rel = await reconcileAllVenues(store, { repair: true });
    const alerta = formatReconcileAlert(rel);

    // O que pede AÇÃO é a mensagem; o estouro vira contexto.
    expect(alerta).toMatch(/serviço cobrado e ZERO arrecadado/);
    expect(alerta).toMatch(/supabase 503/);
    // E o estouro não é mais a única coisa na linha da casa.
    const linhaDaCasa = alerta.split('\n').find((l) => l.startsWith('• Boteco'));
    expect(linhaDaCasa).toBeTruthy();
    expect(linhaDaCasa).toMatch(/ZERO arrecadado/);
  });

  test('e sem estouro nenhum ele também está lá — a comparação é justa', async () => {
    const store = mundoComServicoNaoArrecadado();
    store.listHouseAccountsForReconcile = async () => [];
    const r = await reconcileOneVenue(store, { id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }, { repair: true });
    expect(r.findings.map((f) => f.code)).toContain('service_never_collected');
  });
});

/**
 * SQLSTATE é prova de ROLLBACK — "não dá pra classificar" era falso.
 *
 * O erro do postgrest-js carrega um discriminador que o `throwOn` jogava fora:
 * falha de TRANSPORTE não tem código (ou tem `UND_ERR_*`), enquanto erro do
 * SERVIDOR carrega SQLSTATE — e SQLSTATE quer dizer que o servidor produziu uma
 * resposta completa, logo a transação caiu e NADA foi escrito.
 *
 * Sem isso, um grant revogado (`42501`) ou uma assinatura trocada (`42883` — a
 * 0030 acabou de fazer um `create or replace`) produzia "PODE ter escrito,
 * incluindo -500¢ na base da folha de 2026-02" para até 200 linhas por casa,
 * toda noite. Falso na direção oposta ao HIGH-1, na mesma coluna.
 *
 * Achado pela revisão de segurança de 2026-09-09 (MEDIUM-1).
 */
describe('recusado pelo banco ≠ resposta perdida', () => {
  const { repararLinhasAtrasadas } = require('../_lib/checks/reconcile');

  const entrada = () => [{
    checkId: 'c1',
    events: [
      { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
      { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix' } },
      { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 500, offRail: true, reference: 'x', by: 'd@b' } },
    ],
    payments: [{
      txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 1000,
      confirmedAmountCents: 10000, confirmedTipCents: 1000,
      confirmedAt: '2026-02-14T12:00:00.000Z',
      refundedAmountCents: 0, refundedTipCents: 0,
    }],
  }];

  test('`42501` (grant revogado) é RECUSA — nada de "pode ter escrito"', async () => {
    const store = {
      async repairPaymentRow() {
        const e = new Error('supabase store repairPaymentRow: permission denied');
        e.pgCode = '42501';
        throw e;
      },
    };
    const r = await repararLinhasAtrasadas(store, entrada(), {});
    expect(r.rejeitados).toBe(1);
    expect(r.ackPerdidos).toBe(0);
    const f = r.achados.find((x) => x.code === 'payment_row_repair_rejected');
    expect(f.severity).toBe('high');
    // E NÃO afirma movimento na base da folha, porque não houve.
    expect(r.achados.some((x) => x.code === 'payment_repair_ack_lost')).toBe(false);
  });

  test('falha de TRANSPORTE segue sendo dúvida — com a gorjeta', async () => {
    const store = { async repairPaymentRow() { throw new Error('fetch failed'); } };
    const r = await repararLinhasAtrasadas(store, entrada(), {});
    expect(r.rejeitados).toBe(0);
    expect(r.ackPerdidos).toBe(1);
    const f = r.achados.find((x) => x.code === 'payment_repair_ack_lost');
    expect(f.tipDeltaCents).toBe(-500);
  });

  /**
   * A JUNÇÃO — sem isto, apagar o `recusaProvada` do laço fica VERDE.
   *
   * Medido pela revisão: trocando `recusaProvada(e && e.pgCode)` de volta por
   * `e && e.pgCode`, a suíte inteira passava. As duas metades tinham teste — o
   * `throwOn` anexa `'08006'` (forma), e `recusaProvada('08006')` é `false`
   * (significado) — e a COSTURA entre elas, nenhuma. Os testes que passavam
   * pelo reparo usavam só `42501`, que classifica igual dos dois jeitos: o
   * único caminho que alguém já tinha consertado.
   *
   * É o chamador esquecido, uma emenda adiante, dentro do conserto do chamador
   * esquecido anterior. Achado pela revisão de segurança de 2026-09-09.
   */
  const EM_DUVIDA_PELO_REPARO = ['08006', '08007', '57P01', '57P02', 'XX000', '40003', '58030'];
  for (const codigo of EM_DUVIDA_PELO_REPARO) {
    test(`${codigo} atravessa o REPARO como dúvida — com a gorjeta`, async () => {
      const store = {
        async repairPaymentRow() {
          const e = new Error(`supabase store repairPaymentRow: ${codigo}`);
          e.pgCode = codigo;
          throw e;
        },
      };
      const r = await repararLinhasAtrasadas(store, entrada(), {});
      expect(r.rejeitados).toBe(0);
      expect(r.ackPerdidos).toBe(1);
      const f = r.achados.find((x) => x.code === 'payment_repair_ack_lost');
      expect(f).toBeTruthy();
      // A gorjeta VAI JUNTO: é o ponto inteiro de não afirmar rollback.
      expect(f.tipDeltaCents).toBe(-500);
      expect(f.periods).toEqual(['2026-02']);
    });
  }

  test('e um código DETERMINÍSTICO atravessa como recusa — a costura nos dois sentidos', async () => {
    const store = {
      async repairPaymentRow() {
        const e = new Error('supabase store repairPaymentRow: permission denied');
        e.pgCode = '42501';
        throw e;
      },
    };
    const r = await repararLinhasAtrasadas(store, entrada(), {});
    expect(r.rejeitados).toBe(1);
    expect(r.ackPerdidos).toBe(0);
  });

  test('`UND_ERR_*` é transporte, não SQLSTATE', async () => {
    // O postgrest-js usa esse prefixo pra falha de rede do undici. Tratar como
    // recusa afirmaria rollback onde não há resposta nenhuma.
    const store = {
      async repairPaymentRow() {
        const e = new Error('fetch failed');
        e.pgCode = undefined;   // o `throwOn` não anexa em UND_ERR_*
        throw e;
      },
    };
    const r = await repararLinhasAtrasadas(store, entrada(), {});
    expect(r.ackPerdidos).toBe(1);
    expect(r.rejeitados).toBe(0);
  });
});

/**
 * A PIA É POR INVOCAÇÃO. Era `pia.x = pia.x || []` — acumulava.
 *
 * Nenhum chamador reusa o `opts` hoje, e nada proibia. A retentativa que vai ser
 * acrescentada é justamente pro "5xx transitório" que estes comentários vivem
 * descrevendo, e ela dobraria os contadores E a soma de centavos da gorjeta.
 */
test('duas chamadas com o mesmo `opts` não somam duas vezes', async () => {
  const { reconcileVenue } = require('../_lib/checks/reconcile');
  const linha = {
    txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 1000,
    confirmedAmountCents: 10000, confirmedTipCents: 1000,
    confirmedAt: '2026-02-14T12:00:00.000Z',
    refundedAmountCents: 0, refundedTipCents: 0,
  };
  const inputs = [{
    checkId: 'c1',
    events: [
      { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
      { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix' } },
      { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 500, offRail: true, reference: 'x', by: 'd@b' } },
    ],
    payments: [linha],
  }];
  const store = {
    listChecksForReconcile: async () => inputs,
    repairPaymentRow: async () => true,   // sempre "reparou", sem mutar o input
  };
  const opts = { repair: true, witness: {} };
  const a = await reconcileVenue(store, 'v1', opts);
  const b = await reconcileVenue(store, 'v1', opts);
  expect(a.rowsRepaired).toBe(1);
  expect(b.rowsRepaired).toBe(1);   // não 2
  const gorj = b.venueFindings.find((f) => f.code === 'payment_tip_base_repaired');
  expect(gorj.tipDeltaCents).toBe(-500);   // não -1000
});

/**
 * A BATIDA VERDE tem que distinguir "noite parada" de "o reparo parou de
 * funcionar".
 *
 * `repairPaymentRow` devolve `data === true`. A 0030 foi um `create or
 * replace`. Se uma migração futura mudar a forma do retorno, TODO reparo passa
 * a avaliar `false` → corrida perdida → `payment_row_repair_raced`, `info`.
 * Nesse mundo: a casa fica `info` e não vermelha; `escreveu` é falso, então o
 * `formatReconcileAlert` devolve `null`; e o fundador recebe uma BATIDA VERDE.
 * O conserto parou por inteiro e todo sinal lê saudável — a forma dos 12 dias
 * do Seatable com outro mecanismo.
 *
 * Achado pela revisão de segurança de 2026-09-09 (MEDIUM-1).
 */
describe('a batida carrega o tier `info`', () => {
  const { reconcileAllVenues, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');

  test('reparo que sempre perde a corrida: alerta nulo, mas a batida DIZ', async () => {
    const inputs = [{
      checkId: 'c1',
      events: [
        { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
        { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 0, method: 'pix' } },
        { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 0, offRail: true, reference: 'x', by: 'd@b' } },
          // A conta FECHA depois da devolução — sem isto ela fica `parcial` e o
          // telefone da mesa volta a mostrar saldo e o botão de pagar, o que hoje
          // é um achado próprio (`reopened_by_refund`). Aqui o assunto é o REPARO
          // da linha; misturar os dois faria este teste falhar por outra razão.
          { seq: 4, type: 'CLOSED', payload: {} },
      ],
      payments: [{
        txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 0,
        confirmedAmountCents: 10000, confirmedTipCents: 0,
        confirmedAt: '2026-07-20T12:00:00.000Z',
        refundedAmountCents: 2000, refundedTipCents: 0,   // já em dia na releitura
      }],
    }];
    let leituras = 0;
    const store = {
      listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }],
      listChecksForReconcile: async () => {
        leituras += 1;
        if (leituras === 1) inputs[0].payments[0].refundedAmountCents = 0;
        else inputs[0].payments[0].refundedAmountCents = 2000;
        return inputs;
      },
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      repairPaymentRow: async () => false,   // a RPC mudou de forma
    };

    const rel = await reconcileAllVenues(store, { repair: true });

    // O alerta é NULO — nada vermelho, e isso está certo.
    expect(formatReconcileAlert(rel)).toBe(null);
    expect(rel.venuesRed).toBe(0);
    // Mas a batida NÃO pode ser indistinguível de uma noite parada — e a
    // afirmação é sobre o TEXTO, não sobre o campo estruturado. Foi com esse
    // argumento que o HIGH-1 foi fechado; afirmar em `rel.infoCodes` seria a
    // mesma profundidade que o cabeçalho daquele teste chama de defeito.
    const { formatReconcileHeartbeat } = require('../_lib/checks/reconcile-daily');
    const batida = formatReconcileHeartbeat(rel);
    expect(batida).toMatch(/corridas 1/);
    expect(batida).toMatch(/info payment_row_repair_raced/);
  });

  test('noite parada mesmo: nada nos dois', async () => {
    const store = {
      listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }],
      listChecksForReconcile: async () => [],
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      repairPaymentRow: async () => true,
    };
    const rel = await reconcileAllVenues(store, { repair: true });
    const { formatReconcileHeartbeat } = require('../_lib/checks/reconcile-daily');
    expect(formatReconcileAlert(rel)).toBe(null);
    // A batida de uma noite parada DIZ que foi parada — zeros e `info -`.
    expect(formatReconcileHeartbeat(rel)).toMatch(/reparadas 0 · corridas 0 · recusadas 0 · sem resposta 0 · info -/);
  });

  test('o payload da BATIDA carrega os dois — é o que se lê quando nada é vermelho', () => {
    // Censo de fonte: a assinatura do `notifyFounderReconcile` e a chamada da
    // rota têm que passar o tier `info` e os dois contadores novos.
    const fs = require('fs');
    const path = require('path');
    const notify = fs.readFileSync(path.join(__dirname, '../_lib/notify.js'), 'utf8');
    const router = fs.readFileSync(path.join(__dirname, '../_app/router.js'), 'utf8');
    for (const chave of ['infoCodes', 'rowsRepairRaced', 'rowsRepairRejected']) {
      expect(notify).toMatch(new RegExp(chave));
    }
    /**
     * TODOS os call sites, não "existe um".
     *
     * Há duas chamadas de `notifyFounderReconcile` que carregam campos do
     * relatório — o alerta e a BATIDA — e um `toMatch` é satisfeito por uma só.
     * Tirar as chaves da batida deixava o censo verde, e a batida é justamente
     * a que se lê quando nada está vermelho.
     */
    const chamadas = [...router.matchAll(/notifyFounderReconcile\(\{/g)].map((m) => m.index);
    expect(chamadas.length).toBeGreaterThanOrEqual(2);
    const comRelatorio = chamadas
      .map((i) => router.slice(i, router.indexOf('});', i)))
      .filter((t) => /report\./.test(t));
    expect(comRelatorio.length).toBe(2);
    for (const trecho of comRelatorio) {
      for (const chave of ['infoCodes', 'rowsRepairRaced', 'rowsRepairRejected']) {
        expect(trecho).toMatch(new RegExp(`${chave}: report\\.${chave}`));
      }
    }
  });
});

/**
 * O NÚMERO DA FOLHA CHEGA NA MENSAGEM — nos dois códigos que a seleção descarta.
 *
 * `formatReconcileAlert` imprime UM achado por casa, e um reparo recusado
 * GARANTE um `critical` concorrente: "recusado" quer dizer que a linha segue
 * atrás do razão, que é exatamente a condição que produz `refund_mismatch` e
 * `ledger_drift`. Os dois vêm de `checkFindings`, que precedem `venueFindings`,
 * então `find(critical)` ganha SEMPRE.
 *
 * E pro `ack_lost` o sinal ficava INVERTIDO: escrita que pegou → releitura
 * limpa → sem `critical` → o número aparece, justo quando a base já está certa.
 * Escrita que não pegou → `critical` encobre, justo quando ela segue inflada.
 *
 * Só `payment_tip_base_repaired` aparecia, porque ele só existe DEPOIS de uma
 * escrita bem sucedida — que limpa os críticos. Era o único caso que os testes
 * cobriam, e por isso parecia certo.
 *
 * Achado pela revisão de segurança de 2026-09-09 (HIGH-1) e, por outro caminho,
 * pela de compliance (HIGH-E: a correção do MEDIUM-G não tinha teste nenhum).
 */
describe('o delta da folha atravessa a seleção do alerta', () => {
  const { reconcileAllVenues, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');

  /** Uma casa com estorno no razão e a linha atrás — divergência garantida. */
  function casaComDivergencia(comportamentoDaRpc) {
    const inputs = [{
      checkId: 'c1',
      events: [
        { seq: 1, type: 'OPENED', payload: { totalCents: 10000, items: [], servicoBp: 0, currency: 'BRL' } },
        { seq: 2, type: 'PAYMENT_CONFIRMED', payload: { txid: 'ch_1', amountCents: 10000, tipCents: 1000, method: 'pix' } },
        { seq: 3, type: 'PAYMENT_REFUNDED', payload: { txid: 'ch_1', amountCents: 2000, tipCents: 500, offRail: true, reference: 'x', by: 'd@b' } },
      ],
      payments: [{
        txid: 'ch_1', status: 'confirmado', amountCents: 10000, tipCents: 1000,
        confirmedAmountCents: 10000, confirmedTipCents: 1000,
        confirmedAt: '2026-02-14T12:00:00.000Z',
        refundedAmountCents: 0, refundedTipCents: 0,
      }],
    }];
    return {
      listVenueActivation: async () => [{ id: 'v1', name: 'Boteco', pspRecipientId: 're_x', isTest: false, recebedorOk: true }],
      listChecksForReconcile: async () => inputs,
      listHouseAccountsForReconcile: async () => [],
      listOpenOrphanMoneyEvents: async () => [],
      listRecentConfirmedCharges: async () => [],
      repairPaymentRow: comportamentoDaRpc,
    };
  }

  test('RECUSADO: os críticos ganham a linha, e o número da folha sai mesmo assim', async () => {
    const rel = await reconcileAllVenues(casaComDivergencia(async () => {
      const e = new Error('permission denied'); e.pgCode = '42501'; throw e;
    }), { repair: true });

    expect(rel.rowsRepairRejected).toBe(1);
    const alerta = formatReconcileAlert(rel);
    // O crítico É a manchete, e isso está certo — ele pede ação primeiro.
    expect(alerta).toMatch(/critical/);
    // Mas os centavos e o MÊS chegam junto, na linha que não passa por seleção.
    // PENDENTE, não "já corrigida": o banco recusou, a linha segue atrás.
    expect(alerta).toMatch(/base da folha \(AINDA divergente\): 500¢ em 2026-02/);
    expect(alerta).toMatch(/o valor do razão é o MENOR e é o seguro/);
    expect(alerta).not.toMatch(/já corrigida/);
  });

  test('SEM RESPOSTA com a divergência de pé: idem — o sinal não é mais invertido', async () => {
    const rel = await reconcileAllVenues(casaComDivergencia(async () => {
      throw new Error('fetch failed');
    }), { repair: true });

    expect(rel.rowsRepairAckLost).toBe(1);
    const alerta = formatReconcileAlert(rel);
    expect(alerta).toMatch(/base da folha \(AINDA divergente\): 500¢ em 2026-02/);
  });

  test('e o achado `rejected` carrega os campos que o runbook manda usar', async () => {
    // A correção do MEDIUM-G não tinha asserção nenhuma: apagar
    // `deltaCents`/`periodo` do `rejeitados.push` deixava a suíte verde.
    const rel = await reconcileAllVenues(casaComDivergencia(async () => {
      const e = new Error('permission denied'); e.pgCode = '42501'; throw e;
    }), { repair: true });
    const f = rel.red[0].findings.find((x) => x.code === 'payment_row_repair_rejected');
    expect(f).toBeTruthy();
    expect(f.tipDeltaCents).toBe(-500);
    expect(f.periods).toEqual(['2026-02']);
    expect(f.message).toMatch(/500¢ ACIMA do razão em 2026-02/);
  });
});

/**
 * APLICADO e PENDENTE não se somam — o achado fechado, dentro do conserto dele.
 *
 * `resumoDoReparo` juntava as três fontes num escalar só, e elas não querem
 * dizer a mesma coisa: `tip` é um delta JÁ APLICADO (a base exibida mudou),
 * `rejeitados`/`ackPerdido` são deltas que PERSISTEM.
 *
 * Medido pela revisão de segurança de 2026-09-10 (HIGH-1):
 *  - reparado −500 (fev) + recusado −500 (mar) = "1000¢ de diferença em
 *    2026-02, 2026-03", e nenhum dos dois períodos tem 1000¢: metade já foi
 *    corrigida;
 *  - reparado −500 + recusado +500 = ZERO, e a linha inteira sumia — o delta
 *    pendente não chegava em ninguém;
 *  - recusado +500 sozinho imprimia "o valor do razão é o menor e é o seguro",
 *    que nesse sinal manda distribuir pelo MAIOR — a direção que o CLT art. 462
 *    não desfaz.
 *
 * Os dois últimos são LATENTES hoje: o laço recusa linha à frente em qualquer
 * perna, então `deltaGorjeta ≤ 0` sempre. Mas era invariante não dita a três
 * funções de distância de onde é imposta.
 */
describe('a folha sai em duas cláusulas', () => {
  const { resumoDoReparo } = require('../_lib/checks/reconcile');
  const { formatReconcileAlert } = require('../_lib/checks/reconcile-daily');

  const relatorioCom = (pia) => {
    const r = resumoDoReparo(pia);
    return {
      at: '2026-09-10T04:10:00.000Z', venuesChecked: 1, venuesRed: 0, orphanMoneyEvents: 0,
      rowsRepaired: (pia.repaired || []).length, rowsRepairAckLost: (pia.ackLost || []).length,
      rowsRepairRejected: (pia.rejected || []).length, rowsRepairRaced: 0,
      // POR CASA, como o relatório de verdade monta.
      repairTipByVenue: [{
        venueId: 'v1', name: 'Boteco',
        applied: r.deltaGorjetaAplicado, appliedPeriods: r.periodosAplicado,
        pending: r.deltaGorjetaPendente, pendingPeriods: r.periodosPendente,
      }].filter((v) => v.applied !== 0 || v.pending !== 0),
      red: [], venues: [], infoCodes: [], totalDriftCents: 0,
    };
  };

  test('aplicado e pendente saem SEPARADOS, cada um com o seu mês', () => {
    const alerta = formatReconcileAlert(relatorioCom({
      repaired: ['a'],
      tip: [{ txid: 'a', deltaCents: -500, periodo: '2026-02' }],
      rejected: [{ txid: 'b', deltaCents: -500, periodo: '2026-03' }],
    }));
    expect(alerta).toMatch(/• Boteco/);
    expect(alerta).toMatch(/já corrigida\): 500¢ em 2026-02/);
    expect(alerta).toMatch(/AINDA divergente\): 500¢ em 2026-03/);
    // E NUNCA a soma dos dois num número que não é de período nenhum.
    expect(alerta).not.toMatch(/1000¢/);
  });

  test('sinais opostos não CANCELAM a cláusula pendente', () => {
    const alerta = formatReconcileAlert(relatorioCom({
      repaired: ['a'],
      tip: [{ txid: 'a', deltaCents: -500, periodo: '2026-02' }],
      rejected: [{ txid: 'b', deltaCents: 500, periodo: '2026-03' }],
    }));
    expect(alerta).toMatch(/AINDA divergente\): 500¢ em 2026-03/);
  });

  test('o lado SEGURO sai do sinal, não de uma frase fixa', () => {
    const negativo = formatReconcileAlert(relatorioCom({
      rejected: [{ txid: 'b', deltaCents: -500, periodo: '2026-03' }],
    }));
    expect(negativo).toMatch(/o valor do razão é o MENOR e é o seguro/);

    const positivo = formatReconcileAlert(relatorioCom({
      rejected: [{ txid: 'b', deltaCents: 500, periodo: '2026-03' }],
    }));
    // Com este sinal o razão é o MAIOR: dizer "o menor é o seguro" mandaria a
    // casa distribuir pelo número maior.
    expect(positivo).toMatch(/o valor do razão é o MAIOR/);
    expect(positivo).not.toMatch(/MENOR/);
  });

  test('noite sem folha mexida não imprime cláusula nenhuma', () => {
    expect(formatReconcileAlert(relatorioCom({}))).toBe(null);
  });
});
