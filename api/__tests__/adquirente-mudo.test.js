'use strict';

/**
 * O QUE A TELA LÊ QUANDO O ADQUIRENTE NÃO RESPONDE.
 *
 * O `api()` da Pagar.me dá 15 s e, no estouro, lançava 502 SEM `code`. O
 * `errorBody` transforma isso em `internal`, e o `tError` do cliente cai em
 * `err.generic` → "algo deu errado, tente de novo".
 *
 * Na CARTEIRA isso é falso e é caro: a v5 captura dentro da chamada, então um
 * timeout não quer dizer "não capturou", quer dizer "não sei" — e a captura
 * pode ter completado com a resposta perdida. O segundo toque monta o MESMO
 * `chargeRef` (o `paidCents` não se moveu, webhook nenhum chegou), a Pagar.me
 * não deduplica por ele, e vira uma SEGUNDA CAPTURA no mesmo cartão
 * (CDC art. 42 § único).
 *
 * É a mesma ambiguidade que o `gravarAposCobrar` resolve — capturou e a
 * ESCRITA falhou — e ela vinha sendo respondida ao contrário doze linhas antes.
 * Achado pela nona revisão de segurança (2026-09-19, HIGH-1).
 *
 * Este arquivo mede o par (status, code) que sai de CADA forma de falha, nos
 * dois trilhos, DEPOIS do `errorBody` — que é onde um código já se perdeu antes
 * nesta mesma sequência de revisões.
 */

const { createPagarmePsp } = require('../_lib/pay/pagarme-psp');
const { errorStatus, errorBody } = require('../_lib/http-error');

const CHAVE = `sk_test_${'x'.repeat(20)}`;

const adaptador = (fetchImpl) => createPagarmePsp({
  secretKey: CHAVE, webhookBasicAuth: 'racha:senha', fetchImpl,
});

const timeout = async () => {
  const e = new Error('timed out');
  e.name = 'TimeoutError';
  throw e;
};
const rede = async () => { throw new TypeError('fetch failed'); };
const status = (n, corpo = '{"message":"erro do gateway"}') => async () => ({
  ok: false, status: n, text: async () => corpo,
});

const BASE = {
  chargeRef: 'conta:0:1000:0', amountCents: 1000, tipCents: 0,
  recipientId: 're_x', currency: 'brl', payerDocument: '52998224725',
};
const CARTEIRA = {
  ...BASE, wallet: 'google_pay', paymentToken: `tok_${'a'.repeat(12)}`, venueName: 'Bar',
};

async function respostaDe(fetchImpl, trilho) {
  const psp = adaptador(fetchImpl);
  try {
    if (trilho === 'carteira') await psp.createWalletCharge(CARTEIRA);
    else await psp.createPixCharge(BASE);
    return { status: 200, corpo: null };
  } catch (e) {
    const st = errorStatus(e);
    return { status: st, corpo: errorBody(e, st) };
  }
}

describe('a CARTEIRA captura dentro da chamada — "não sei" nunca vira "tente de novo"', () => {
  test.each([
    ['timeout de 15 s', timeout],
    ['a rede caiu', rede],
    ['500 do gateway', status(500)],
    ['502 do gateway', status(502)],
    ['504 do gateway', status(504)],
  ])('%s → o botão desarma', async (_nome, f) => {
    const r = await respostaDe(f, 'carteira');
    expect(r.corpo.code).toBe('charge_maybe_captured');
    // `internal` viraria "algo deu errado, tente de novo" com o botão armado.
    expect(r.corpo.code).not.toBe('internal');
    // E a mensagem interna — que nomeia o adquirente e o nosso caminho — fica.
    expect(String(r.corpo.error || '')).not.toMatch(/pagarme|orders|timeout/i);
  });

  test('4xx é outra coisa: o pedido nem foi aceito, nada capturou', async () => {
    const r = await respostaDe(status(422, '{"message":"recipient inactive"}'), 'carteira');
    expect(r.status).toBe(402);
    expect(r.corpo.code).toBe('psp_rejected');
    // `undefined` é o resultado mais forte: num 4xx COM código o `errorBody`
    // nem manda `error`. A asserção aceita os dois e recusa vazamento.
    expect(String(r.corpo.error || '')).not.toMatch(/recipient|pagarme|orders/i);
  });
});

describe('o PIX não captura nada — aqui "nada mudou" é verdade', () => {
  test.each([
    ['timeout de 15 s', timeout],
    ['a rede caiu', rede],
    ['500 do gateway', status(500)],
  ])('%s → `psp_unavailable`, não `internal`', async (_nome, f) => {
    const r = await respostaDe(f, 'pix');
    expect(r.corpo.code).toBe('psp_unavailable');
    expect(r.corpo.code).not.toBe('charge_maybe_captured');
  });

  test('4xx vira `psp_rejected`, sem a frase do gateway', async () => {
    const r = await respostaDe(status(401, '{"message":"invalid api key"}'), 'pix');
    expect(r.status).toBe(402);
    expect(r.corpo.code).toBe('psp_rejected');
    expect(String(r.corpo.error || '')).not.toMatch(/api key|pagarme|orders/i);
  });
});

/**
 * AS FALHAS QUE NUNCA SAEM DESTE PROCESSO não podem falar de captura.
 *
 * `baseOrder()` era avaliado DENTRO do `try` que rotula tudo como
 * `charge_maybe_captured`, então a recusa de custódia (recebedor ausente), o
 * `assertCents` e o `zero-value` diziam à pessoa na mesa que o cartão dela
 * podia ter sido cobrado — e travavam o botão — para um pedido que não abriu
 * socket nenhum. Do outro lado, o `psp-acceptance` mandava o operador caçar
 * dinheiro que não existe. Décima revisão (2026-09-20, compliance HIGH-1 /
 * segurança MEDIUM-1); nenhum caso do arquivo chegava a fazer `baseOrder`
 * lançar, porque todos passavam `recipientId: 're_x'`.
 */
