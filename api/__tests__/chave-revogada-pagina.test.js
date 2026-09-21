'use strict';

/**
 * A METADE QUE PAGINA, MEDIDA PELA ROTA.
 *
 * O `saude-do-adquirente.test.js` prova a DECISÃO — escopo, contagem, janela —
 * sem rede nem relógio. Isto prova o resto: que a decisão chega a virar aviso
 * quando alguém de verdade toca em pagar.
 *
 * Sem este arquivo, a linha que liga as duas coisas (`adquirente.aoFalhar` no
 * catch do `/api/pay`) podia ser APAGADA com a suíte inteira verde — o único
 * guarda dela era um censo de texto sobre o caminho de sucesso. É exatamente a
 * forma que o doc de abertos deste repositório conta duas vezes ("um guarda
 * novo nasceu inerte") e que a própria mudança declarava ter aprendido.
 * Achado pela revisão de compliance de 2026-09-21 (HIGH-2).
 */

// ANTES de o roteador carregar: o observador é um singleton de módulo, e com a
// janela de produção o primeiro caso deste arquivo calaria todos os outros.
// Zero = sem debounce, que é o que estes testes querem medir.
process.env.RACHA_JANELA_AVISO_ADQUIRENTE_MS = '0';

const { Readable } = require('node:stream');

for (const [chave, proibido] of [['RACHA_STORE', 'supabase'], ['RACHA_PSP', 'pagarme']]) {
  if ((process.env[chave] || '').trim() === proibido) {
    throw new Error(`${chave}=${proibido}: este arquivo SEMEIA dados e cobra pelo roteador real.`);
  }
}

// Interceptado ANTES de o roteador carregar: ele captura a função no require.
const notify = require('../_lib/notify');
const avisos = [];
let respostaDaPonte = { ok: true, status: 200, entregue: true };
notify.notifyFounderMoneyEvent = async (a) => { avisos.push(a); return respostaDaPonte; };

const { route, store, psp } = require('../_app/router');

function pedir(body) {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {
      method: 'POST',
      url: '/api/pay',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '8.8.8.8' },
      socket: { remoteAddress: '8.8.8.8' },
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
        try { corpo = JSON.parse(corpo); } catch { /* cru */ }
        resolve({ status: status || res.statusCode, corpo });
      },
    };
    route(req, res).catch((e) => resolve({ status: -1, corpo: { erro: e.message } }));
  });
}

