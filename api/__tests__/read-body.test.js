'use strict';

const { EventEmitter } = require('events');
const { readBody, MAX_BYTES } = require('../_lib/read-body');

/** Um `req` de mentira que é só um stream de eventos, que é tudo que a função usa. */
function fakeReq() {
  const req = new EventEmitter();
  req.destroy = () => { req.destroyed = true; };
  req.pause = () => { req.paused = true; };
  return req;
}

describe('readBody', () => {
  test('corpo normal resolve com o texto cru', async () => {
    // Cru, e não parseado: o HMAC dos webhooks assina os BYTES.
    const req = fakeReq();
    const p = readBody(req);
    req.emit('data', '{"a":');
    req.emit('data', '1}');
    req.emit('end');
    expect(await p).toBe('{"a":1}');
  });

  test('corpo grande REJEITA com 413 — não pendura a invocação', async () => {
    // O bug: era `req.destroy()` e mais nada. Depois disso o `'end'` nunca
    // dispara, então a promessa nunca se resolvia e a invocação ficava presa
    // até o timeout da plataforma. Alcançável sem autenticação em `/api/pay` e
    // nos dois webhooks: N POSTs de 2 MB prendem N invocações de graça.
    const req = fakeReq();
    const p = readBody(req);
    req.emit('data', 'x'.repeat(MAX_BYTES + 1));
    await expect(p).rejects.toMatchObject({ statusCode: 413, code: 'body_too_large' });
    // PAUSA, não destrói: destruir mata o socket antes de a resposta sair, e
    // quem chama recebe um reset de TCP em vez do 413. Medido contra o servidor
    // de verdade — `ConnectionResetError` — depois da primeira correção.
    expect(req.paused).toBe(true);
    expect(req.destroyed).toBeUndefined();
  });

  test('stream que acaba sem `end` rejeita em vez de ficar calado pra sempre', async () => {
    // Conexão cortada no meio do corpo. Sem o `'close'`, nada resolvia.
    const req = fakeReq();
    const p = readBody(req);
    req.emit('data', '{"a":');
    req.emit('close');
    await expect(p).rejects.toMatchObject({ statusCode: 400, code: 'body_incomplete' });
  });

  test('a promessa se resolve exatamente UMA vez', async () => {
    // `'end'` seguido de `'close'` é a sequência normal de um stream sadio. Se
    // o `'close'` rejeitasse depois de um `'end'` bem-sucedido, todo pagamento
    // viraria um erro — e um `unhandledRejection` junto.
    const req = fakeReq();
    const p = readBody(req);
    req.emit('data', 'ok');
    req.emit('end');
    req.emit('close');
    req.emit('error', new Error('tarde demais'));
    expect(await p).toBe('ok');
  });

  test('corpo já pré-populado pelo runtime passa direto', async () => {
    // A Vercel pode entregar `req.body` pronto. Aí o teto de stream não se
    // aplica: quem limitou foi a plataforma, antes de nós.
    expect(await readBody({ body: 'cru' })).toBe('cru');
    expect(await readBody({ body: { a: 1 } })).toBe('{"a":1}');
  });

  test('o teto é configurável, e a borda é exata', async () => {
    const ok = fakeReq();
    const p1 = readBody(ok, { maxBytes: 10 });
    ok.emit('data', '1234567890');   // exatamente 10 → passa
    ok.emit('end');
    expect(await p1).toBe('1234567890');

    const big = fakeReq();
    const p2 = readBody(big, { maxBytes: 10 });
    big.emit('data', '12345678901'); // 11 → recusa
    await expect(p2).rejects.toMatchObject({ statusCode: 413 });
  });
});

describe('bytes, não caracteres', () => {
  test('caractere de vários bytes partido entre pedaços sobrevive', async () => {
    // O bug que este teste fecha, e a razão de ele não ter sido visto: a
    // função fazia `data += c` com `c` sendo um Buffer, então cada pedaço era
    // decodificado sozinho e um caractere partido na fronteira virava U+FFFD.
    // O corpo cru é o que o HMAC assina, então a assinatura não fechava → 401
    // → reenvio → endpoint DESABILITADO, de forma intermitente.
    //
    // Os testes acima emitem STRINGS, e com strings o bug não existe. Este
    // emite BYTES, como um socket de verdade.
    const corpo = JSON.stringify({ nome: 'João', casa: 'Bar Pepe · Caña' });
    const full = Buffer.from(corpo, 'utf8');
    // Corta no meio do 'ã' (C3 A3) de João.
    const corte = full.indexOf(Buffer.from([0xc3, 0xa3])) + 1;
    expect(corte).toBeGreaterThan(1);

    const req = fakeReq();
    const p = readBody(req);
    req.emit('data', full.subarray(0, corte));
    req.emit('data', full.subarray(corte));
    req.emit('end');
    const lido = await p;
    expect(lido).toBe(corpo);
    // E os bytes lidos são IDÊNTICOS aos enviados — é isso que o HMAC exige.
    expect(Buffer.from(lido, 'utf8').equals(full)).toBe(true);
    expect(lido).not.toContain('\uFFFD');
  });

  test('o teto conta BYTES, não caracteres', async () => {
    // `data.length` contava unidades UTF-16: um corpo de acentos passava do
    // teto real por um fator de dois a três antes de ser recusado.
    const req = fakeReq();
    const p = readBody(req, { maxBytes: 10 });
    // 6 caracteres, 12 bytes em UTF-8.
    req.emit('data', Buffer.from('ãããããã', 'utf8'));
    await expect(p).rejects.toMatchObject({ statusCode: 413 });

    // E 5 desses cabem em 10 bytes, exatamente.
    const ok = fakeReq();
    const p2 = readBody(ok, { maxBytes: 10 });
    ok.emit('data', Buffer.from('ããããã', 'utf8'));
    ok.emit('end');
    expect(await p2).toBe('ããããã');
  });
});
