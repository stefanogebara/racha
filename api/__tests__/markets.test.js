'use strict';

const {
  MARKETS, DEFAULT_MARKET, marketCodes, isMarket, market,
  publicMarketView, checkChargeLimits, supportsRail, showsVenueTaxId,
} = require('../_lib/markets');

describe('mercados', () => {
  test('só existem os mercados que abrimos, e o padrão é o Brasil', () => {
    expect(marketCodes().sort()).toEqual(['br', 'es']);
    expect(DEFAULT_MARKET).toBe('br');
  });

  test('mercado desconhecido ou ausente cai no Brasil, nunca em undefined', () => {
    // Toda venue que existia antes deste módulo é brasileira e não tem o campo.
    // Um `undefined.currency` aqui seria uma conta sem moeda.
    for (const bad of [undefined, null, '', 'pt', 'ES', 'fr', 42, {}]) {
      expect(market(bad).code).toBe('br');
      expect(market(bad).currency).toBe('BRL');
    }
    expect(isMarket('es')).toBe(true);
    expect(isMarket('ES')).toBe(false);
  });

  test('cada mercado tem moeda de 2 casas — o motor de centavos não muda', () => {
    // BRL e EUR são ambas de subunidade 100. É por isso que Espanha reusa o
    // split-engine sem uma linha nova: a matemática é a mesma, o rótulo não.
    for (const code of marketCodes()) {
      expect(['BRL', 'EUR']).toContain(market(code).currency);
    }
  });

  describe('serviço / gorjeta', () => {
    test('Brasil pode vir pré-marcado; Espanha não tem linha de serviço', () => {
      expect(market('br').serviceCharge.mode).toBe('preselected');
      expect(market('es').serviceCharge.mode).toBe('none');
    });

    test('Espanha zera o serviço mesmo com a venue configurada em 10%', () => {
      // O dono cadastrou 1000bp (herança do formulário brasileiro). A conta em
      // Madrid não cobra serviço de qualquer forma: quem decide é o mercado.
      const es = publicMarketView('es', { servicoBp: 1000 });
      expect(es.serviceCharge.bp).toBe(0);
      // `cnpj` é preciso: a linha de serviço só aparece onde pode ser cobrada.
      const br = publicMarketView('br', { servicoBp: 1000, cnpj: '11444777000161' });
      expect(br.serviceCharge.bp).toBe(1000);
    });

    test('sem documento de empresa provado, a linha de serviço nem é OFERECIDA', () => {
      // O `marketGate` já recusava a cobrança; a tela seguia oferecendo. O
      // cliente via o serviço pré-marcado, somado no total, tocava em pagar e
      // levava a recusa — beco sem saída no caminho padrão. Não é oferta
      // descumprida (a cobrança não acontece), mas é um total mostrado que a
      // casa não pode receber. Achado pela revisão de compliance de 2026-09-13.
      for (const cnpj of [null, '52998224725', '99999999999999', '  ']) {
        const v = publicMarketView('br', { servicoBp: 1000, cnpj });
        expect(v.serviceCharge.bp).toBe(0);
        expect(v.servicoBp).toBe(0);
        // E o MODO, que é o que o cliente lê pra decidir se DESENHA a linha.
        // Zerar só o valor deixava uma caixa marcada de "Serviço da equipe
        // (0%)" na tela — duas verdades no mesmo payload.
        expect(v.serviceCharge.mode).toBe('none');
      }
      // E com documento, a linha volta.
      expect(publicMarketView('br', { servicoBp: 1000, cnpj: '11.444.777/0001-61' }).serviceCharge.bp)
        .toBe(1000);
    });

    test('nenhum mercado pré-marca uma gorjeta opcional', () => {
      // `optIn` existe pro dia em que a Espanha ganhar propina. Se algum dia
      // alguém marcar por padrão, é aqui que quebra.
      for (const code of marketCodes()) {
        const { mode } = market(code).serviceCharge;
        expect(['preselected', 'optIn', 'none']).toContain(mode);
        if (mode === 'optIn') {
          expect(publicMarketView(code, { servicoBp: 1000 }).serviceCharge.bp).toBe(0);
        }
      }
    });
  });

  describe('documento do pagador', () => {
    test('Brasil exige CPF; Espanha não pede documento no checkout', () => {
      expect(market('br').payerTaxId).toMatchObject({ required: true, kind: 'cpf' });
      expect(market('es').payerTaxId).toMatchObject({ required: false, kind: 'nif' });
    });

    test('o documento da CASA não vai pra tela em Espanha, e vai no Brasil', () => {
    // A mesma coluna guarda CNPJ e NIF, e uma parte grande dos bares
    // espanhóis é de AUTÓNOMO: pessoa física, cujo NIF é o número do DNI dela.
    // Publicar isso pra quem tenha o token de uma mesa — e tokens viajam em
    // links compartilhados e QRs fotografados — é expor o identificador
    // nacional de uma pessoa física. É o mesmo argumento de minimização que
    // tirou o CPF do pagador do metadata da Stripe, apontado pro outro lado.
    //
    // O que destrava: o cadastro saber a forma jurídica da casa. Aí sociedade
    // mostra e autónomo não. Enquanto não se sabe, não mostra.
    expect(showsVenueTaxId('br')).toBe(true);
    expect(showsVenueTaxId('es')).toBe(false);
    // Mercado desconhecido cai no Brasil na LEITURA, e mostrar um CNPJ é o
    // comportamento certo pra toda venue que existia antes da coluna.
    expect(showsVenueTaxId(undefined)).toBe(true);
  });

  test('a view pública não vaza nada além da regra', () => {
      const v = publicMarketView('es', { servicoBp: 0 });
      expect(Object.keys(v.payerTaxId).sort()).toEqual(['kind', 'required']);
    });
  });

  describe('trilhos', () => {
    test('Pix é do Brasil, Bizum é da Espanha, e nenhum atravessa', () => {
      expect(supportsRail('br', 'pix')).toBe(true);
      expect(supportsRail('br', 'bizum')).toBe(false);
      expect(supportsRail('es', 'bizum')).toBe(true);
      // O erro que este teste existe pra pegar: um Pix cobrado em euro.
      expect(supportsRail('es', 'pix')).toBe(false);
    });

    test('o primeiro trilho é o principal de cada mercado', () => {
      expect(market('br').rails[0]).toBe('pix');
      expect(market('es').rails[0]).toBe('bizum');
    });
  });

  describe('limites por cobrança', () => {
    test('Bizum recusa abaixo de 0,50 € e acima de 5.000 €', () => {
      // Limites do esquema, não nossos: a tela precisa dizer antes do PSP negar.
      expect(checkChargeLimits('es', 49)).toMatchObject({ code: 'amount_under_min' });
      expect(checkChargeLimits('es', 50)).toBeNull();
      expect(checkChargeLimits('es', 500000)).toBeNull();
      expect(checkChargeLimits('es', 500001)).toMatchObject({ code: 'amount_over_max' });
    });

    test('o limite viaja em centavos, pra tela formatar na moeda certa', () => {
      expect(checkChargeLimits('es', 10).vars).toEqual({ minCents: 50 });
      expect(checkChargeLimits('es', 999999).vars).toEqual({ maxCents: 500000 });
    });

    test('o Brasil não tem teto de esquema', () => {
      expect(checkChargeLimits('br', 100000000)).toBeNull();
      expect(checkChargeLimits('br', 1)).toBeNull();
    });

    test('valor não-inteiro é recusado, nunca arredondado', () => {
      for (const bad of [10.5, NaN, Infinity, '100', null]) {
        expect(checkChargeLimits('es', bad)).toMatchObject({ code: 'amount_invalid' });
      }
    });

    test('o erro é um CÓDIGO, nunca uma frase', () => {
      // O servidor não manda texto de tela (CLAUDE.md). Se algum dia alguém
      // puser uma frase aqui, ela chega em português no telefone de um espanhol.
      const r = checkChargeLimits('es', 1);
      expect(typeof r.code).toBe('string');
      expect(r.code).toMatch(/^[a-z_]+$/);
      expect(r.message).toBeUndefined();
    });
  });

  test('as tabelas são congeladas — um mercado não muda em tempo de execução', () => {
    expect(Object.isFrozen(MARKETS)).toBe(true);
    expect(Object.isFrozen(MARKETS.es)).toBe(true);
    expect(Object.isFrozen(MARKETS.es.rails)).toBe(true);
  });
});

