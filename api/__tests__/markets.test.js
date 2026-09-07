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
