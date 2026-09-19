'use strict';

/**
 * O INTERRUPTOR DA CARTEIRA, MEDIDO PELA ROTA INTEIRA.
 *
 * Este arquivo existe por causa de um defeito que TRÊS testes não viram, e a
 * forma deles é a lição:
 *
 *  - dois censos de texto (`ROUTER.indexOf('body.wallet && !carteiraLiberada')`)
 *    provavam que a linha EXISTE e que vem antes da cobrança. Nenhum dos dois
 *    consegue ver o que ela AVALIA;
 *  - os testes unitários chamavam `carteiraLiberada('casa-a')` com o id passado
 *    à mão, então nunca repararam que quem chama NÃO TEM id pra passar.
 *
 * O id vinha de `view.venue`, que é a projeção PÚBLICA — `/api/check` não tem
 * autenticação, e ela não carrega `id` de propósito. Resultado:
 * `carteiraLiberada(undefined)`, sempre falso. O interruptor ficou sem posição
 * "ligado": com o id da casa-piloto na env, o POST respondia `rail_unsupported`
 * do mesmo jeito, e o `*` não salva porque é desligado contra a Pagar.me real.
 *
 * Achado pela sexta revisão de segurança (2026-09-19, HIGH-1) — que mediu a
 * rota em vez de ler a linha. É isso que este arquivo passa a fazer.
 */

const { Readable } = require('node:stream');
const { route, store } = require('../_app/router');

function pedir(method, url, body) {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from([body ? JSON.stringify(body) : '']), {
      method,
      url,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
      socket: { remoteAddress: '9.9.9.9' },
    });
    const pedacos = [];
    let status = 0;
    const res = {
      statusCode: 200,
      setHeader() {}, getHeader() {},
      writeHead(s) { status = s; },
      write(c) { pedacos.push(c); },
      end(c) {
        if (c) pedacos.push(c);
        let corpo = pedacos.join('');
        try { corpo = JSON.parse(corpo); } catch { /* deixa cru */ }
        resolve({ status: status || res.statusCode, corpo });
      },
    };
    route(req, res).catch((e) => resolve({ status: -1, corpo: { erro: e.message } }));
  });
}

const com = async (valor, f) => {
  const antes = process.env.RACHA_WALLET_VENUES;
  if (valor === undefined) delete process.env.RACHA_WALLET_VENUES;
  else process.env.RACHA_WALLET_VENUES = valor;
  try { return await f(); } finally {
    if (antes === undefined) delete process.env.RACHA_WALLET_VENUES;
    else process.env.RACHA_WALLET_VENUES = antes;
  }
};

async function mesa() {
  const venue = await store.seedVenue({ name: 'Bar', servicoBp: 1000, pspRecipientId: 're_real' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  await store.openCheck(table.qrToken, [{ id: 'i', name: 'Prato', priceCents: 10000 }]);
  return { venue, table };
}

const pagarComCarteira = (token, tok) => pedir('POST', '/api/pay', {
  token, amountCents: 1000, tipCents: 0,
  wallet: 'google_pay', paymentToken: tok, payerDocument: '52998224725',
});

describe('o interruptor tem posição LIGADO', () => {
  test('com o id da casa na env, o POST CHEGA no adquirente', async () => {
    const { venue, table } = await mesa();
    const r = await com(venue.id, () => pagarComCarteira(table.qrToken, 'tok-invalido'));
    /**
     * 402 é o adquirente RECUSANDO o token — ou seja, o pedido passou do nosso
     * portão e chegou lá, que é exatamente o que se quer provar. O que NÃO pode
     * acontecer é `rail_unsupported`, que quer dizer que nunca saiu daqui.
     */
    expect(r.corpo.code).not.toBe('rail_unsupported');
    expect(r.status).not.toBe(400);
  });

  test('sem a env, o POST é barrado — e a lista é o que decide', async () => {
    const { table } = await mesa();
    const r = await com(undefined, () => pagarComCarteira(table.qrToken, 'tok'));
    expect(r.status).toBe(400);
    expect(r.corpo.code).toBe('rail_unsupported');
  });

  test('com OUTRA casa na lista, esta segue barrada', async () => {
    const { table } = await mesa();
    const r = await com('11111111-1111-1111-1111-111111111111',
      () => pagarComCarteira(table.qrToken, 'tok'));
    expect(r.corpo.code).toBe('rail_unsupported');
  });

  /**
   * O Pix não passa por este portão: ele não captura nada, e o interruptor
   * existe pra decidir quais casas podem CAPTURAR cartão.
   */
  test('o Pix nunca é barrado pelo interruptor da carteira', async () => {
    const { table } = await mesa();
    const r = await com(undefined, () => pedir('POST', '/api/pay', {
      token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725',
    }));
    expect(r.corpo.code).not.toBe('rail_unsupported');
  });
});

describe('`carteiraLiberada` recusa um id que não é id', () => {
  const { carteiraLiberada } = require('../_app/router');

  /**
   * `String(undefined)` é `'undefined'` — uma string legítima, que entraria na
   * comparação com a lista. Inerte hoje, mas é a coerção que transforma um
   * deslize de template num interruptor aberto pra TODAS as casas.
   */
  test.each([[undefined], [null], [''], ['   '], [123], [{}]])(
    '%p não abre a carteira nem com a lista cheia', async (id) => {
      // `com` é assíncrono; sem o await isto comparava uma Promise com `false`,
      // que falha — mas falharia IGUAL se a função devolvesse `true`.
      await expect(com('casa-a,undefined,null', () => carteiraLiberada(id))).resolves.toBe(false);
    },
  );

  test('e o id de verdade continua abrindo — senão o teste acima é vácuo', async () => {
    await expect(com('casa-a', () => carteiraLiberada('casa-a'))).resolves.toBe(true);
  });
});
