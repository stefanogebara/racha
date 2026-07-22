'use strict';

/**
 * Demo isolation (blindagem do go-live).
 *
 * A mesa pública de demonstração — o link `?t=demoracha` que a Olímpia manda pros
 * leads — paga pelo SEU PRÓPRIO MockPsp e se auto-confirma. Ela NUNCA pode tocar
 * o PSP real: com `sk_live_` ligado, um lead pagando a "conta de mentira" seria
 * cobrado de verdade (ou o demo quebraria, porque o recebedor de teste não existe
 * em live). Este teste espelha o stack que o router monta pro demo
 * (demoPsp + demoCharge + demoWebhook) e prova as duas garantias.
 */

const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce, STATUS } = require('../_lib/checks/check-state');

const SECRET = 'demo-webhook-secret-0123456789';

// Stand-in do PSP LIVE: toda chamada estoura, igual ao degrade "unconfigured"
// (503) do router. Se o demo alguma vez roteasse pra cá, o teste explode.
function livePspThatMustNeverBeCalled() {
  const boom = () => { throw new Error('LIVE PSP tocado pelo demo — isolamento quebrado'); };
  return {
    provider: 'live', createPixCharge: boom, createWalletCharge: boom,
    verifyAndParseWebhook: boom, getRecipient: async () => null, getRecipientBalance: async () => null,
  };
}

function demoWorld() {
  const store = createMemoryStore();
  const demoPsp = new MockPsp({ webhookSecret: SECRET });
  const demoCharge = createChargeService({ store, psp: demoPsp });
  const demoWebhook = createWebhookHandler({
    loadEvents: store.loadEvents.bind(store),
    appendEvent: store.appendEvent.bind(store),
    recordPayment: store.recordPayment.bind(store),
    findCheckByTxid: store.findCheckByTxid.bind(store),
    psp: demoPsp,
  });
  const venue = store.seedVenue({ name: 'Bar do Racha (demo)' }); // pspRecipientId default 'rcpt_demo'
  const table = store.seedTable(venue.id, 'Mesa 1');
  return { store, demoPsp, demoCharge, demoWebhook, venue, table };
}

// Reproduz exatamente o caminho do /api/pay pro demo: cobra pelo mock e auto-confirma.
async function demoPay({ demoCharge, demoWebhook, demoPsp, checkId, amountCents, tipCents = 0 }) {
  const result = await demoCharge({ checkId, amountCents, tipCents, payerLabel: 'Cliente Demo' });
  const { rawBody, signature } = demoPsp.buildConfirmationWebhook({
    txid: result.txid, amountCents: result.amountCents, tipCents: result.tipCents,
    payerName: 'Cliente Demo', method: result.method,
  });
  await demoWebhook(rawBody, { 'x-racha-signature': signature });
  return result;
}

describe('demo isolation — a conta de mentira nunca toca o PSP real', () => {
  test('demo paga pelo mock (txid mock…) e se auto-confirma pra PAGA', async () => {
    const w = demoWorld();
    const check = await w.store.openCheck(w.table.qrToken, [
      { id: 'i1', name: 'Picanha', priceCents: 8990 },
      { id: 'i2', name: 'Chopp', priceCents: 5560 },
    ]);
    const total = 8990 + 5560;
    const result = await demoPay({ ...w, checkId: check.id, amountCents: total, tipCents: 1000 });

    expect(result.txid).toMatch(/^mock/); // MockPsp, jamais o adquirente real
    const state = reduce(await w.store.loadEvents(check.id));
    expect(state.status).toBe(STATUS.PAGA);
    expect(state.paidCents).toBe(total);
    expect(state.tipCents).toBe(1000); // gorjeta do demo também é fake
  });

  test('se o demo estivesse no PSP live, a cobrança estouraria — por isso usa o mock', async () => {
    const store = createMemoryStore();
    const live = livePspThatMustNeverBeCalled();
    const liveCharge = createChargeService({ store, psp: live });
    const venue = store.seedVenue({ name: 'Demo' });
    const table = store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i1', name: 'X', priceCents: 100 }]);
    // Contraste: no PSP live isso explode; o demo (mock) do teste acima passa.
    await expect(liveCharge({ checkId: check.id, amountCents: 100 })).rejects.toThrow(/LIVE PSP tocado/);
  });
});
