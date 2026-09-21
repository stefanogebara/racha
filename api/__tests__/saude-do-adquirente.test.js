'use strict';

/**
 * UMA CHAVE REVOGADA TEM QUE ACORDAR ALGUÉM.
 *
 * O cenário que este arquivo prende, e que a nona e a décima revisão mediram:
 * a `sk_live_` é rotacionada, a Pagar.me passa a responder 401, todo 4xx do
 * gateway vira 402 `psp_rejected` pra quem está na mesa — e o sistema inteiro
 * acha que está bem. A conciliação compara dois registros que concordam que
 * nada aconteceu; o aviso diário diz "restaurantes ok".
 */

const {
  escopoDaFalha, criarVigiaDoAdquirente, SEGUIDAS_POR_CASA,
} = require('../_lib/pay/saude-do-adquirente');

const falha = (httpStatus) => Object.assign(new Error('pagarme POST /orders'), { httpStatus });

describe('o escopo de uma falha do adquirente', () => {
  test.each([[401], [403]])('%i é NOSSA credencial — atinge todas as casas', (h) => {
    expect(escopoDaFalha(falha(h))).toBe('plataforma');
  });

  test.each([[400], [404], [422]])('%i é de UMA casa', (h) => {
    expect(escopoDaFalha(falha(h))).toBe('casa');
  });

  test.each([
    [0, 'rede/timeout — a marca do adaptador'],
    [429, 'limite de taxa'],
    [500, 'gateway'],
    [503, 'gateway'],
  ])('%i (%s) é transitório e NÃO acorda ninguém', (h) => {
    expect(escopoDaFalha(falha(h))).toBe('transitorio');
  });

  test('um erro que não é do adquirente não entra na conta', () => {
    expect(escopoDaFalha(new Error('qualquer'))).toBe('nao-e-adquirente');
    expect(escopoDaFalha(null)).toBe('nao-e-adquirente');
    // `statusCode` é o NOSSO campo de resposta HTTP; o do adquirente é
    // `httpStatus`. Confundir os dois faria um 402 nosso virar falha do
    // gateway.
    expect(escopoDaFalha({ statusCode: 401 })).toBe('nao-e-adquirente');
  });
});

describe('a credencial revogada avisa na PRIMEIRA', () => {
  test('esperar N seria esperar enquanto 100% falha', () => {
    const v = criarVigiaDoAdquirente();
    const aviso = v.registrarFalha(falha(401), 'casa-a');
    expect(aviso).not.toBeNull();
    expect(aviso.kind).toBe('account_alert');
    expect(aviso.escopo).toBe('plataforma');
    // Sem casa: o problema não é de nenhuma em particular, é de todas.
    expect(aviso.venueId).toBeNull();
    expect(aviso.detail).toMatch(/credencial/i);
  });

  test('e não repete dentro da janela — um apagão não vira mil avisos', () => {
    const v = criarVigiaDoAdquirente({ janelaMs: 60_000 });
    expect(v.registrarFalha(falha(401), 'casa-a')).not.toBeNull();
    for (let i = 0; i < 50; i += 1) {
      expect(v.registrarFalha(falha(401), `casa-${i}`)).toBeNull();
    }
  });

  test('passada a janela, avisa de novo — o apagão continua sendo notícia', () => {
    let t = 0;
    const v = criarVigiaDoAdquirente({ agora: () => t, janelaMs: 60_000 });
    expect(v.registrarFalha(falha(403), 'casa-a')).not.toBeNull();
    t = 59_999;
    expect(v.registrarFalha(falha(403), 'casa-a')).toBeNull();
    t = 60_000;
    expect(v.registrarFalha(falha(403), 'casa-a')).not.toBeNull();
  });
});

describe('a casa quebrada avisa no N', () => {
  test(`uma conta não é notícia; ${SEGUIDAS_POR_CASA} contas são`, () => {
    const v = criarVigiaDoAdquirente();
    for (let i = 1; i < SEGUIDAS_POR_CASA; i += 1) {
      expect(v.registrarFalha(falha(422), 'casa-a', `conta-${i}`)).toBeNull();
    }
    const aviso = v.registrarFalha(falha(422), 'casa-a', `conta-${SEGUIDAS_POR_CASA}`);
    expect(aviso).not.toBeNull();
    expect(aviso.escopo).toBe('casa');
    expect(aviso.venueId).toBe('casa-a');
  });

  test('SEGUIDAS quer dizer seguidas — um sucesso zera', () => {
    const v = criarVigiaDoAdquirente();
    v.registrarFalha(falha(422), 'casa-a', 'conta-1');
    v.registrarFalha(falha(422), 'casa-a', 'conta-2');
    v.registrarSucesso('casa-a');
    // Sem o zerar, esta terceira dispararia — e a casa está pagando.
    expect(v.registrarFalha(falha(422), 'casa-a', 'conta-3')).toBeNull();
  });

  /**
   * A MESMA CONTA, MUITAS VEZES, NÃO É NOTÍCIA — é o ataque de um QR só.
   * Quem está numa mesa tem UMA conta e não consegue fabricar três; uma casa
   * quebrada de verdade falha em todas as mesas.
   */
  test('a mesma conta repetida nunca chega a avisar', () => {
    const v = criarVigiaDoAdquirente();
    for (let i = 0; i < 50; i += 1) {
      expect(v.registrarFalha(falha(422), 'casa-a', 'a-mesma-conta')).toBeNull();
    }
  });

  test('e sem conta identificada não conta — não dá pra atribuir', () => {
    const v = criarVigiaDoAdquirente();
    for (let i = 0; i < 50; i += 1) {
      expect(v.registrarFalha(falha(422), 'casa-a', null)).toBeNull();
    }
  });

  test('as casas contam separado — a de uma não acusa a outra', () => {
    const v = criarVigiaDoAdquirente();
    for (let i = 0; i < SEGUIDAS_POR_CASA; i += 1) {
      expect(v.registrarFalha(falha(422), `casa-${i}`, `conta-${i}`)).toBeNull();
    }
  });

  test('e o sucesso de uma casa não zera a outra', () => {
    const v = criarVigiaDoAdquirente();
    v.registrarFalha(falha(422), 'casa-a', 'conta-1');
    v.registrarFalha(falha(422), 'casa-a', 'conta-2');
    v.registrarSucesso('casa-b');
    expect(v.registrarFalha(falha(422), 'casa-a', 'conta-3')).not.toBeNull();
  });
});