/**
 * Os três testes que a revisão de compliance pediu junto das correções.
 *
 * Todos os três são da forma "guarda que nunca dispara" do inegociável #7: o
 * código parecia certo linha a linha, e o que impedia um Pix em real numa mesa
 * de Madrid era um campo por acaso vazio.
 */
describe('portões de dinheiro por mercado', () => {
  const { createChargeService } = require('../_lib/pay/create-charge');
  const { createMemoryStore } = require('../_lib/store/memory');
  const { MockPsp } = require('../_lib/pay/mock-psp');

  // A Espanha falha FECHADA por padrão (ver `chargingAllowed`). Estes testes
  // são sobre os portões DEPOIS da liberação, então ligam explicitamente — e o
  // teste seguinte prova que o padrão é o contrário.
  const prevEs = process.env.RACHA_ES_ENABLED;
  beforeAll(() => { process.env.RACHA_ES_ENABLED = 'true'; });
  afterAll(() => {
    if (prevEs === undefined) delete process.env.RACHA_ES_ENABLED;
    else process.env.RACHA_ES_ENABLED = prevEs;
  });

  async function fixture(market) {
    const store = createMemoryStore();
    const venue = await store.seedVenue({
      name: `casa-${market}`, servicoBp: 1000, pspRecipientId: 'rcpt_demo', market,
    });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 6780 }]);
    const charge = createChargeService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(24) }) });
    return { store, check, charge };
  }

  test('uma mesa espanhola RECUSA um Pix — em vez de cobrar em real', async () => {
    const { check, charge } = await fixture('es');
    await expect(charge({ checkId: check.id, amountCents: 3390, rail: 'pix' }))
      .rejects.toMatchObject({ code: 'rail_unsupported' });
  });

  test('uma mesa brasileira RECUSA um Bizum — em vez de cobrar em euro', async () => {
    const { check, charge } = await fixture('br');
    await expect(charge({ checkId: check.id, amountCents: 3390, rail: 'bizum' }))
      .rejects.toMatchObject({ code: 'rail_unsupported' });
  });

  test('o Bizum passa na Espanha e é gravado como bizum, não como cartão', async () => {
    const { check, charge, store } = await fixture('es');
    const r = await charge({ checkId: check.id, amountCents: 3390, rail: 'bizum' });
    expect(r.method).toBe('bizum');
    // Bizum não tem código copia-e-cola: quem autoriza é o banco do pagador.
    expect(r.copiaECola).toBeNull();
    const pending = await store.listPendingCharges({ checkId: check.id });
    expect(pending.map((p) => p.method)).toEqual(['bizum']);
  });

  test('a carteira de uma mesa espanhola cobra em EURO, não em real', async () => {
    // O achado mais caro desta rodada, e não é código bonito: a revisão de
    // compliance pediu pra parametrizar a moeda do `createWalletCharge`, e a
    // correção deixou `currency = 'brl'` de padrão. Os DOIS chamadores
    // continuaram sem passar nada. Então o literal seguiu valendo, escondido
    // atrás de um comentário que dizia "a moeda vem do mercado".
    //
    // Consequência numa mesa em Madrid pagando com Apple Pay: 24,50 € viram
    // 2450 centavos de REAL na conta conectada espanhola — e a conciliação
    // compara 2450 com 2450 e reporta 0,00 de divergência. O inegociável #8
    // derrotado sem uma linha vermelha em lugar nenhum.
    //
    // Medido contra a Stripe (2026-09-07): cartão em `brl` é ACEITO sem
    // reclamação. No Bizum o esquema recusa ("Payments with bizum support the
    // following currencies: eur"), mas no cartão não existe rede de baixo.
    // Este teste é a rede.
    const seen = [];
    const spy = {
      provider: 'spy',
      // Dublê de um adaptador que captura na chamada (o caso da Pagar.me):
      // sem declarar, a fábrica o recusa — de propósito.
      walletCaptures: true,
      // Um dublê declara o que atende, como um adaptador de verdade: a guarda
      // do `create-charge` falha FECHADO quando `currencies` está ausente, e um
      // dublê que passasse sem declarar seria um dublê mais permissivo que a
      // produção — o jeito exato de um teste passar onde a produção quebra.
      currencies: ['brl', 'eur'],
      async createWalletCharge(args) {
        seen.push(args.currency);
        return { txid: 'pi_spy', clientSecret: 'cs', status: 'requires_payment_method', copiaECola: null };
      },
    };
    for (const [marketCode, expected] of [['es', 'eur'], ['br', 'brl']]) {
      const store = createMemoryStore();
      const venue = await store.seedVenue({
        name: `casa-${marketCode}`, servicoBp: 0, pspRecipientId: 'acct_venue', market: marketCode,
      });
      const table = await store.seedTable(venue.id, 'Mesa 1');
      const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 2450 }]);
      const charge = createChargeService({ store, psp: spy });
      await charge({ checkId: check.id, amountCents: 2450, wallet: 'apple_pay' });
      expect(seen[seen.length - 1]).toBe(expected);
    }
  });

  test('um PSP que não emite na moeda do mercado é recusado com CÓDIGO', async () => {
    // Achado da revisão: `create-charge` chamava o PSP injetado sem perguntar
    // se ele atende o mercado. O `createWalletCharge` do Pagar.me nem tinha
    // `currency` no destructuring, então uma mesa espanhola no trilho de
    // carteira viraria uma ordem em REAL no adquirente brasileiro.
    const brOnly = {
      provider: 'so-brasil',
      currencies: ['brl'],
      async createWalletCharge() { throw new Error('não deveria ser chamado'); },
      async createPixCharge() { throw new Error('não deveria ser chamado'); },
    };
    const store = createMemoryStore();
    const venue = await store.seedVenue({
      name: 'casa-es', servicoBp: 0, pspRecipientId: 'acct_v', market: 'es',
    });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 2450 }]);
    const charge = createChargeService({ store, psp: brOnly });
    await expect(charge({ checkId: check.id, amountCents: 2450, wallet: 'google_pay' }))
      .rejects.toMatchObject({ code: 'psp_market_mismatch' });
  });

  test('adaptador sem `currencies` declarado é RECUSADO, não liberado', async () => {
    // A primeira versão desta guarda era `Array.isArray(psp.currencies) && …`:
    // um adaptador que esquecesse de declarar passava calado. Uma guarda
    // escrita pra fechar um achado do inegociável #7, com a forma do #7
    // dentro. A revisão pegou, e este teste é o que impede a volta.
    const muto = {
      provider: 'nao-declara',
      async createWalletCharge() { throw new Error('não deveria ser chamado'); },
      async createPixCharge() { throw new Error('não deveria ser chamado'); },
    };
    const store = createMemoryStore();
    const venue = await store.seedVenue({
      name: 'casa-br', servicoBp: 0, pspRecipientId: 'rcpt_x', market: 'br',
    });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 1000 }]);
    const charge = createChargeService({ store, psp: muto });
    // Nem no BRASIL, que é o mercado que ele provavelmente atende: a guarda não
    // adivinha, e um adaptador calado é configuração errada.
    await expect(charge({ checkId: check.id, amountCents: 1000, rail: 'pix' }))
      .rejects.toMatchObject({ code: 'psp_market_mismatch' });
  });

  test('um trilho que o PSP não implementa é 400 com código, não 500', async () => {
    // `createBizumCharge` não existe no adaptador do Pagar.me. O caminho
    // chegava a `undefined(...)`, virava TypeError e saía como 500
    // `internal` — um erro que a tela não sabe traduzir, na hora de pagar.
    const noBizum = {
      provider: 'sem-bizum',
      currencies: ['brl', 'eur'],
      async createPixCharge() { throw new Error('não deveria ser chamado'); },
    };
    const store = createMemoryStore();
    const venue = await store.seedVenue({
      name: 'casa-es', servicoBp: 0, pspRecipientId: 'acct_v', market: 'es',
    });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 2450 }]);
    const charge = createChargeService({ store, psp: noBizum });
    const err = await charge({ checkId: check.id, amountCents: 2450, rail: 'bizum' }).catch((e) => e);
    expect(err.code).toBe('rail_unsupported');
    expect(err.statusCode).toBe(400);
  });

  test('o mock recebe de verdade a moeda do mercado', async () => {
    // Um mock que ignora um parâmetro faz o teste passar exatamente onde a
    // produção erra. O `MockPsp` agora guarda a moeda que recebeu.
    const { MockPsp } = require('../_lib/pay/mock-psp');
    for (const [marketCode, expected] of [['es', 'eur'], ['br', 'brl']]) {
      const store = createMemoryStore();
      const venue = await store.seedVenue({
        name: `casa-${marketCode}`, servicoBp: 0, pspRecipientId: 'acct_v', market: marketCode,
      });
      const table = await store.seedTable(venue.id, 'Mesa 1');
      const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 2450 }]);
      const psp = new MockPsp({ webhookSecret: 'x'.repeat(24) });
      const charge = createChargeService({ store, psp });
      await charge({
        checkId: check.id, amountCents: 2450, wallet: 'google_pay', paymentToken: 'tok_abcdefgh',
      });
      expect(psp.lastCurrency).toBe(expected);
    }
  });

  test('nenhum mercado sem linha de serviço aceita gorjeta', async () => {
    // Um bug de tela ou um POST forjado criaria uma "gorjeta" que ninguém pode
    // distribuir legalmente em Espanha.
    const { check, charge } = await fixture('es');
    await expect(charge({ checkId: check.id, amountCents: 3000, tipCents: 300, rail: 'bizum' }))
      .rejects.toMatchObject({ code: 'tip_not_supported' });
    // E o Brasil continua aceitando, que é o ponto do mercado.
    const br = await fixture('br');
    const ok = await br.charge({ checkId: br.check.id, amountCents: 3000, tipCents: 300, rail: 'pix' });
    expect(ok.tipCents).toBe(300);
  });
});

