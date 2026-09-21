'use strict';

/**
 * O INTERRUPTOR DA CARTEIRA, MEDIDO PELA ROTA INTEIRA.
 *
 * Este arquivo existe por causa de um defeito que TRÊS testes não viram, e a
 * forma deles é a lição:
 *
 *  - três censos de texto (`ROUTER.indexOf('body.wallet && !carteiraLiberada')`)
 *    provavam que a linha EXISTE e que vem antes da cobrança. Nenhum deles
 *    consegue ver o que ela AVALIA — e os três foram apagados em `a3178da`,
 *    depois de uma revisão plantar o mutante que os mantinha satisfeitos
 *    enquanto reintroduzia o defeito;
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

/**
 * ANTES DE IMPORTAR O ROTEADOR: ele resolve `store` e `psp` no LOAD do módulo,
 * a partir da env.
 *
 * Este arquivo monta o `route()` de verdade e SEMEIA casas, mesas e contas. Com
 * `RACHA_STORE=supabase RACHA_PSP=pagarme` exportados no shell — o que não é
 * hipótese, é exatamente o que o `scripts/psp-acceptance.js` precisa — um
 * `npx jest` inseria casas no banco de PRODUÇÃO e mandava uma cobrança de
 * carteira de verdade pra Pagar.me.
 *
 * Os outros testes que montam o roteador ou injetam o próprio store ou isolam o
 * módulo. Este não fazia nem um nem outro (sétima revisão de segurança,
 * 2026-09-19, LOW-1). O guarda vem ANTES do `require`, porque depois dele o
 * cliente já foi construído.
 */
for (const [chave, proibido] of [['RACHA_STORE', 'supabase'], ['RACHA_PSP', 'pagarme']]) {
  if ((process.env[chave] || '').trim() === proibido) {
    throw new Error(
      `${chave}=${proibido} no ambiente: este arquivo SEMEIA dados e COBRA pelo roteador real. `
      + 'Rode a suíte sem essa env.',
    );
  }
}

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

/**
 * Conta as idas ao adquirente durante a chamada.
 *
 * Os censos de texto apagados afirmavam uma coisa que o arquivo novo não
 * afirmava: que o guarda vem ANTES da cobrança. Sem isto, um portão movido pra
 * DEPOIS do `charge()` continuaria verde — os testes de bloqueio só olhavam o
 * `code` da resposta, e ele seguiria `rail_unsupported`. Hoje passa por sorte,
 * porque o token da fixture (`'tok'`) é recusado pelo MockPsp antes; no dia em
 * que alguém "melhorar" a fixture pra um `tok_…` bem formado, o teste ficaria
 * verde sobre uma CAPTURA numa casa com o interruptor desligado.
 * Oitava revisão de compliance (2026-09-19, MEDIUM-2).
 */
async function contandoCobrancas(f) {
  const { psp } = require('../_app/router');
  const original = psp.createWalletCharge.bind(psp);
  const chamadas = [];
  psp.createWalletCharge = async (...a) => { chamadas.push(a[0]); return original(...a); };
  try { return { r: await f(), chamadas }; } finally { psp.createWalletCharge = original; }
}

const pagarComCarteira = (token, tok) => pedir('POST', '/api/pay', {
  token, amountCents: 1000, tipCents: 0,
  wallet: 'google_pay', paymentToken: tok, payerDocument: '52998224725',
});

