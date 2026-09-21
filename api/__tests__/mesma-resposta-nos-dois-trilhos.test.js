'use strict';

/**
 * A MESMA CASA, O MESMO CORPO, A MESMA RESPOSTA — nos dois trilhos.
 *
 * `/api/pay` passa pela fábrica (`create-charge`); `/api/pay/stripe-intent`
 * monta a cobrança inline. Duas cópias da mesma sequência de portões, e a série
 * inteira de revisões deste repositório é, em boa parte, a história de uma
 * regra chegando numa cópia e não na outra: o portão de mercado, o `payerLabel`,
 * o teto de pendentes, o teto da gorjeta.
 *
 * A rodada anterior "centralizou" o teto da gorjeta e mediu o resultado com uma
 * regex procurando o literal da chamada nos dois arquivos. A regex casou nos
 * dois. O que ela não podia ver:
 *
 *  · em `router.js` a função era chamada e NUNCA IMPORTADA — `ReferenceError`
 *    em toda requisição ao trilho de cartão, que ficou inteiro em 500;
 *  · a chamada estava ACIMA do portão de mercado, então a resposta divergia de
 *    novo — só que em outro par de códigos.
 *
 * E depois de consertar a ordem do teto, a re-revisão mediu: CINCO outros
 * portões continuavam rodando antes do mercado, e trocar a ordem de volta
 * matava ZERO testes. Comentário sem guarda embaixo.
 *
 * Este arquivo é o guarda. Ele não confere código-fonte: manda o MESMO corpo
 * pros DOIS trilhos e exige o MESMO código de volta.
 */

const http = require('node:http');

const KEY_ANTES = process.env.STRIPE_SECRET_KEY;
process.env.STRIPE_SECRET_KEY = 'sk_test_naoexiste';   // falsa: nada aqui chega à Stripe
let route; let store;
jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
if (KEY_ANTES === undefined) delete process.env.STRIPE_SECRET_KEY;
else process.env.STRIPE_SECRET_KEY = KEY_ANTES;

let srv; let porta;
beforeAll(async () => {
  srv = http.createServer(route).listen(0);
  await new Promise((r) => srv.once('listening', r));
  porta = srv.address().port;
});
afterAll(() => srv && srv.close());

let ip = 0;
async function nos_dois(token, corpo) {
  ip += 1;
  const bater = async (rota, extra) => {
    const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': `10.0.${ip % 250}.${(ip * 7) % 250}` },
      body: JSON.stringify({ token, ...corpo, ...extra }),
    });
    return (await r.json()).code;
  };
  return {
    pix: await bater('/api/pay', {}),
    cartao: await bater('/api/pay/stripe-intent', { rail: 'card' }),
  };
}

/** Uma casa, um mercado, uma mesa com conta aberta. */
async function mesa({ market = 'br', total = 10_000 } = {}) {
  const venue = store.seedVenue({ name: `Casa ${Math.random()}`, servicoBp: 1000, pspRecipientId: 'rcpt_x', market });
  await store.setVenueStripeAccount(venue.id, 'acct_teste123');
  const table = store.seedTable(venue.id, `Mesa ${Math.random()}`);
  await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: total }]);
  return { venue, table };
}

describe('os dois trilhos respondem a mesma coisa pro mesmo corpo', () => {
  test('gorjeta acima do total da conta', async () => {
    const { table } = await mesa();
    const r = await nos_dois(table.qrToken, { amountCents: 100, tipCents: 9_000_000_000 });
    expect(r.pix).toBe(r.cartao);
    expect(r.pix).toBe('amount_invalid');
  });

  test('mercado DESLIGADO vence o detalhe do corpo — gorjeta alta', async () => {
    // O `create-charge` argumenta por extenso que o erro de mercado tem que
    // vencer o de forma, pra uma casa mal configurada não ficar escondida
    // atrás de um número que o cliente digitou.
    const { table } = await mesa({ market: 'es' });
    const r = await nos_dois(table.qrToken, { amountCents: 100, tipCents: 9_000_000_000 });
    expect(r.pix).toBe(r.cartao);
  });

  test('mercado DESLIGADO vence o detalhe do corpo — valor acima do que falta', async () => {
    // Esta é a que a re-revisão mediu divergindo: `market_not_live` no Pix e
    // `amount_over` no cartão, depois de a ordem do TETO já ter sido
    // consertada. Um código de seis.
    const { table } = await mesa({ market: 'es' });
    const r = await nos_dois(table.qrToken, { amountCents: 999_999, tipCents: 0 });
    expect(r.pix).toBe(r.cartao);
  });

  test('razão VAZIO: a conta que não existe se chama igual nos dois', async () => {
    const { table } = await mesa();
    const vista = await store.getCheckByQrToken(table.qrToken);
    const carregar = store.loadEvents.bind(store);
    store.loadEvents = async (id) => (id === vista.check.id ? [] : carregar(id));
    try {
      const r = await nos_dois(table.qrToken, { amountCents: 100, tipCents: 0 });
      expect(r.pix).toBe(r.cartao);
      expect(r.pix).toBe('check_not_found');
    } finally {
      store.loadEvents = carregar;
    }
  });
});
