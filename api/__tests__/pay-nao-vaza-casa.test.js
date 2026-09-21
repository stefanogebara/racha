'use strict';

/**
 * O `/api/pay` NÃO DEVOLVE O ID DA CASA.
 *
 * O `/api/check` é público — quem tem a foto do QR lê, sem login — e a projeção
 * dele omite `venues.id` de propósito. Essa decisão custou caro pra ser
 * descoberta ao contrário: na oitava revisão, o interruptor da carteira lia
 * `view.venue.id` de uma projeção que não tem `id`, e por isso nunca liberou
 * ninguém.
 *
 * Quando o vigia do adquirente passou a precisar do id da casa pra zerar a
 * contagem de recusas seguidas, o caminho barato foi devolvê-lo no resultado do
 * `charge()` — a casa já tinha sido lida pra cobrar. Só que o `/api/pay`
 * responde `data: result` INTEIRO. Acrescentar uma chave lá dentro é
 * acrescentar uma chave na resposta pública, e eu escrevi num comentário que "a
 * rota escolhe campo a campo" antes de conferir. Ela não escolhe.
 *
 * Este arquivo é o que impede o combinado de depender de alguém lembrar: mede a
 * RESPOSTA, não a intenção.
 */

const { Readable } = require('node:stream');

for (const [chave, proibido] of [['RACHA_STORE', 'supabase'], ['RACHA_PSP', 'pagarme']]) {
  if ((process.env[chave] || '').trim() === proibido) {
    throw new Error(`${chave}=${proibido}: este arquivo SEMEIA dados e cobra pelo roteador real.`);
  }
}

const { route, store } = require('../_app/router');

function pedir(method, url, body) {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from([body ? JSON.stringify(body) : '']), {
      method,
      url,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.7' },
      socket: { remoteAddress: '7.7.7.7' },
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
        try { corpo = JSON.parse(corpo); } catch { /* deixa cru */ }
        resolve({ status: status || res.statusCode, corpo });
      },
    };
    route(req, res).catch((e) => resolve({ status: -1, corpo: { erro: e.message } }));
  });
}

async function mesa() {
  const venue = await store.seedVenue({ name: 'Bar', servicoBp: 1000, pspRecipientId: 're_real' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  await store.openCheck(table.qrToken, [{ id: 'i', name: 'Prato', priceCents: 10000 }]);
  return { venue, table };
}

/** Procura o valor em QUALQUER profundidade — chave renomeada não salva. */
function contem(objeto, agulha) {
  if (objeto === agulha) return true;
  if (Array.isArray(objeto)) return objeto.some((x) => contem(x, agulha));
  if (objeto && typeof objeto === 'object') return Object.values(objeto).some((x) => contem(x, agulha));
  return false;
}

describe('a resposta do pagamento não carrega o id da casa', () => {
  test('nem pela chave, nem pelo valor, em nenhuma profundidade', async () => {
    const { venue, table } = await mesa();
    const r = await pedir('POST', '/api/pay', {
      token: table.qrToken, amountCents: 1000, tipCents: 0, payerDocument: '52998224725',
    });
    expect(r.status).toBe(200);
    expect(r.corpo.data).toBeTruthy();
    expect(r.corpo.data.venueId).toBeUndefined();
    // O VALOR também não, senão renomear a chave contornaria o teste.
    expect(contem(r.corpo, venue.id)).toBe(false);
  });

  test('e o `/api/check` continua sem o id — é de lá que a decisão vem', async () => {
    const { venue, table } = await mesa();
    // O parâmetro é `t`, não `token`.
    const r = await pedir('GET', `/api/check?t=${table.qrToken}`);
    expect(r.status).toBe(200);
    expect(contem(r.corpo, venue.id)).toBe(false);
  });

  /**
   * E o campo PRECISA existir no resultado interno — senão o vigia perde o
   * caminho de zerar, e "recusas seguidas" vira "acumuladas desde o boot".
   * Sem esta asserção, apagar o `venueId` do `create-charge` deixaria o teste
   * de cima verde e o vigia quebrado.
   */
  test('mas o `charge()` interno devolve, senão o vigia não zera', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', 'create-charge.js'), 'utf8');
    expect(fonte).toMatch(/venueId:\s*venue\.id/);
    const rota = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    expect(rota).toMatch(/adquirente\.aoPagar\(result\.venueId\)/);
  });
});
