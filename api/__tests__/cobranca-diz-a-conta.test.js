'use strict';

/**
 * A COBRANÇA DIZ EM QUE CONTA NASCEU — nos dois trilhos.
 *
 * O telefone prendia o recibo ao `check.id` que o poll trouxesse ao entrar em
 * "pago", e três dos quatro caminhos até lá fazem `await refresh()` antes: se a
 * conta trocava nesse meio-tempo (a demo renovando, ou o garçom abrindo a
 * próxima mesa no mesmo QR), o recibo se prendia à conta NOVA e voltava a
 * mostrar o progresso e o "pagar mais" dos outros. Só quem cobrou sabe em que
 * conta cobrou — então a cobrança passou a dizer.
 *
 * E o trilho de cartão tinha um segundo jeito de perder isso: o
 * `StripeWalletPay` montava o `onPaid` à mão com `{ amountCents, tipCents }` e
 * jogava fora o que o servidor mandasse. Acrescentar o campo só no servidor não
 * teria mudado nada ali.
 */

const http = require('node:http');

const ANTES = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY };
process.env.STRIPE_SECRET_KEY = 'sk_test_naoexiste';
let route; let store;
jest.isolateModules(() => {
  // A Stripe de mentira, na FRONTEIRA do SDK: a rota roda inteira, só a ida à
  // rede é trocada. `paymentIntents.create` é a chamada do intent.
  jest.doMock('stripe', () => () => ({
    paymentIntents: {
      create: async () => ({ id: `pi_${Math.random().toString(36).slice(2)}`, client_secret: 'cs_teste', status: 'requires_payment_method' }),
    },
    webhooks: { constructEvent: () => { throw new Error('não usado aqui'); } },
  }));
  ({ route, store } = require('../_app/router'));
});
for (const [k, v] of Object.entries(ANTES)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

let srv; let porta;
beforeAll(async () => {
  srv = http.createServer(route).listen(0);
  await new Promise((r) => srv.once('listening', r));
  porta = srv.address().port;
});
afterAll(() => srv && srv.close());

async function mesa() {
  const venue = store.seedVenue({ name: `Casa ${Math.random()}`, servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  await store.setVenueStripeAccount(venue.id, 'acct_teste123');
  const table = store.seedTable(venue.id, `Mesa ${Math.random()}`);
  await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 10_000 }]);
  const view = await store.getCheckByQrToken(table.qrToken);
  return { table, view };
}
const post = (rota, corpo) => fetch(`http://127.0.0.1:${porta}${rota}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-real-ip': `10.4.${Math.floor(Math.random() * 250)}.9` },
  body: JSON.stringify(corpo),
}).then(async (r) => ({ status: r.status, corpo: await r.json() }));

test('Pix: `/api/pay` devolve a conta em que a cobrança nasceu', async () => {
  const { table, view } = await mesa();
  const r = await post('/api/pay', { token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725' });
  expect(r.status).toBe(200);
  expect(r.corpo.data.checkId).toBe(view.check.id);
});

test('cartão: `/api/pay/stripe-intent` também devolve', async () => {
  const { table, view } = await mesa();
  const r = await post('/api/pay/stripe-intent', { token: table.qrToken, amountCents: 1000, tipCents: 0, rail: 'card' });
  expect(`${r.status} ${r.corpo.code || ''}`.trim()).toBe('200');
  expect(r.corpo.data.checkId).toBe(view.check.id);
});

test('o id da casa continua fora — só a CONTA foi acrescentada', async () => {
  // `venueId` é interno (o `/api/check` o omite de propósito, e o
  // `pay-nao-vaza-casa.test.js` prende isso). O `checkId` já é público.
  const { table } = await mesa();
  const r = await post('/api/pay', { token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725' });
  expect(r.corpo.data.venueId).toBeUndefined();
});
