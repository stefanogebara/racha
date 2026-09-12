'use strict';

/**
 * O balde do `/api/check` conta ERRO, não requisição.
 *
 * `/api/check` é pública, sem autenticação, e o telefone na mesa a consulta a
 * cada 4 segundos. A revisão de segurança pediu um limite e sugeriu
 * `('check', 240)` — 240 por 10 min por IP. A aritmética recusa o número: 4 em
 * 4 segundos são 15/min, 150 por janela, então DOIS telefones na mesma mesa
 * estouram 240 — e um salão inteiro é um IP só atrás do NAT do restaurante.
 *
 * Esse limite não protegeria nada que a plataforma já não proteja, e fecharia a
 * conta na cara do segundo cliente da primeira mesa. Mesma falha-fechada que
 * quase fez uma lista de origens recusar toda mesa impressa. Então o balde
 * conta 404: varrer token produz MISS, ler a própria conta produz HIT.
 *
 * Os dois testes que importam estão aqui, e o segundo é o que impede alguém de
 * "endurecer" isto depois: ACERTO NÃO GASTA BALDE.
 */

const { rateLimitCheckMiss, clientIp } = require('../_app/router');

function req(ip, extra = {}) {
  return { headers: { 'x-real-ip': ip, ...extra }, socket: { remoteAddress: ip } };
}

describe('o limite do /api/check pune enumeração, não a mesa cheia', () => {
  test('trinta tokens errados passam; o trigésimo primeiro não', () => {
    const r = req(`10.0.0.${Math.floor(Math.random() * 200) + 1}`);
    for (let i = 0; i < 30; i += 1) {
      expect(rateLimitCheckMiss(r)).toBe(true);
    }
    expect(rateLimitCheckMiss(r)).toBe(false);
  });

  test('um sábado cheio nunca toca o balde — porque acerto não passa por ele', () => {
    // A prova de que a mesa não quebra não é um número: é que o caminho de
    // SUCESSO do `/api/check` não chama o limitador. Se alguém mover a chamada
    // pra fora do `if (!data)`, este teste cai.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    const inicio = src.indexOf("url.pathname === '/api/check'");
    const rota = src.slice(inicio, src.indexOf("url.pathname === '/api/pay'"));

    // A única chamada da rota está DENTRO do bloco `if (!data)`.
    const ocorrencias = (rota.match(/rateLimitCheckMiss\(req\)/g) || []).length;
    expect(ocorrencias).toBe(1);
    const bloco = rota.slice(rota.indexOf('if (!data) {'), rota.indexOf('// Confirm-on-read'));
    expect(bloco).toMatch(/rateLimitCheckMiss\(req\)/);

    // E nenhum limitador POR REQUISIÇÃO entrou na rota. É o número que a
    // aritmética do topo recusa; um `rateLimitBucket(req, 'check', …)` aqui
    // derrubaria a segunda pessoa da primeira mesa.
    expect(rota).not.toMatch(/rateLimitBucket\(req, 'check'/);
  });

  test('o IP vem do último hop, não do primeiro — o primeiro é escrito pelo cliente', () => {
    // `XFF: 1.2.3.<n>` dá um balde novo por request e o limite deixa de
    // existir. Sem `x-real-ip`, o hop confiável é o ÚLTIMO.
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }, socket: {} })).toBe('9.9.9.9');
    expect(clientIp({ headers: { 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '1.2.3.4' }, socket: {} })).toBe('8.8.8.8');
  });
});
