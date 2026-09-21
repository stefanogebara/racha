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
let atrasoDoAviso = 0;
/**
 * UM interceptador só, lendo variáveis mutáveis. O roteador DESESTRUTURA
 * `notifyFounderMoneyEvent` no require, então trocar `notify.x` depois não
 * alcança o que ele chama — a primeira versão deste arquivo tentou e o atraso
 * simplesmente não existia.
 */
notify.notifyFounderMoneyEvent = async (a) => {
  if (atrasoDoAviso) await new Promise((r) => { setTimeout(r, atrasoDoAviso); });
  avisos.push(a);
  return respostaDaPonte;
};

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

/** Um contexto de requisição da Vercel, no símbolo que ela usa. */
const comContexto = () => {
  const waitUntil = jest.fn();
  const sim = Symbol.for('@vercel/request-context');
  const antes = globalThis[sim];
  globalThis[sim] = { get: () => ({ waitUntil }) };
  return {
    waitUntil,
    volta: () => { if (antes === undefined) delete globalThis[sim]; else globalThis[sim] = antes; },
  };
};

/** Segura o envio do aviso: separa "a resposta saiu" de "o aviso saiu". */
const atrasarAviso = (ms) => { atrasoDoAviso = ms; return () => { atrasoDoAviso = 0; }; };

