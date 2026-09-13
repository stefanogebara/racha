'use strict';

/**
 * O documento da casa, do lado do SERVIDOR.
 *
 * Metade deste arquivo testa a conferência; a outra metade testa que a
 * conferência do servidor e a do cliente continuam sendo a MESMA conferência.
 * Ver o cabeçalho de `api/_lib/br/documento.js` e o do fixture.
 */

const doc = require('../_lib/br/documento.js');
const F = require('../_lib/br/documentos.fixture.json');

describe('CPF/CNPJ com dígito verificador', () => {
  test('o fixture não encolhe até virar o caso que eu estava olhando', () => {
    expect(F.validos.length).toBeGreaterThanOrEqual(6);
    expect(F.invalidos.length).toBeGreaterThanOrEqual(6);
    // Os dois tipos, dos dois lados da linha.
    expect(F.validos.filter((v) => v.tipo === 'cpf').length).toBeGreaterThan(1);
    expect(F.validos.filter((v) => v.tipo === 'cnpj').length).toBeGreaterThan(1);
  });

  test('todo documento válido do fixture passa, e com o tipo certo', () => {
    const erraram = F.validos.filter((v) => !doc.isValidCpfCnpj(v.doc) || doc.docKind(v.doc) !== v.tipo);
    expect(erraram).toEqual([]);
  });

  test('todo documento inválido do fixture é recusado', () => {
    const passaram = F.invalidos.filter((v) => doc.isValidCpfCnpj(v.doc));
    expect(passaram).toEqual([]);
  });
});

describe('o portão de escrita do POST /api/venues', () => {
  test('cada caso do fixture sai como o fixture diz', () => {
    const divergiram = [];
    for (const c of F.normalizacao_do_servidor.casos) {
      const r = doc.normalizarCnpjDeCasa(c.entrada);
      if (r.ok !== c.ok) { divergiram.push(`${JSON.stringify(c.entrada)}: ok=${r.ok}, esperado ${c.ok}`); continue; }
      if (c.ok && r.valor !== c.valor) {
        divergiram.push(`${JSON.stringify(c.entrada)}: valor=${JSON.stringify(r.valor)}, esperado ${JSON.stringify(c.valor)}`);
      }
      if (!c.ok && r.code !== 'tax_id_invalid') {
        divergiram.push(`${JSON.stringify(c.entrada)}: code=${r.code}, esperado tax_id_invalid`);
      }
    }
    expect(divergiram).toEqual([]);
  });

  test('o que não é texto nem número é recusado, sem estourar', () => {
    for (const lixo of [{}, [], true, () => {}, Symbol('x'), 12n, NaN, Infinity]) {
      expect(() => doc.normalizarCnpjDeCasa(lixo)).not.toThrow();
      expect(doc.normalizarCnpjDeCasa(lixo).ok).toBe(false);
    }
  });

  test('uma string enorme é recusada sem ser percorrida por regex', () => {
    const enorme = 'x'.repeat(1_000_000) + '65087663000130';
    const t0 = process.hrtime.bigint();
    const r = doc.normalizarCnpjDeCasa(enorme);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.ok).toBe(false);
    // O corpo da requisição vai até 1 MB. O corte por tamanho vem ANTES da
    // regex de propósito; se alguém inverter a ordem, isto fica lento.
    expect(ms).toBeLessThan(50);
  });

  test('o código de erro é um que o cliente já sabe traduzir', () => {
    // O servidor nunca manda texto de exibição (CLAUDE.md). Um código novo
    // sem chave no dicionário vira texto cru na tela de quem não lê português.
    const fs = require('node:fs');
    const path = require('node:path');
    const dict = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
    const r = doc.normalizarCnpjDeCasa('99999999999999');
    expect(r.ok).toBe(false);
    expect(dict).toContain(`'err.${r.code}'`);
  });
});
