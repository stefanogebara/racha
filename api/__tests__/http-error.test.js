'use strict';

const { errorStatus, errorBody } = require('../_lib/http-error');
const { createChargeService } = require('../_lib/pay/create-charge');
const { createMemoryStore } = require('../_lib/store/memory');
const { MockPsp } = require('../_lib/pay/mock-psp');

describe('a forma de um erro na rede', () => {
  test('o CÓDIGO e os vars viajam num 4xx', () => {
    // O bug que este teste fecha: o `catch` do router devolvia só
    // `err.message`, então todo erro do caminho do dinheiro chegava ao cliente
    // como uma FRASE EM PORTUGUÊS e sem código. O `tError` do cliente, sem
    // código, cai no texto cru — um espanhol lendo português na hora de pagar.
    // O CLAUDE.md é explícito: o servidor manda `code` + centavos crus, e quem
    // traduz e formata é o cliente, que sabe o idioma do leitor.
    const err = Object.assign(new Error('valor acima do teto'), {
      statusCode: 400, code: 'amount_over_max', vars: { maxCents: 500000 },
    });
    expect(errorStatus(err)).toBe(400);
    expect(errorBody(err)).toEqual({
      success: false,
      code: 'amount_over_max',
      vars: { maxCents: 500000 },
    });
  });

  test('com código, a MENSAGEM interna não viaja', () => {
    // A primeira versão desta correção mandava as duas coisas: o código E a
    // frase. A frase era só reserva pro cliente, mas ia pra qualquer diner sem
    // autenticação nomeando internos — "psp pagarme não emite em eur"
    // identifica o adquirente daquela casa, "market es: market_not_live" conta
    // que a Espanha existe e não está no ar, e numa falha de webhook a frase
    // carrega o erro da própria Stripe, o que vira um oráculo de assinatura
    // ("no signatures found" contra "timestamp outside tolerance"). Achado pela
    // revisão de segurança.
    const psp = Object.assign(new Error('psp pagarme não emite em eur'), {
      statusCode: 400, code: 'psp_market_mismatch',
    });
    const body = errorBody(psp);
    expect(body).toEqual({ success: false, code: 'psp_market_mismatch' });
    expect(JSON.stringify(body)).not.toContain('pagarme');

    // Este pedaço estava ERRADO e passava: eu montava o erro à mão com
    // `code: 'webhook_invalid'`, um código que nenhum caminho de produção
    // punha. Provava o redator, não o buraco — a `WebhookVerificationError`
    // real não tinha código, então a mensagem viajava e o oráculo continuava
    // aberto. Agora o teste usa a classe DE VERDADE, dos três adaptadores.
    const { WebhookVerificationError: WhStripe } = require('../_lib/pay/stripe-psp');
    const { WebhookVerificationError: WhPagarme } = require('../_lib/pay/pagarme-psp');
    const { WebhookVerificationError: WhMock } = require('../_lib/pay/mock-psp');
    for (const Cls of [WhStripe, WhPagarme, WhMock]) {
      const wh = new Cls('assinatura Stripe inválida: No signatures found matching the expected signature for payload');
      expect(errorStatus(wh)).toBe(401);
      const body = errorBody(wh);
      expect(body).toEqual({ success: false, code: 'webhook_invalid' });
      const txt = JSON.stringify(body);
      // Nada que diga a quem está tentando o que ajustar na próxima.
      expect(txt).not.toMatch(/signature|timestamp|tolerance|Stripe|assinatura/i);
    }
  });

  test('um 500 não vaza mensagem interna', () => {
    // 500 não mapeado costuma vir do PostgREST/Postgres, e a mensagem carrega
    // nome de tabela e de coluna. Loga inteiro, devolve código estável.
    const pg = Object.assign(new Error('column venues.market does not exist'), { statusCode: 500 });
    expect(errorBody(pg)).toEqual({ success: false, error: 'erro interno', code: 'internal' });
    // Erro sem status é 500 pelo mesmo caminho.
    const boom = new Error('undefined is not a function');
    expect(errorStatus(boom)).toBe(500);
    expect(errorBody(boom).error).toBe('erro interno');
    expect(JSON.stringify(errorBody(boom))).not.toContain('undefined is not a function');
  });

  test('webhook com assinatura ruim é 401, não 500', () => {
    const wh = Object.assign(new Error('bad signature'), { name: 'WebhookVerificationError' });
    expect(errorStatus(wh)).toBe(401);
  });

  test('erro SEM código ainda manda a frase — senão o integrador fica sem nada', () => {
    // Estes são erros de contrato de quem integra ("checkId required"), não de
    // quem está na mesa. A saída certa é dar código a eles, não emudecer.
    const plain = Object.assign(new Error('checkId required'), { statusCode: 400 });
    expect(errorBody(plain)).toEqual({ success: false, error: 'checkId required' });
    expect('code' in errorBody(plain)).toBe(false);
  });
});

describe('o portão de dinheiro fala em códigos de ponta a ponta', () => {
  // A prova que importa: o erro que o `create-charge` LEVANTA, passado pela
  // mesma função que o router usa, chega com código traduzível.
  async function fixture(market) {
    const store = createMemoryStore();
    const venue = await store.seedVenue({
      name: `casa-${market}`, servicoBp: 1000, pspRecipientId: 'rcpt_demo', market,
    });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 600000 }]);
    return { check, charge: createChargeService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(24) }) }) };
  }

  const prev = process.env.RACHA_ES_ENABLED;
  beforeAll(() => { process.env.RACHA_ES_ENABLED = 'true'; });
  afterAll(() => {
    if (prev === undefined) delete process.env.RACHA_ES_ENABLED;
    else process.env.RACHA_ES_ENABLED = prev;
  });

  test('o teto do Bizum chega na tela com o limite em CENTAVOS', async () => {
    const { check, charge } = await fixture('es');
    const err = await charge({ checkId: check.id, amountCents: 600000, rail: 'bizum' }).catch((e) => e);
    const body = errorBody(err);
    expect(body.code).toBe('amount_over_max');
    expect(body.error).toBeUndefined();
    // Centavos crus, nunca "5.000,00 €": quem escolhe o separador e a posição
    // do símbolo é o cliente, que sabe o idioma.
    expect(body.vars).toEqual({ maxCents: 500000 });
    expect(JSON.stringify(body.vars)).not.toMatch(/€|R\$|,\d\d/);
  });

  test('trilho errado e mercado desligado chegam como código, não como frase', async () => {
    const es = await fixture('es');
    expect(errorBody(await es.charge({ checkId: es.check.id, amountCents: 100, rail: 'pix' }).catch((e) => e)).code)
      .toBe('rail_unsupported');

    delete process.env.RACHA_ES_ENABLED;
    const closed = await fixture('es');
    expect(errorBody(await closed.charge({ checkId: closed.check.id, amountCents: 100, rail: 'bizum' }).catch((e) => e)).code)
      .toBe('market_not_live');
    process.env.RACHA_ES_ENABLED = 'true';
  });
});
