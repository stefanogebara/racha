'use strict';

/**
 * Ler o corpo de uma requisição, com teto.
 *
 * Mora aqui, e não dentro do router, porque dentro do router não era testável
 * — e foi assim que ficou errado. O teto chamava `req.destroy()` e mais nada:
 * o `'end'` nunca dispara depois disso e o `'error'` pode não disparar, então a
 * promessa NUNCA se resolvia e a invocação ficava presa até o timeout da
 * plataforma.
 *
 * Alcançável sem autenticação em `/api/pay`, `/api/house/open` e nos dois
 * webhooks: N POSTs de 2 MB prendem N invocações pelo timeout inteiro, de graça
 * pra quem chama. Achado pela revisão de segurança de 2026-09-07.
 *
 * As três saídas, e todas resolvem a promessa exatamente uma vez:
 *  - `'end'` → o corpo;
 *  - passou do teto → 413 com código, e o stream é PAUSADO em vez de destruído
 *    (destruir mata o socket antes de a resposta sair: quem chama recebe um
 *    reset de TCP no lugar do 413 — medido);
 *  - `'error'` ou `'close'` sem `'end'` → rejeita. O `'close'` é o que faltava:
 *    um stream que acaba sem `'end'` (destruído, conexão cortada) rejeitava
 *    nada e ficava calado pra sempre.
 *
 * O corpo cru é necessário pro HMAC dos webhooks, então isto não pode ser
 * substituído por um parser de JSON.
 */

/** Teto de 1 MB. Nenhum corpo legítimo do produto chega perto. */
const MAX_BYTES = 1e6;

function readBody(req, { maxBytes = MAX_BYTES } = {}) {
  // O runtime serverless pode pré-popular `req.body`. Nesse caso o teto de
  // stream não se aplica — quem impôs limite foi a plataforma, antes de nós.
  if (req.body != null) {
    return Promise.resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) {
        // PAUSA, não destrói.
        //
        // A primeira correção rejeitava a promessa e chamava `req.destroy()` na
        // mesma linha. Isso já resolvia o problema real — a invocação era
        // liberada em milissegundos em vez de ficar presa até o timeout — mas
        // matava o socket antes de a resposta ser escrita, e quem chamava
        // recebia um reset de TCP em vez de um 413. Medido: `ConnectionResetError`.
        //
        // `pause()` para de acumular e deixa a rota responder. O corpo que
        // ainda estiver na rede é descartado; a memória para de crescer, que é
        // o que o teto existe pra garantir.
        if (typeof req.pause === 'function') req.pause();
        done(reject, Object.assign(new Error('corpo muito grande'), {
          statusCode: 413, code: 'body_too_large',
        }));
      }
    });
    req.on('end', () => done(resolve, data));
    req.on('error', (err) => done(reject, err));
    req.on('close', () => done(reject, Object.assign(
      new Error('conexão encerrada antes do fim do corpo'), {
        statusCode: 400, code: 'body_incomplete',
      },
    )));
  });
}

module.exports = { readBody, MAX_BYTES };
