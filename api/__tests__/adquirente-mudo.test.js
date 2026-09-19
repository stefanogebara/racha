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

describe('todos os códigos que saem daqui têm tradução nos três idiomas', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const DICT = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');

  test.each([['charge_maybe_captured'], ['psp_unavailable'], ['psp_rejected'], ['card_declined'], ['card_token_invalid']])(
    '`%s`', (codigo) => {
      const i = DICT.indexOf(`'err.${codigo}'`);
      expect(i).toBeGreaterThan(0);
      const bloco = DICT.slice(i, i + 400);
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
    },
  );
});
