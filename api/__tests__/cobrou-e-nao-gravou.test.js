'use strict';

/**
 * O CARTÃO FOI CAPTURADO E A LINHA NÃO FOI ESCRITA.
 *
 * No trilho de carteira o `createWalletCharge` captura dentro da chamada
 * (Pagar.me v5 captura por padrão) e a linha de `payments` só é escrita depois.
 * Se essa escrita falha — o banco ganhou prazo de 10 s em 2026-09-16, então
 * isso deixou de ser hipotético — o dinheiro saiu e não há onde pendurá-lo.
 *
 * O que a revisão de compliance mediu (HIGH-1 de 2026-09-16) e o que este
 * arquivo prende:
 *
 *  1. O erro subia como 500 `internal`, o cliente lia "algo deu errado, tente
 *     de novo" e o botão do Google Pay continuava ARMADO. Tocar de novo cobra
 *     o cartão outra vez (CDC art. 42).
 *  2. Sem linha de `payments`, o `charge.paid` que chega depois era 409 e o
 *     adquirente desistia: a captura ficava invisível pra conciliação, que
 *     trabalha a partir das NOSSAS linhas.
 *
 * Os dois lados são medidos aqui: a resposta ao cliente, e o desfecho do
 * webhook que chega depois.
 */

const { createChargeService } = require('../_lib/pay/create-charge');
const { applyConfirmedPayment, NON_LEDGER_KINDS } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');

const ITENS = [{ id: 'i', name: 'Prato', priceCents: 10000 }];

async function mundo({ falharGravacao = 0 } = {}) {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Bar', servicoBp: 1000, pspRecipientId: 're_x' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, ITENS);

  /** Quantas vezes o adquirente foi chamado — ou seja, quantas capturas. */
  const capturas = [];
  const psp = {
    currencies: ['brl'],
    async createWalletCharge({ chargeRef }) {
      capturas.push(chargeRef);
      return { txid: `ch_${capturas.length}` };
    },
  };

  let restam = falharGravacao;
  const original = store.registerCharge.bind(store);
  store.registerCharge = async (p) => {
    if (restam > 0) {
      restam -= 1;
      const e = new Error('supabase store registerCharge: AbortError: This operation was aborted');
      throw e;
    }
    return original(p);
  };

  return { store, venue, check, psp, capturas, charge: createChargeService({ store, psp }) };
}

const pagar = (charge, check) => charge({
  checkId: check.id, amountCents: 1000, tipCents: 0,
  wallet: 'google_pay', paymentToken: 'tok', payerDocument: '52998224725', rail: 'pix',
});

describe('a escrita falha DEPOIS de o cartão ser capturado', () => {
  test('uma falha transitória é vencida pela segunda tentativa — e não cobra de novo', async () => {
    const { check, charge, capturas, store } = await mundo({ falharGravacao: 1 });
    const r = await pagar(charge, check);
    expect(r.txid).toBe('ch_1');
    // UMA captura, não duas: a nova tentativa é da ESCRITA, nunca da cobrança.
    expect(capturas).toHaveLength(1);
    expect((await store.getPayment('ch_1')).txid).toBe('ch_1');
  });

  test('falhando duas vezes, o erro tem CÓDIGO próprio — e não é "tente de novo"', async () => {
    const { check, charge, capturas } = await mundo({ falharGravacao: 2 });
    const erro = await pagar(charge, check).catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
    // `internal` viraria "algo deu errado, tente de novo" com o botão armado.
    expect(erro.code).toBe('charge_maybe_captured');
    expect(erro.statusCode).toBe(502);
    // O txid viaja: é por ele que alguém liga a captura órfã à conta.
    expect(erro.txid).toBe('ch_1');
    expect(capturas).toHaveLength(1);
  });

  test('a unicidade na segunda tentativa é SUCESSO — a primeira escreveu e a resposta se perdeu', async () => {
    const { store, check, psp } = await mundo();
    const original = store.registerCharge.bind(store);
    let n = 0;
    store.registerCharge = async (p) => {
      n += 1;
      await original(p);                       // a primeira ESCREVE
      if (n === 1) throw new Error('timeout depois de escrever');
      return undefined;
    };
    const charge = createChargeService({ store, psp });
    // A segunda tentativa bate na unicidade do txid; isso não é erro.
    const r = await pagar(charge, check).catch((e) => e);
    expect(r).not.toBeInstanceOf(Error);
    expect(r.txid).toBe('ch_1');
  });
});

describe('e o webhook que chega depois não some', () => {
  test('`charge.paid` para um txid sem linha vira órfão registrável, não um 409', async () => {
    const { store } = await mundo();
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    const r = await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_orfa', amountCents: 1000, tipCents: 0,
      method: 'card', eventId: 'evt_1', paid: true,
      // O `code` do pedido carrega o `checkId` — é ele que torna a captura
      // órfã RESOLVÍVEL em vez de só visível.
      orderCode: 'uma-conta:0:1000:0',
    }, deps);

    expect(r.status).toBe('money_without_check');
    expect(NON_LEDGER_KINDS.has(r.status)).toBe(true);
    expect(r.raw.amountCents).toBe(1000);
    expect(r.raw.orderCode).toBe('uma-conta:0:1000:0');
  });

  test('e um evento SEM dinheiro para um txid desconhecido segue recusado', async () => {
    const { store } = await mundo();
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    // Ruído de outro ambiente: sem dinheiro confirmado não há o que perder, e
    // registrar tudo encheria a fila de órfãos que ninguém fecha.
    const r = await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_nada', cumulativeRefundedCents: 0, method: 'card', eventId: 'evt_2',
    }, deps);
    expect(r.status).toBe('rejected');
  });
});