async function mesa() {
  const venue = await store.seedVenue({ name: 'Bar', servicoBp: 0, pspRecipientId: 're_real' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  await store.openCheck(table.qrToken, [{ id: 'i', name: 'Prato', priceCents: 100000 }]);
  return { venue, table };
}

const pagar = (table) => pedir({
  token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725',
});

/** Troca o criador de cobrança por um que falha do jeito pedido. */
function adquirenteQueFalha(httpStatus) {
  const original = psp.createPixCharge;
  psp.createPixCharge = async () => {
    throw Object.assign(new Error('pagarme POST /orders'), {
      statusCode: 402, code: 'psp_rejected', httpStatus,
    });
  };
  return () => { psp.createPixCharge = original; };
}

/** O aviso sai depois da resposta; dá uma volta no laço de eventos. */
const deixarOAvisoSair = () => new Promise((r) => { setTimeout(r, 30); });

beforeEach(() => { avisos.length = 0; respostaDaPonte = { ok: true, status: 200, entregue: true }; });

describe('a chave revogada pagina alguém', () => {
  test('o 401 do adquirente vira aviso ao fundador, na PRIMEIRA cobrança', async () => {
    const { table } = await mesa();
    const restaurar = adquirenteQueFalha(401);
    try {
      const r = await pagar(table);
      await deixarOAvisoSair();
      // Quem está na mesa continua recebendo o código certo.
      expect(r.corpo.code).toBe('psp_rejected');
      // E alguém foi acordado.
      expect(avisos).toHaveLength(1);
      expect(avisos[0].kind).toBe('account_alert');
      expect(avisos[0].detail).toMatch(/credencial/i);
    } finally { restaurar(); }
  });

  test('um soluço de rede NÃO acorda ninguém', async () => {
    const { table } = await mesa();
    const restaurar = adquirenteQueFalha(0);
    try {
      await pagar(table);
      await deixarOAvisoSair();
      expect(avisos).toHaveLength(0);
    } finally { restaurar(); }
  });

  test('e o aviso não carrega dado pessoal nem o texto do gateway', async () => {
    const { table } = await mesa();
    const restaurar = adquirenteQueFalha(401);
    try {
      await pagar(table);
      await deixarOAvisoSair();
      const a = avisos[0];
      expect(a.txid).toBeNull();
      expect(a.checkId).toBeNull();
      expect(a.amountCents).toBe(0);
      // O CPF do pagador e a frase da Pagar.me ficam de fora.
      expect(a.detail).not.toMatch(/52998224725|pagarme POST|orders/i);
    } finally { restaurar(); }
  });

});

describe('o apagão que chega vestido de 200', () => {
  /**
   * `createPixCharge` pode devolver 200 do transporte e nenhuma `qr_code` — a
   * causa típica é Pix não habilitado na conta, que derruba TODAS as casas no
   * trilho principal. Sem código e sem `httpStatus` isso virava `internal`
   * ("algo deu errado, tente de novo" — que convida a retentativa) e não
   * paginava ninguém.
   */
  test('Pix sem qr_code é apagão de plataforma, não "tente de novo"', async () => {
    const { table } = await mesa();
    const original = psp.createPixCharge;
    psp.createPixCharge = async () => {
      const e = new Error('pagarme: cobrança Pix sem qr_code (Pix nao habilitado)');
      e.statusCode = 402; e.code = 'psp_rejected'; e.httpStatus = 403;
      throw e;
    };
    try {
      const r = await pagar(table);
      await deixarOAvisoSair();
      expect(r.corpo.code).toBe('psp_rejected');
      expect(r.corpo.code).not.toBe('internal');
      expect(avisos).toHaveLength(1);
    } finally { psp.createPixCharge = original; }
  });

  test('e o adaptador de verdade marca esse erro — não só o dublê', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', 'pagarme-psp.js'), 'utf8');
    const i = fonte.indexOf('sem qr_code');
    expect(i).toBeGreaterThan(0);
    const bloco = fonte.slice(i, i + 900);
    expect(bloco).toMatch(/httpStatus = 403/);
    expect(bloco).toMatch(/code = 'psp_rejected'/);
  });
});

/**
 * POR ÚLTIMO, DE PROPÓSITO: este caso deixa a janela da plataforma em recuo
 * curto ao provar que a não-entrega encurta em vez de desligar. Rodando antes,
 * ele calava os casos seguintes — e o teste que falhava seria lido como "o
 * aviso não sai", quando o que acontecia era "o aviso deste teste já saiu".
 */
describe('a entrega é conferida, não presumida', () => {
  /**
   * 200 NÃO QUER DIZER ENTREGUE. Se a ponte responde 200 e nada é entregue, a
   * instância não pode ficar calada a janela inteira achando que paginou.
   */
  test('aviso não entregue volta a tentar em um minuto, não em quinze', async () => {
    const { table } = await mesa();
    const restaurar = adquirenteQueFalha(401);
    try {
      respostaDaPonte = { ok: false, status: 200, entregue: false };
      await pagar(table);
      await deixarOAvisoSair();
      expect(avisos).toHaveLength(1);

      // O recuo curto é MAIOR que a janela zerada destes testes, então ele é o
      // que segura aqui — e é exatamente o que se quer provar: a não-entrega
      // encurta, não desliga.
      await pagar(table);
      await deixarOAvisoSair();
      expect(avisos).toHaveLength(1);
    } finally { restaurar(); }
  });
});
