'use strict';

/**
 * O `/api/check` responde a mesma coisa pra todo token errado, sempre.
 *
 * Este arquivo já testou duas coisas erradas, e as duas versões foram escritas
 * com confiança. Vale registrar as duas:
 *
 *  1. A revisão pediu um limite e sugeriu 240 requisições / 10 min / IP. A
 *     aritmética recusa: o telefone consulta de 4 em 4 segundos (150 por
 *     janela) e um salão inteiro é um IP atrás do NAT — dois telefones na
 *     primeira mesa estouravam a cota.
 *  2. Aí passou a contar ERRO e devolver 429 no 404 seguinte. Também errado:
 *     trocar 404 por 429 troca um oráculo por outro (o `200` continua dizendo
 *     "achei"), a consulta ao banco já tinha acontecido antes do balde, e o
 *     tráfego legítimo queimava a cota — o app seguia consultando depois de a
 *     conta fechar, então todo poll virava MISS.
 *
 * O que vale, e é o que este arquivo agora amarra: `qr_token` tem 122 bits, a
 * varredura é impossível, então não há porta pra fechar — só sinal pra medir. A
 * resposta é sempre a mesma e o excesso vira log.
 */

const { registraMissDeCheck, clientIp } = require('../_app/router');

function req(ip) {
  return { headers: { 'x-real-ip': ip }, socket: { remoteAddress: ip } };
}

describe('o /api/check não denuncia nada pra quem sonda', () => {
  test('errar muito não muda a resposta — nem o tipo de retorno', () => {
    const r = req(`10.1.0.${Math.floor(Math.random() * 200) + 1}`);
    // Cem erros seguidos do mesmo hop. A função não decide nada: não devolve
    // "pode" nem "não pode", porque a rota não tem o que decidir.
    for (let i = 0; i < 100; i += 1) {
      expect(registraMissDeCheck(r)).toBeUndefined();
    }
  });

  test('a rota devolve 404 pro token errado, e só 404', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    const rota = src.slice(
      src.indexOf("url.pathname === '/api/check'"),
      src.indexOf("url.pathname === '/api/pay'"),
    );
    const bloco = rota.slice(rota.indexOf('if (!data) {'), rota.indexOf('// Confirm-on-read'));
    expect(bloco).toMatch(/json\(res, 404[\s\S]*code: 'check_not_found'/);
    // Nenhum 429 e nenhum limitador com veredito: os dois davam ao atacante um
    // segundo sinal, e ao cliente atrás do CGNAT a mensagem errada.
    expect(bloco).not.toMatch(/429/);
    expect(bloco).not.toMatch(/if \(!rateLimit/);
    expect(rota).not.toMatch(/rateLimitBucket\(req, 'check'/);
  });

  test('o cliente PARA o relógio no 404 — senão o erro legítimo vira enxurrada', () => {
    // A causa da queima de cota, e o conserto que importa: 404 é estado
    // ESTÁVEL (a conta fechou, ou ainda não abriu) e relógio não muda estado
    // estável. Sem isto, cada telefone deixado na tela mandava 15 erros por
    // minuto, pra sempre.
    const fs = require('node:fs');
    const path = require('node:path');
    const app = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/if \(err\.code === 'check_not_found'\) setPolling\(false\);/);
  });

  test('o IP vem do último hop, não do primeiro — o primeiro é escrito pelo cliente', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }, socket: {} })).toBe('9.9.9.9');
    expect(clientIp({ headers: { 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '1.2.3.4' }, socket: {} })).toBe('8.8.8.8');
  });
});