describe('recusa local não é captura', () => {
  const nuncaChamado = async () => { throw new Error('fetch não devia ser chamado'); };

  test.each([
    ['sem recebedor (recusa de custódia)', { recipientId: null }],
    ['valor fracionado', { amountCents: 1.5 }],
    ['valor zero', { amountCents: 0, tipCents: 0 }],
  ])('%s → NÃO diz que o cartão pode ter sido cobrado', async (_nome, troca) => {
    const psp = adaptador(nuncaChamado);
    const erro = await psp.createWalletCharge({ ...CARTEIRA, ...troca }).catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(erro.code).not.toBe('charge_maybe_captured');
  });

  test('e a recusa de custódia continua recusando — o inegociável #4 não afrouxou', async () => {
    const psp = adaptador(nuncaChamado);
    const erro = await psp.createWalletCharge({ ...CARTEIRA, recipientId: null }).catch((e) => e);
    expect(String(erro.message)).toMatch(/custódia/i);
  });
});

/**
 * O ABORT NO MEIO DA LEITURA DO CORPO. O `AbortSignal.timeout` fica armado
 * enquanto o corpo transmite, e `res.text()` estava fora do try: rejeitava com
 * DOMException crua, sem status e sem código → `internal` → "tente de novo".
 * O stub anterior só conseguia rejeitar do próprio `fetchImpl`, então esta
 * metade do timeout não era medida por nada (décima revisão de segurança,
 * MEDIUM-2).
 */
describe('o corpo pode abortar DEPOIS do cabeçalho', () => {
  const corpoQueAborta = async () => ({
    ok: false,
    status: 502,
    text: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
  });

  test('no Pix vira `psp_unavailable`, não `internal`', async () => {
    const r = await respostaDe(corpoQueAborta, 'pix');
    expect(r.corpo.code).toBe('psp_unavailable');
  });

  test('na carteira vira `charge_maybe_captured` — havia captura em voo', async () => {
    const r = await respostaDe(corpoQueAborta, 'carteira');
    expect(r.corpo.code).toBe('charge_maybe_captured');
  });
});

describe('todos os códigos que saem daqui têm tradução nos três idiomas', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const DICT = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');

  test.each([['charge_maybe_captured'], ['psp_unavailable'], ['psp_rejected'], ['card_declined'], ['card_token_invalid']])(
    '`%s`', (codigo) => {
      const i = DICT.indexOf(`'err.${codigo}'`);
      expect(i).toBeGreaterThan(0);
      // Até o `},` da PRÓPRIA chave. Com uma janela fixa de 400 caracteres as
      // entradas `err.*` (≈200 de distância) se absolviam por vizinho: faltar
      // `es:` numa era coberto pelo `es:` da seguinte. É o "companheiro errado"
      // que o `erro-com-codigo` levou duas rodadas pra matar, reintroduzido num
      // arquivo novo (décima revisão de segurança, 2026-09-20, LOW-3).
      const bloco = DICT.slice(i, DICT.indexOf('},', i));
      for (const lang of ['en:', 'pt:', 'es:']) expect(bloco).toContain(lang);
    },
  );

  /**
   * E NENHUM DELES NOMEIA UM TRILHO. A regra já existe no repositório — "uma
   * chave POR TRILHO, não uma frase com 'Pix' dentro traduzida pra espanhol" —
   * com censo em `i18n.test.ts`, que varre só `^(home|land)\.` e por isso não
   * via nenhuma destas. O `psp_rejected` chegou a mandar "tente o Pix" numa
   * frase emitida NO caminho do Pix, e em espanhol, onde o mercado é
   * `['bizum','card']`. Nona revisão de compliance (2026-09-19, HIGH-1).
   */
  test.each([['psp_rejected'], ['psp_unavailable'], ['card_declined'], ['card_token_invalid'], ['charge_maybe_captured'], ['charge_not_started']])(
    '`%s` não nomeia um trilho', (codigo) => {
      const i = DICT.indexOf(`'err.${codigo}'`);
      expect(i).toBeGreaterThan(0);
      const bloco = DICT.slice(i, DICT.indexOf('},', i));
      expect(bloco).not.toMatch(/\bpix\b/i);
      expect(bloco).not.toMatch(/\bbizum\b/i);
      /**
       * E os que servem OS DOIS trilhos também não podem falar de cartão.
       *
       * A isenção é por ONDE O CÓDIGO PODE SER EMITIDO, não pelo nome dele:
       * `card_declined` e `card_token_invalid` só saem de chamadas de cartão, e
       * `charge_maybe_captured` só é posto quando `capturou` é verdadeiro — o
       * que exige uma carteira que captura. Nesses três, nomear o cartão é o
       * conteúdo da mensagem, não um deslize.
       *
       * Os outros (`psp_rejected`, `psp_unavailable`, `charge_not_started`)
       * saem do `api()` compartilhado, por onde o `createPixCharge` passa.
       */
      const SO_DE_CARTAO = new Set(['card_declined', 'card_token_invalid', 'charge_maybe_captured']);
      if (!SO_DE_CARTAO.has(codigo)) {
        expect(bloco).not.toMatch(/\bcard\b|\bcartão\b|\btarjeta\b/i);
      }
    },
  );
});
