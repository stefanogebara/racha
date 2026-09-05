'use strict';

/**
 * As rotas do vercel.json, checadas aqui porque só o deploy checava antes.
 *
 * Custou um deploy quebrado: um catch-all com âncora e grupo opcional aninhado
 * dentro do lookahead —
 *   "/((?!api/|ios(\\.html)?$|carved/|img/).*)"
 * — é RegExp JavaScript válido, passa em qualquer teste que só faça `new
 * RegExp(...)`, e o parser de rotas da Vercel recusa na hora do build:
 * "Rewrite at index 2 has invalid `source` pattern". Nada no repositório rodava
 * antes do push, então o primeiro sinal foi o site fora do ar no preview.
 *
 * O que este arquivo garante é o mínimo que teria evitado aquilo, mais as duas
 * propriedades de roteamento que o produto depende.
 */

const path = require('path');
const vercel = require(path.join(__dirname, '..', '..', 'vercel.json'));

const rewrites = vercel.rewrites || [];

describe('vercel.json — rewrites', () => {
  test('há rewrites, e todo source começa em /', () => {
    expect(rewrites.length).toBeGreaterThan(0);
    for (const r of rewrites) expect(r.source.startsWith('/')).toBe(true);
  });

  test('todo source é RegExp válido em JS', () => {
    for (const r of rewrites) expect(() => new RegExp(r.source)).not.toThrow();
  });

  test('nenhum source usa âncora — o parser da Vercel recusa', () => {
    // O padrão já é ancorado no caminho inteiro; um ^ ou $ escrito à mão é o
    // que derrubou o build.
    for (const r of rewrites) {
      expect(r.source).not.toMatch(/[$^]/);
    }
  });

  test('lookahead só aceita alternância de prefixos literais, sem grupo aninhado', () => {
    // "(?!api/|ios/)" ok. "(?!api/|ios(\.html)?)" não: grupo com quantificador
    // dentro do lookahead é exatamente a construção recusada.
    for (const r of rewrites) {
      const look = r.source.match(/\(\?!([^)]*)\)/);
      if (!look) continue;
      expect(look[1]).not.toMatch(/[()]/);
      expect(look[1]).not.toMatch(/[?*+{]/);
    }
  });

  test('/api/ nunca cai no catch-all do SPA', () => {
    const spa = rewrites.find((r) => r.destination === '/index.html');
    expect(spa).toBeTruthy();
    expect(new RegExp(`^${spa.source}$`).test('/api/check')).toBe(false);
    expect(new RegExp(`^${spa.source}$`).test('/painel')).toBe(true);
  });

  test('/ios é roteado ANTES do catch-all, senão vira a SPA', () => {
    const ios = rewrites.findIndex((r) => r.source === '/ios');
    const spa = rewrites.findIndex((r) => r.destination === '/index.html');
    expect(ios).toBeGreaterThanOrEqual(0);
    expect(ios).toBeLessThan(spa);
    expect(rewrites[ios].destination).toBe('/ios.html');
  });

  test('todo cron aponta pra uma rota /api/', () => {
    for (const c of vercel.crons || []) expect(c.path.startsWith('/api/')).toBe(true);
  });
});