beforeEach(() => {
  avisos.length = 0;
  atrasoDoAviso = 0;
  respostaDaPonte = { ok: true, status: 200, entregue: true };
});

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

  /**
   * A DEMO cobra pelo MockPsp e não diz nada sobre o adquirente de verdade.
   * A exclusão estava sem teste: apagá-la deixava a suíte verde, e ela só era
   * inerte por sorte (os erros do mock não carregam `httpStatus`).
   */
  test('a mesa de demonstração nunca acorda ninguém', async () => {
    const { DEMO_TABLE_TOKEN } = require('../_lib/demo');
    const original = psp.createPixCharge;
    psp.createPixCharge = async () => {
      throw Object.assign(new Error('mock'), { statusCode: 402, code: 'psp_rejected', httpStatus: 401 });
    };
    try {
      await pedir({ token: DEMO_TABLE_TOKEN, amountCents: 500, tipCents: 0, payerDocument: '52998224725' });
      await deixarOAvisoSair();
      expect(avisos).toHaveLength(0);
    } finally { psp.createPixCharge = original; }
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

/**
 * O ATAQUE DE GRITAR LOBO, e o dedo gordo que o imita sem querer.
 *
 * `payerDocument` era aceito com onze dígitos e NENHUM verificador, embora o
 * `isValidCPF` exista neste repositório e o cliente já o use. Um CPF falso
 * passava do nosso portão, a Pagar.me recusava com 4xx, e o vigia contava
 * aquilo como SAÚDE DA CASA: três requisições sem autenticação, com uma foto
 * do QR, e o fundador era paginado dizendo "ninguém paga aqui" sobre um
 * restaurante são — no mesmo canal que carrega o alerta de plataforma que esta
 * peça existe pra entregar. Achado pela revisão de segurança de 2026-09-21
 * (HIGH-2).
 */
describe('um documento inválido não vira saúde da casa', () => {
  test('o CPF com verificador errado para no NOSSO portão', async () => {
    const { table } = await mesa();
    let chamouOAdquirente = false;
    const original = psp.createPixCharge;
    psp.createPixCharge = async () => { chamouOAdquirente = true; throw new Error('não devia'); };
    try {
      const r = await pedir({
        token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '00000000000',
      });
      expect(r.status).toBe(400);
      expect(r.corpo.code).toBe('tax_id_invalid');
      // E nem chegou no adquirente — é isso que impede a contagem falsa.
      expect(chamouOAdquirente).toBe(false);
    } finally { psp.createPixCharge = original; }
  });

  test('três tentativas com CPF falso NÃO paginam ninguém', async () => {
    const { table } = await mesa();
    const original = psp.createPixCharge;
    psp.createPixCharge = async () => {
      throw Object.assign(new Error('pagarme 422'), { statusCode: 402, code: 'psp_rejected', httpStatus: 422 });
    };
    try {
      for (let i = 0; i < 4; i += 1) {
        await pedir({ token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '11111111111' });
      }
      await deixarOAvisoSair();
      expect(avisos).toHaveLength(0);
    } finally { psp.createPixCharge = original; }
  });

  test('e o CPF VÁLIDO segue passando — senão o portão virou muro', async () => {
    const { table } = await mesa();
    const r = await pedir({
      token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725',
    });
    expect(r.status).toBe(200);
  });
});

/**
 * SEM CASA RESOLVIDA, NÃO CONTA COMO CASA. Três falhas ÚNICAS em três casas
 * DIFERENTES caíam num balde compartilhado e paginavam "3 recusas seguidas
 * nesta casa" sem dizer qual — página falsa, e justamente quando o banco está
 * ruim junto com o adquirente (segurança 2026-09-21, MEDIUM-3).
 */
describe('recusa de casa sem id não vira contagem', () => {
  /**
   * A casa vem SEM `id` — que é a forma realista, e a que já mordeu duas vezes
   * neste repositório (o interruptor da carteira lendo `view.venue.id` de uma
   * projeção que não tem `id`).
   *
   * Fazer o `getVenueForCheck` LANÇAR não serve como teste: o próprio
   * `charge()` o chama antes, então a cobrança morre sem nunca chegar no
   * adquirente, e o teste passaria pelo motivo errado — foi o que a primeira
   * versão deste caso fazia.
   */
  test('com a casa vindo sem `id`, três casas não viram uma', async () => {
    const t1 = await mesa(); const t2 = await mesa(); const t3 = await mesa();
    const origLookup = store.getVenueForCheck;
    const origCharge = psp.createPixCharge;
    store.getVenueForCheck = async (id) => {
      const v = await origLookup.call(store, id);
      return v ? { ...v, id: undefined } : v;
    };
    psp.createPixCharge = async () => {
      throw Object.assign(new Error('pagarme 422'), { statusCode: 402, code: 'psp_rejected', httpStatus: 422 });
    };
    try {
      for (const t of [t1, t2, t3]) {
        await pedir({ token: t.table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725' });
      }
      await deixarOAvisoSair();
      expect(avisos).toHaveLength(0);
    } finally { store.getVenueForCheck = origLookup; psp.createPixCharge = origCharge; }
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
 * O AVISO SOBREVIVE À RESPOSTA — as duas metades do padrão.
 *
 * `waitUntil` é NO-OP documentado sem contexto de requisição: o
 * `@vercel/functions` faz `getContext().waitUntil?.(promise)` e o `getContext`
 * devolve `{}` quando o símbolo não está lá. Então "pedir pra viver" não
 * garante nada sozinho, e o `esperaDisponivel` existe pra cobrir o outro caso.
 *
 * Os testes acima NÃO viam isso: no jest também não há contexto, então trocar o
 * `depoisDaResposta` por `void` deixava todos eles verdes — o `setTimeout(30)`
 * deles dava tempo da promessa solta terminar. Um teste que passa porque o
 * ambiente dele se parece com o caso degradado não mede o caso bom.
 * Achado pela revisão de segurança de 2026-09-21 (HIGH-1).
 */
describe('o aviso sobrevive à resposta', () => {
  test('COM contexto: a Vercel recebe a promessa, e ela é a do aviso', async () => {
    const { table } = await mesa();
    const restaurar = adquirenteQueFalha(401);
    const ctx = comContexto();
    const solta = atrasarAviso(200);
    try {
      const r = await pagar(table);
      expect(r.corpo.code).toBe('psp_rejected');
      // A resposta saiu ANTES do aviso…
      expect(avisos).toHaveLength(0);
      // A rota entrega mais de uma promessa à plataforma (o reconciliador
      // também), então o que se mede não é a CONTAGEM e sim se esperar o que
      // foi entregue BASTA pro aviso ter saído. Com `void`, não bastaria: o
      // aviso só chegaria por sorte de cronômetro.
      expect(ctx.waitUntil).toHaveBeenCalled();
      await Promise.all(ctx.waitUntil.mock.calls.map(([pr]) => pr));
      expect(avisos).toHaveLength(1);
    } finally { solta(); ctx.volta(); restaurar(); }
  });

  test('SEM contexto: o aviso sai ANTES da resposta, em vez de talvez nunca', async () => {
    const { table } = await mesa();
    const restaurar = adquirenteQueFalha(401);
    const solta = atrasarAviso(200);
    try {
      const r = await pagar(table);
      // Já tinha saído quando a resposta chegou — lento e entregue vence
      // rápido e calado.
      expect(avisos).toHaveLength(1);
      expect(r.corpo.code).toBe('psp_rejected');
    } finally { solta(); restaurar(); }
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