describe('a Espanha falha fechada', () => {
  const { createChargeService } = require('../_lib/pay/create-charge');
  const { createMemoryStore } = require('../_lib/store/memory');
  const { MockPsp } = require('../_lib/pay/mock-psp');
  const { chargingAllowed } = require('../_lib/markets');

  const prev = process.env.RACHA_ES_ENABLED;
  beforeAll(() => { delete process.env.RACHA_ES_ENABLED; });
  afterAll(() => { if (prev !== undefined) process.env.RACHA_ES_ENABLED = prev; });

  test('sem RACHA_ES_ENABLED nenhuma cobrança espanhola sai', async () => {
    // O caminho que este teste fecha: alguém vira o `market` de uma venue no
    // banco pra 'es' — o jeito provável de começar um piloto às pressas — e a
    // cobrança sai antes do parecer sobre disputa (Bizum tem 120 dias de
    // reclamação, e a retenção cai no saldo da PLATAFORMA) e antes da papelada
    // de transferência internacional do GDPR. Falhar fechado é a diferença
    // entre "construído" e "no ar".
    expect(chargingAllowed('es')).toMatchObject({ code: 'market_not_live' });
    // O Brasil não é afetado.
    expect(chargingAllowed('br')).toBeNull();

    const store = createMemoryStore();
    const venue = await store.seedVenue({
      name: 'casa-es-fechada', servicoBp: 1000, pspRecipientId: 'rcpt_demo', market: 'es',
    });
    const table = await store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Item', priceCents: 3390 }]);
    const charge = createChargeService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(24) }) });
    await expect(charge({ checkId: check.id, amountCents: 3390, rail: 'bizum' }))
      .rejects.toMatchObject({ code: 'market_not_live' });
  });
});