describe('o interruptor tem posição LIGADO', () => {
  test('com o id da casa na env, o POST CHEGA no adquirente', async () => {
    const { venue, table } = await mesa();
    /**
     * ESPIÃO, e não dupla negativa. A versão anterior afirmava só
     * `code !== 'rail_unsupported'` e `status !== 400` — um 500 de qualquer
     * lugar, ou a rejeição do próprio harness, deixava o teste verde enquanto
     * o nome dele prometia "chega no adquirente". Agora o adaptador é medido.
     */
    const { r, chamadas } = await contandoCobrancas(
      () => com(venue.id, () => pagarComCarteira(table.qrToken, 'tok-invalido')),
    );
    expect(chamadas).toHaveLength(1);
    /**
     * 402 é o adquirente RECUSANDO o token — ou seja, o pedido passou do nosso
     * portão e chegou lá, que é exatamente o que se quer provar. O que NÃO pode
     * acontecer é `rail_unsupported`, que quer dizer que nunca saiu daqui.
     */
    expect(r.corpo.code).not.toBe('rail_unsupported');
    expect(r.status).not.toBe(400);
  });

  test('sem a env, o POST é barrado ANTES do adquirente', async () => {
    const { table } = await mesa();
    const { r, chamadas } = await contandoCobrancas(
      () => com(undefined, () => pagarComCarteira(table.qrToken, 'tok_abcdefgh')),
    );
    expect(r.status).toBe(400);
    expect(r.corpo.code).toBe('rail_unsupported');
    // O guarda vem ANTES da cobrança — é isto que o `code` da resposta sozinho
    // não distingue de um guarda movido pra depois do `charge()`.
    expect(chamadas).toHaveLength(0);
  });

  test('com OUTRA casa na lista, esta segue barrada e nada é cobrado', async () => {
    const { table } = await mesa();
    const { r, chamadas } = await contandoCobrancas(
      () => com('11111111-1111-1111-1111-111111111111',
        () => pagarComCarteira(table.qrToken, 'tok_abcdefgh')),
    );
    expect(r.corpo.code).toBe('rail_unsupported');
    expect(chamadas).toHaveLength(0);
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

/**
 * A DEMO, MEDIDA PELA ROTA.
 *
 * O conserto que isentou a demo era guardado só por um censo de texto — que é
 * exatamente a cegueira que este arquivo foi escrito pra encerrar. E o defeito
 * que ele deveria pegar (botão morto na landing) é comportamento, não texto.
 * Sétima revisão de compliance, 2026-09-19 (MEDIUM-1).
 */
/**
 * O NOME DO TRILHO É CONFERIDO ANTES DE IR AO BANCO.
 *
 * `body.wallet` só precisava ser truthy pra custar um `getVenueForCheck`:
 * `{token, wallet: 1}` gastava duas idas ao banco sem consumir vaga de
 * cobrança nenhuma, numa rota pública que qualquer um com uma foto do QR
 * alcança. Sétima revisão de segurança, 2026-09-19 (LOW-5).
 */
describe('um trilho que não existe é recusado sem custar ida ao banco', () => {
  test.each([['lixo'], [1], [true], [{}]])(
    'wallet=%p é recusado, e o store não é consultado', async (wallet) => {
      const { table } = await mesa();
      const { store: s } = require('../_app/router');
      const original = s.getVenueForCheck.bind(s);
      let idas = 0;
      s.getVenueForCheck = async (...a) => { idas += 1; return original(...a); };
      let r;
      try {
        r = await com('qualquer-casa', () => pedir('POST', '/api/pay', {
          token: table.qrToken, amountCents: 500, tipCents: 0,
          wallet, paymentToken: 'tok_abcdefgh', payerDocument: '52998224725',
        }));
      } finally { s.getVenueForCheck = original; }
      expect(r.corpo.code).toBe('rail_unsupported');
      expect(idas).toBe(0);
    },
  );

  test('e os dois nomes de verdade seguem em frente', async () => {
    // Senão o teste acima seria satisfeito por recusar TUDO.
    const { venue, table } = await mesa();
    const r = await com(venue.id, () => pagarComCarteira(table.qrToken, 'tok-x'));
    expect(r.corpo.code).not.toBe('rail_unsupported');
  });
});

describe('a demo não é barrada pelo interruptor', () => {
  // `DEMO_TOKEN` é o nome exportado; `DEMO_TABLE_TOKEN` é interno do roteador
  // e vinha `undefined`, então este caso media um 404 e não a isenção da demo
  // (re-revisão de segurança, 2026-09-21).
  const { DEMO_TOKEN: DEMO_TABLE_TOKEN, ensureDemoCheck } = require('../_lib/demo');

  test('carteira na mesa de demonstração passa, com a lista VAZIA', async () => {
    await ensureDemoCheck(store, DEMO_TABLE_TOKEN);
    const r = await com(undefined, () => pedir('POST', '/api/pay', {
      token: DEMO_TABLE_TOKEN, amountCents: 500, tipCents: 0,
      wallet: 'google_pay', paymentToken: 'tok_demo_0123456789',
      payerDocument: '52998224725',
    }));
    // Chegou à cobrança — sem isto o caso media um 404.
    expect(r.corpo.code).not.toBe('check_not_found');
    // O que NÃO pode acontecer é o nosso portão barrar. O que o MockPsp faz
    // com o token depois é outro assunto.
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
