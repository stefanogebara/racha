'use strict';

const {
  MARKETS, DEFAULT_MARKET, marketCodes, isMarket, market,
  publicMarketView, checkChargeLimits, supportsRail,
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
      const br = publicMarketView('br', { servicoBp: 1000 });
      expect(br.serviceCharge.bp).toBe(1000);
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