/* ── o portão de mercado, e quem é obrigado a passar por ele ───────────────── */

describe('marketGate', () => {
  const { marketGate } = require('../_lib/markets');
  const prev = process.env.RACHA_ES_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.RACHA_ES_ENABLED;
    else process.env.RACHA_ES_ENABLED = prev;
  });

  test('o interruptor do mercado vem PRIMEIRO, antes de qualquer outra regra', () => {
    // Ordem não é estética. Um mercado que não está no ar não deve nem
    // explicar que o trilho está errado: cada resposta específica é uma dica
    // de que o mercado existe e está a um campo de distância de cobrar.
    delete process.env.RACHA_ES_ENABLED;
    expect(marketGate('es', { rail: 'pix', amountCents: 1 }))
      .toMatchObject({ code: 'market_not_live' });
    expect(marketGate('es', { rail: 'bizum', amountCents: 3000, tipCents: 300 }))
      .toMatchObject({ code: 'market_not_live' });
    expect(marketGate('es', { rail: 'bizum', amountCents: 900000 }))
      .toMatchObject({ code: 'market_not_live' });
  });

  test('com o mercado no ar, as três regras seguintes valem uma a uma', () => {
    process.env.RACHA_ES_ENABLED = 'true';
    expect(marketGate('es', { rail: 'bizum', amountCents: 3390 })).toBeNull();
    expect(marketGate('es', { rail: 'pix', amountCents: 3390 }))
      .toMatchObject({ code: 'rail_unsupported' });
    expect(marketGate('es', { rail: 'bizum', amountCents: 3000, tipCents: 300 }))
      .toMatchObject({ code: 'tip_not_supported' });
    expect(marketGate('es', { rail: 'bizum', amountCents: 500001 }))
      .toMatchObject({ code: 'amount_over_max', vars: { maxCents: 500000 } });
    expect(marketGate('es', { rail: 'bizum', amountCents: 49 }))
      .toMatchObject({ code: 'amount_under_min', vars: { minCents: 50 } });
  });

  test('o Brasil passa com serviço e sem teto', () => {
    // `venue` com documento: desde 2026-09-13 a gorjeta exige CNPJ provado —
    // ver o bloco "gorjeta exige documento de empresa provado" mais abaixo.
    const casa = { market: 'br', cnpj: '11444777000161' };
    expect(marketGate('br', { rail: 'pix', amountCents: 3000, tipCents: 300, venue: casa })).toBeNull();
    expect(marketGate('br', { rail: 'card', amountCents: 100000000 })).toBeNull();
    expect(marketGate('br', { rail: 'bizum', amountCents: 3000 }))
      .toMatchObject({ code: 'rail_unsupported' });
  });

  test('o teto olha a SOMA, mas em Espanha a gorjeta é recusada antes dele', () => {
    // Escrevi este teste esperando `amount_over_max` em 4.999,50 € + 1,00 € de
    // gorjeta, e ele falhou com `tip_not_supported`. O teste estava errado, não
    // o portão: em Espanha não existe linha de serviço, então qualquer gorjeta
    // morre uma regra ANTES do teto. Deixo a descoberta escrita porque a ordem
    // dos portões é uma decisão, não um acidente.
    process.env.RACHA_ES_ENABLED = 'true';
    expect(marketGate('es', { rail: 'bizum', amountCents: 499950, tipCents: 100 }))
      .toMatchObject({ code: 'tip_not_supported' });

    // O teto em si continua olhando a soma, e a borda é exata.
    expect(marketGate('es', { rail: 'bizum', amountCents: 500000, tipCents: 0 })).toBeNull();
    expect(marketGate('es', { rail: 'bizum', amountCents: 500001, tipCents: 0 }))
      .toMatchObject({ code: 'amount_over_max' });
    // E a soma é o que chega ao limite — provado direto, porque hoje nenhum
    // mercado tem teto E linha de serviço ao mesmo tempo. No dia em que
    // tiver, é esta linha que diz o que se espera.
    expect(checkChargeLimits('es', 499900 + 100)).toBeNull();          // 5.000,00 € justo
    expect(checkChargeLimits('es', 499950 + 100)).toMatchObject({ code: 'amount_over_max' });
  });
});

