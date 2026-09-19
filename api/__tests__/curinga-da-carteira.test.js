'use strict';

/**
 * O CURINGA `*` NÃO VALE CONTRA A PAGAR.ME DE VERDADE.
 *
 * `RACHA_WALLET_VENUES='*'` existe pra staging, onde o PSP é o mock e nada
 * cobra ninguém. Em produção ele liberaria a captura de cartão em TODAS as
 * casas de uma vez — o oposto exato do que a lista existe pra fazer.
 *
 * Este arquivo existe porque a proteção ficou SEM TESTE quando os três censos
 * de texto do portão foram apagados. Uma revisão mediu: trocando a linha por
 * `return true`, a suíte inteira passa — 2.443 casos, zero falhas. E o caminho
 * pra alguém chegar nessa env às duas da manhã está escrito na própria
 * mensagem de erro do `psp-acceptance`, que manda mexer em
 * `RACHA_WALLET_VENUES`. Achado pela oitava revisão de segurança (2026-09-19,
 * MEDIUM-2).
 *
 * Tem que ser em arquivo próprio e com `isolateModules`: `carteiraLiberada` lê
 * `RACHA_WALLET_VENUES` a cada chamada, mas amarra `RACHA_PSP` no LOAD do
 * módulo. Um teste que só mexesse na env depois do `require` mediria o valor
 * velho e passaria sem provar nada.
 */

function comEnv(vars, f) {
  const antes = {};
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    let saida;
    jest.isolateModules(() => { saida = f(); });
    return saida;
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const liberada = (env, id) => comEnv(env, () => {
  // eslint-disable-next-line global-require
  const { carteiraLiberada } = require('../_app/router');
  return carteiraLiberada(id);
});

describe('`*` é escape de staging, e só', () => {
  test('com a Pagar.me de verdade, o curinga NÃO libera ninguém', () => {
    expect(liberada(
      { RACHA_PSP: 'pagarme', RACHA_WALLET_VENUES: '*' },
      '11111111-1111-1111-1111-111111111111',
    )).toBe(false);
  });

  test('com o mock, o curinga libera — senão o teste acima é vácuo', () => {
    expect(liberada(
      { RACHA_PSP: 'mock', RACHA_WALLET_VENUES: '*' },
      '11111111-1111-1111-1111-111111111111',
    )).toBe(true);
  });

  /**
   * A lista por ID continua valendo nos dois: o curinga é o que muda, não o
   * interruptor inteiro. Sem isto, `return false` puro passaria no primeiro
   * teste e quebraria a carteira pra quem foi liberado de propósito.
   */
  test('a lista por id segue valendo com a Pagar.me de verdade', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    expect(liberada({ RACHA_PSP: 'pagarme', RACHA_WALLET_VENUES: id }, id)).toBe(true);
    expect(liberada({ RACHA_PSP: 'pagarme', RACHA_WALLET_VENUES: id }, 'outra')).toBe(false);
  });

  test('`*` com espaço em volta é o mesmo curinga, não um id chamado "*"', () => {
    expect(liberada({ RACHA_PSP: 'pagarme', RACHA_WALLET_VENUES: '  *  ' }, 'qualquer')).toBe(false);
    expect(liberada({ RACHA_PSP: 'mock', RACHA_WALLET_VENUES: '  *  ' }, 'qualquer')).toBe(true);
  });

  /**
   * `'*,x'` NÃO é o curinga — cai no ramo da lista, e ninguém se chama `*`.
   * Vale prender porque é a forma que alguém escreveria tentando "liberar todo
   * mundo e mais essa casa".
   */
  test('`*,alguma-casa` não vira curinga', () => {
    expect(liberada({ RACHA_PSP: 'mock', RACHA_WALLET_VENUES: '*,casa-a' }, 'casa-b')).toBe(false);
    expect(liberada({ RACHA_PSP: 'mock', RACHA_WALLET_VENUES: '*,casa-a' }, 'casa-a')).toBe(true);
  });
});
