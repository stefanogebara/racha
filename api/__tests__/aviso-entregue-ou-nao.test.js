'use strict';

/**
 * O QUE NÃO SE DECLAROU ENTREGUE, NÃO FOI — e este é o teste que faltava.
 *
 * O módulo foi partido em duas metades de propósito: `saude-do-adquirente` é
 * decisão pura e tem suíte própria; `observa-adquirente` é a metade de I/O. A
 * metade pura foi testada. A de I/O não tinha um único teste — `grep -rn
 * observa-adquirente api/__tests__/` devolvia um comentário.
 *
 * E era justamente ali que morava a lição que o commit anterior escreveu no
 * próprio docblock: "200 não quer dizer entregue". A leitura do retorno era
 * `!r || r.ok !== false` — uma lista de NEGAÇÃO de um valor só, que perde pra
 * qualquer forma não antecipada. E a forma existe no mesmo repositório: sem
 * `RACHA_NOTIFY_SECRET`, o `notifyFounderMoneyEvent` devolve
 * `{ skipped: true, reason: 'no_secret' }`, sem chave `ok` — `undefined !==
 * false` é verdadeiro, então o pager que NUNCA SAIU era registrado como
 * entregue e a janela de supressão ficava de pé sobre um aviso inexistente.
 * O inegociável #8 desligado por variável de ambiente ausente.
 *
 * O teste de rota que se chamava "a não-entrega é DETECTADA" media só que a
 * ponte tinha sido CHAMADA: apagar as duas linhas que leem o retorno o
 * deixava verde. Achado pelas duas revisões da décima terceira rodada, cada
 * uma por um lado (compliance MEDIUM-1, segurança MEDIUM-2).
 */

const { criarObservadorDoAdquirente } = require('../_lib/pay/observa-adquirente');

/** Uma falha de ESTA casa: 422 entra na contagem por contas distintas. */
const recusaDaCasa = () => Object.assign(new Error('recusado'), {
  code: 'psp_rejected', statusCode: 402, httpStatus: 422,
});

/** O vigia, com o mínimo que o observador consome — e um espião no recuo. */
function vigiaEspiao() {
  const naoEntregues = [];
  return {
    naoEntregues,
    registrarSucesso() {},
    naoEntregue(chave) { naoEntregues.push(chave); },
    registrarFalha() {
      return { kind: 'account_alert', escopo: 'casa', chave: 'casa:v1', venueId: 'v1', detail: 'd' };
    },
  };
}

const store = { async getVenueForCheck() { return { id: 'v1' }; } };

/**
 * O `kind` ATRAVESSA — e este teste é o que impede a cópia literal de voltar.
 *
 * O observador escrevia `kind: 'account_alert'` à mão, ao lado de um
 * `aviso.kind` que o vigia já tinha calculado. Com a ponte de verdade, um kind
 * que o `notify.js` não conheça o faz LANÇAR: a exceção cai no catch do
 * `avisar`, `entregue` vira falso, e NENHUMA página sai — o pager morto por
 * uma string duplicada. O censo da ponte não vê, porque o literal está na
 * lista dela; só ver o valor CHEGAR do outro lado vê. (segurança LOW-5.)
 */
test('o kind que o vigia calculou é o que chega na ponte', async () => {
  const recebidos = [];
  const vigia = { ...vigiaEspiao() };
  vigia.registrarFalha = () => ({
    kind: 'kind_do_vigia', escopo: 'casa', chave: 'casa:v1', venueId: 'v1', detail: 'd',
  });
  const observador = criarObservadorDoAdquirente({
    store, vigia, notifyFounderMoneyEvent: async (ev) => { recebidos.push(ev.kind); return { ok: true }; },
  });
  const p = observador.aoFalhar(recusaDaCasa(), 'chk_1');
  if (p) await p;
  expect(recebidos).toEqual(['kind_do_vigia']);
});

async function medir(resposta) {
  const vigia = vigiaEspiao();
  const observador = criarObservadorDoAdquirente({
    store,
    vigia,
    notifyFounderMoneyEvent: typeof resposta === 'function' ? resposta : async () => resposta,
  });
  const p = observador.aoFalhar(recusaDaCasa(), 'chk_1');
  if (p) await p;
  return vigia.naoEntregues;
}

describe('a não-entrega do aviso encurta a janela — por FORMA de retorno', () => {
  let stderr;
  beforeEach(() => { stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(() => stderr.mockRestore());

  test('entregue de verdade: a janela fica de pé', async () => {
    expect(await medir({ ok: true, status: 200 })).toEqual([]);
  });

  test('`{ok:false}` — a ponte respondeu e nenhum canal entregou', async () => {
    expect(await medir({ ok: false, status: 200 })).toEqual(['casa:v1']);
  });

  test('`{skipped:true}` — SEM `RACHA_NOTIFY_SECRET`, o aviso nem foi tentado', async () => {
    // A forma que a lista de negação deixava passar: sem chave `ok`.
    expect(await medir({ skipped: true, reason: 'no_secret' })).toEqual(['casa:v1']);
  });

  test('a ponte LANÇA: também não foi entregue', async () => {
    expect(await medir(async () => { throw new Error('rede'); })).toEqual(['casa:v1']);
  });

  test('forma desconhecida: o silêncio não conta como entrega', async () => {
    // O ponto da lista de PERMISSÃO: o retorno que ninguém previu cai no lado
    // seguro, e não no que cala a instância pela janela inteira.
    expect(await medir({ status: 202 })).toEqual(['casa:v1']);
    expect(await medir(undefined)).toEqual(['casa:v1']);
  });

  test('o `{skipped}` deixa rastro no stderr, com o motivo', async () => {
    await medir({ skipped: true, reason: 'no_secret' });
    const linhas = stderr.mock.calls.map(([l]) => String(l));
    expect(linhas.some((l) => l.includes('NAO entregue') && l.includes('no_secret'))).toBe(true);
  });
});