test('todo lugar que cria cobrança está no censo — e o censo passa pelo portão', () => {
  // O teste que a revisão de compliance ganhou, e depois consertou.
  //
  // A primeira versão perguntava, por ARQUIVO: "este arquivo chama
  // `marketGate`?". Ela achou o `house-service`, que era o ponto. Mas ela
  // também deixava o `router.js` imunizado pra sempre: o arquivo tem duas
  // criações de cobrança e uma chamada de portão, então passa — e continuaria
  // passando se uma TERCEIRA rota nascesse ali sem portão. Que é exatamente o
  // caminho mais provável do próximo esquecimento, no arquivo mais provável.
  //
  // Então virou um CENSO: cada `arquivo:linha` que cria cobrança está listado
  // aqui, e um lugar novo quebra o teste até alguém escrever por que ele é
  // seguro. Contar não serve — a rota do Stripe tem duas criações atrás de um
  // portão só, legitimamente.
  //
  // A busca também mudou de forma: pega `psp[creator](...)` além de
  // `.createPixCharge(...)`, porque o despacho dinâmico é justamente a forma
  // que o `create-charge` usa, e a versão anterior era cega pra ela. E anda a
  // partir da RAIZ do repositório, não de `api/`, porque um script que cobra
  // continua cobrando.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');

  const CENSO = [
    // Onde: por que é seguro.
    'api/_app/router.js: /api/pay/stripe-intent — marketGate imediatamente antes',
    'api/_lib/house/house-service.js: createLoad — marketGate antes, fecha fora do Brasil',
    'api/_lib/pay/create-charge.js: o portão de dinheiro compartilhado, é ele quem chama marketGate',
  ];

  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '__tests__', 'test', 'ios'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) files.push(full);
    }
  }(root));

  // `.createPixCharge(` e também `psp[creator](` — o despacho dinâmico.
  const DIRETO = /\.(createPixCharge|createWalletCharge|createBizumCharge)\s*\(/;
  const DINAMICO = /\bpsp\s*\[\s*\w+\s*\]\s*\(/;
  // Os adaptadores DEFINEM esses métodos; quem os CHAMA precisa do portão.
  const ADAPTADORES = /_lib\/pay\/(mock|pagarme|stripe)-psp\.js$/;

  const encontrados = new Set();
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (ADAPTADORES.test(rel)) continue;
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((line) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      if (DIRETO.test(line) || DINAMICO.test(line)) encontrados.add(rel);
    });
  }

  const censados = new Set(CENSO.map((e) => e.split(':')[0].trim()));
  const novos = [...encontrados].filter((f) => !censados.has(f)).sort();
  expect(novos).toEqual([]);

  // E todo arquivo do censo tem que MESMO passar pelo portão. Um censo que só
  // lista nomes é uma lista de nomes.
  const semPortao = [...censados].filter((rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    return !/marketGate\s*\(/.test(src);
  }).sort();
  expect(semPortao).toEqual([]);
});