describe('o que NÃO acorda ninguém', () => {
  test.each([[0], [429], [500], [503]])('%i, por mais que se repita', (h) => {
    const v = criarVigiaDoAdquirente();
    for (let i = 0; i < 100; i += 1) {
      expect(v.registrarFalha(falha(h), 'casa-a', `conta-${i}`)).toBeNull();
    }
  });

  test('e um erro nosso tampouco', () => {
    const v = criarVigiaDoAdquirente();
    const nosso = Object.assign(new Error('carteira desconhecida'), { statusCode: 400, code: 'rail_unsupported' });
    for (let i = 0; i < 10; i += 1) {
      expect(v.registrarFalha(nosso, 'casa-a', `conta-${i}`)).toBeNull();
    }
  });
});

describe('a janela vem da env, e vazia é AUSENTE', () => {
  const com = (valor, f) => {
    const antes = process.env.RACHA_JANELA_AVISO_ADQUIRENTE_MS;
    if (valor === undefined) delete process.env.RACHA_JANELA_AVISO_ADQUIRENTE_MS;
    else process.env.RACHA_JANELA_AVISO_ADQUIRENTE_MS = valor;
    try { return f(); } finally {
      if (antes === undefined) delete process.env.RACHA_JANELA_AVISO_ADQUIRENTE_MS;
      else process.env.RACHA_JANELA_AVISO_ADQUIRENTE_MS = antes;
    }
  };
  /** Dois 401 seguidos: com debounce sai UM aviso, sem debounce saem DOIS. */
  const avisosEmDois = () => {
    const v = criarVigiaDoAdquirente();
    return [v.registrarFalha(falha(401)), v.registrarFalha(falha(401))].filter(Boolean).length;
  };

  /**
   * `Number('')` é 0, e `0 >= 0` é verdadeiro — então uma variável que EXISTE
   * e está em branco (limpar o campo no painel em vez de apagar a variável)
   * desligava o debounce. Numa credencial revogada isso é uma página por
   * cobrança falhada: o sinal soterrado, pelo caminho oposto ao silêncio.
   */
  test.each([[''], ['   '], ['\n'], ['abc'], [undefined]])(
    'com a env %p, o debounce CONTINUA valendo', (valor) => {
      expect(com(valor, avisosEmDois)).toBe(1);
    },
  );

  /**
   * O TETO DA JANELA tem que ser medido, senão o conserto de "o pager pode
   * virar no-op por configuração" pode ele mesmo ser apagado sem nada ficar
   * vermelho. `TETO_DA_JANELA_MS` e `janelaConfigurada` foram exportados pra
   * teste e depois não testados (segurança, 2026-09-21, MEDIUM-3).
   */
  test('dez dias viram uma hora — a alavanca não desliga o pager', () => {
    const { janelaConfigurada, TETO_DA_JANELA_MS } = require('../_lib/pay/saude-do-adquirente');
    expect(TETO_DA_JANELA_MS).toBe(3_600_000);
    expect(com('864000000', janelaConfigurada)).toBe(3_600_000);
    expect(com('3600001', janelaConfigurada)).toBe(3_600_000);
    // E abaixo do teto o valor passa inteiro.
    expect(com('120000', janelaConfigurada)).toBe(120_000);
  });

  test('e um número de verdade é respeitado — senão o teste acima é vácuo', () => {
    expect(com('0', avisosEmDois)).toBe(2);       // zero explícito: sem debounce
    expect(com('900000', avisosEmDois)).toBe(1);  // quinze minutos
  });
});

describe('o kind é um que a ponte ACEITA hoje', () => {
  /**
   * Não inventar kind novo foi decisão, não preguiça: a ponte deploya de outro
   * repositório, e o `money_without_check` — acrescentado em 2026-09-16 — ainda
   * é recusado lá. Um kind novo aqui seria um alerta que volta 400, ou seja, o
   * silêncio que este arquivo existe pra remover.
   */
  test('`account_alert` está na lista da ponte', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const contrato = fs.readFileSync(
      path.join(__dirname, 'notify-bridge-contract.test.js'), 'utf8',
    );
    const i = contrato.indexOf('A_PONTE_ACEITA');
    expect(i).toBeGreaterThan(0);
    expect(contrato.slice(i, contrato.indexOf('])', i))).toContain("'account_alert'");
  });

  test('e o `notify` também o aceita', () => {
    const { KINDS_DE_FUNDADOR } = require('../_lib/notify');
    expect(KINDS_DE_FUNDADOR.has('account_alert')).toBe(true);
  });
});