/**
 * O SERVIÇO SÓ CORRE ONDE HÁ PESSOA JURÍDICA PRA DISTRIBUIR.
 *
 * O portão do `/api/psp/recipient` confere o documento de quem recebe e faz a
 * casa herdá-lo — mas isso fecha o caminho de ESCRITA e não alcança quem já
 * existe. O `docs/onboarding/README.md` diz que hoje o recebedor é criado À MÃO
 * no painel do Pagar.me (o formulário in-app é item 2 do roteiro, não
 * construído): a população atual tem recebedor posto fora do portão e `cnpj`
 * nulo, que é legítimo.
 *
 * E nada no caminho do dinheiro olhava documento: o `create-charge` exigia
 * recebedor e mais nada, e o `pix.includesTip` aparece só com `tipCents > 0`.
 * Sem este portão, os 10% liquidariam no CPF de uma pessoa física — sem folha,
 * logo sem INSS/IRRF/FGTS — enquanto o cliente lê "o restaurante distribui à
 * equipe, como manda a lei". Oferta vinculante do CDC art. 30, falsa por
 * construção. Achado pela revisão de compliance de 2026-09-13.
 */
describe('gorjeta exige documento de empresa provado', () => {
  const { createChargeService } = require('../_lib/pay/create-charge');
  const { createMemoryStore } = require('../_lib/store/memory');
  const { MockPsp } = require('../_lib/pay/mock-psp');
  const { marketGate: gate } = require('../_lib/markets');

  async function cobrar({ cnpj, tipCents }) {
    const store = createMemoryStore();
    const venue = store.seedVenue({ name: 'Boteco', servicoBp: 1000, cnpj });
    const table = store.seedTable(venue.id, 'Mesa 1');
    const check = await store.openCheck(table.qrToken, [
      { id: 'i1', name: 'Picanha', priceCents: 10000 },
    ]);
    const charge = createChargeService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(24) }) });
    return charge({ checkId: check.id, amountCents: 5000, tipCents, rail: 'pix' });
  }

  test('sem documento da casa, a gorjeta é recusada com código próprio', async () => {
    await expect(cobrar({ cnpj: null, tipCents: 500 }))
      .rejects.toMatchObject({ code: 'venue_no_tip_document' });
  });

  test('um CPF na coluna NÃO é documento de empresa', async () => {
    // `documentoPublicavelDaCasa` confere o VALOR, não só o mercado: linhas
    // antigas foram escritas antes do portão de escrita existir.
    await expect(cobrar({ cnpj: '52998224725', tipCents: 500 }))
      .rejects.toMatchObject({ code: 'venue_no_tip_document' });
  });

  test('CNPJ que não passa no dígito verificador também não serve', async () => {
    await expect(cobrar({ cnpj: '99999999999999', tipCents: 500 }))
      .rejects.toMatchObject({ code: 'venue_no_tip_document' });
  });

  test('a regra vale no marketGate, que é por onde TODO trilho passa', () => {
    // Ela nasceu dentro do `create-charge` — que não é o funil, é UM dos
    // funis. O `POST /api/pay/stripe-intent` monta a cobrança sozinho, então
    // a gorjeta era recusada no Pix e aceita no cartão, na mesma casa. É o
    // incidente de 2026-09-07 que esta função já documenta, com a quinta
    // regra repetindo o erro das quatro primeiras.
    const semDoc = { market: 'br', cnpj: null };
    const comDoc = { market: 'br', cnpj: '11444777000161' };
    const comCPF = { market: 'br', cnpj: '52998224725' };
    for (const rail of ['pix', 'card']) {
      expect(gate('br', { rail, amountCents: 5000, tipCents: 500, venue: semDoc }))
        .toMatchObject({ code: 'venue_no_tip_document' });
      expect(gate('br', { rail, amountCents: 5000, tipCents: 500, venue: comCPF }))
        .toMatchObject({ code: 'venue_no_tip_document' });
      expect(gate('br', { rail, amountCents: 5000, tipCents: 500, venue: comDoc })).toBeNull();
      // Consumo passa sempre.
      expect(gate('br', { rail, amountCents: 5000, tipCents: 0, venue: semDoc })).toBeNull();
    }
  });

  test('sem venue, o portão RECUSA — não libera', () => {
    // `if (tipCents > 0 && venue && !doc)`: um chamador que esquecesse a venue
    // pulava a regra em silêncio. A forma que o inegociável #7 nomeia, dentro
    // da função escrita pra fechar o #7.
    expect(gate('br', { rail: 'pix', amountCents: 5000, tipCents: 500 }))
      .toMatchObject({ code: 'venue_no_tip_document' });
    expect(gate('br', { rail: 'card', amountCents: 5000, tipCents: 500, venue: null }))
      .toMatchObject({ code: 'venue_no_tip_document' });
    // Sem gorjeta, segue passando sem venue: o consumo não depende disto.
    expect(gate('br', { rail: 'pix', amountCents: 5000, tipCents: 0 })).toBeNull();
  });

  test('nenhum chamador de marketGate no repositório omite a venue', () => {
    // A versão anterior deste censo NÃO PODIA FALHAR: casava a lista de
    // argumentos inteira, e o primeiro posicional é sempre `venue.market` —
    // então `/venue/` casava com ou sem a venue no objeto de opções. Rodado
    // contra a árvore ANTES do conserto, dava a mesma resposta: vazio. E a
    // lista de arquivos era escrita à mão, sem o `house-service.js`, que
    // chama `marketGate` e não passa venue. Agora o censo acha os chamadores
    // e olha o OBJETO DE OPÇÕES. Achado pelas duas revisões de 2026-09-13.
    const fs = require('node:fs');
    const path = require('node:path');
    const RAIZ = path.join(__dirname, '..', '..');
    function anda(dir, out = []) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/^(node_modules|__tests__)$/.test(e.name)) anda(p, out); }
        else if (/\.js$/.test(e.name)) out.push(p);
      }
      return out;
    }
    const chamadores = anda(path.join(RAIZ, 'api'))
      .filter((f) => /marketGate\s*\(/.test(fs.readFileSync(f, 'utf8')));
    // Se o censo parar de achar chamador, ele passa calado.
    expect(chamadores.length).toBeGreaterThanOrEqual(2);
    const semVenue = [];
    const formaDesconhecida = [];
    for (const f of chamadores) {
      const texto = fs.readFileSync(f, 'utf8');
      // A DECLARAÇÃO da função não é chamada — `function marketGate(code, {…})`
      // casava o próprio padrão e se acusava.
      //
      // E TODA chamada tem que casar a forma que este censo sabe ler. Sem
      // isto, `marketGate(m, opts)` ou `marketGate(m)` simplesmente não
      // casavam e o censo seguia verde: forma desconhecida não é forma
      // conforme. Achado pela revisão de segurança de 2026-09-13.
      const chamadas = [...texto.matchAll(/(?<!function\s)marketGate\s*\(/g)];
      const lidas = [...texto.matchAll(/(?<!function\s)marketGate\s*\([^,]*,\s*\{([^}]*)\}/g)];
      if (chamadas.length !== lidas.length) {
        formaDesconhecida.push(`${path.relative(RAIZ, f)}: ${chamadas.length} chamadas, ${lidas.length} legíveis`);
      }
      for (const m of lidas) {
        // `tipCents: 0` literal dispensa: não há gorjeta pra conferir.
        if (/tipCents:\s*0\b/.test(m[1])) continue;
        if (!/(^|[,{]\s*)venue\s*($|[,:=])/.test(m[1].trim())) {
          semVenue.push(`${path.relative(RAIZ, f)}: ${m[0].slice(0, 70)}`);
        }
      }
    }
    expect(semVenue).toEqual([]);
    expect(formaDesconhecida).toEqual([]);
  });

  test('o CONSUMO passa sem documento — ninguém deixa de pagar o que comeu', async () => {
    const r = await cobrar({ cnpj: null, tipCents: 0 });
    expect(r.txid).toBeTruthy();
  });

  test('com CNPJ válido, a gorjeta corre', async () => {
    const r = await cobrar({ cnpj: '11444777000161', tipCents: 500 });
    expect(r.txid).toBeTruthy();
  });

  test('o código tem tradução nas três línguas', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dict = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
    expect(dict).toContain("'err.venue_no_tip_document'");
  });
});
