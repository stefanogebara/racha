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
  const F2 = F.documento_da_casa.casos;

  test('cada caso do fixture sai como o fixture diz', () => {
    const divergiram = [];
    for (const c of F2) {
      const r = doc.normalizarDocumentoDaCasa(c.entrada, c.market);
      if (r.ok !== c.ok) { divergiram.push(`${c.market} ${JSON.stringify(c.entrada)}: ok=${r.ok}, esperado ${c.ok}`); continue; }
      if (c.ok && r.valor !== c.valor) {
        divergiram.push(`${c.market} ${JSON.stringify(c.entrada)}: valor=${JSON.stringify(r.valor)}, esperado ${JSON.stringify(c.valor)}`);
      }
      if (!c.ok && r.code !== 'tax_id_invalid') {
        divergiram.push(`${c.market} ${JSON.stringify(c.entrada)}: code=${r.code}`);
      }
    }
    expect(divergiram).toEqual([]);
    // O corpo cobre os dois mercados e os dois lados da linha.
    expect(F2.filter((c) => c.market === 'es').length).toBeGreaterThan(3);
    expect(F2.filter((c) => c.market === 'br' && c.ok === false).length).toBeGreaterThan(5);
  });

  test('todo CPF válido é recusado como documento de CASA', () => {
    // Documento de casa é documento de empresa. A versão anterior aceitava
    // CPF porque foi escrita em cima do `isValidCpfCnpj`, que aceita os dois,
    // e `venues.cnpj` sai no `/api/check` sem autenticação nenhuma.
    const cpfs = F.validos.filter((v) => v.tipo === 'cpf');
    expect(cpfs.length).toBeGreaterThan(1);
    for (const v of cpfs) {
      expect(doc.isValidCpfCnpj(v.doc)).toBe(true);          // é documento válido
      expect(doc.normalizarDocumentoDaCasa(v.doc, 'br').ok).toBe(false);  // e não serve aqui
    }
  });

  test('o que sai pro cliente é conferido pelo VALOR, não só pelo mercado', () => {
    for (const c of F.publicacao.casos) {
      expect(doc.documentoPublicavelDaCasa(c.market, c.valor, c.mostra)).toBe(c.sai);
    }
  });

  test('o que não é texto nem número é recusado, sem estourar', () => {
    for (const lixo of [{}, [], true, () => {}, Symbol('x'), 12n, NaN, Infinity]) {
      expect(() => doc.normalizarDocumentoDaCasa(lixo, 'br')).not.toThrow();
      expect(doc.normalizarDocumentoDaCasa(lixo, 'br').ok).toBe(false);
    }
  });

  test('o corte por tamanho NÃO é o que recusa a string enorme — e fica assim mesmo', () => {
    // Honestidade sobre o que este teste prova.
    //
    // A primeira versão media o relógio e dizia "se alguém inverter a ordem,
    // isto fica lento". A revisão inverteu a ordem: passou em 2 ms. A segunda
    // versão afirmou provar a ordem estruturalmente; também não provava —
    // tirando o `length > 32`, tudo continua sendo recusado, porque uma
    // string de 33 dígitos não é CPF nem CNPJ e o `docKind` a derruba.
    // Verificado por mutação: com o corte fora, os dez testes seguem verdes.
    //
    // Então o corte NÃO é carregador hoje. Ele fica como profundidade: a
    // regex de forma canônica é ancorada sobre uma classe de caracteres só,
    // sem backtracking, e por isso 1 MB custa fração de milissegundo — mas
    // isso é propriedade DESTA regex, e quem lhe acrescentar um quantificador
    // não vai pensar no corpo de 1 MB do `readBody`. O que este teste afirma
    // é só o comportamento observável, que é o que um teste pode afirmar.
    expect(doc.normalizarDocumentoDaCasa('0'.repeat(33), 'br').ok).toBe(false);
    expect(doc.normalizarDocumentoDaCasa('x'.repeat(1_000_000), 'br').ok).toBe(false);
    expect(doc.normalizarDocumentoDaCasa('B' + '1'.repeat(40), 'es').ok).toBe(false);
    // E rápido, sem afirmar POR QUE é rápido.
    const t0 = process.hrtime.bigint();
    doc.normalizarDocumentoDaCasa('0'.repeat(1_000_000), 'br');
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(50);
  });

  test('o código de erro é um que o cliente já sabe traduzir', () => {
    // O servidor nunca manda texto de exibição (CLAUDE.md). Um código novo
    // sem chave no dicionário vira texto cru na tela de quem não lê português.
    const fs = require('node:fs');
    const path = require('node:path');
    const dict = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
    const r = doc.normalizarDocumentoDaCasa('99999999999999', 'br');
    expect(r.ok).toBe(false);
    expect(dict).toContain(`'err.${r.code}'`);
  });

  test('a rota não manda frase junto com o código', () => {
    // `{ error: 'CNPJ inválido', code: 'tax_id_invalid' }` mandava as duas
    // coisas: o código pro cliente traduzir e uma frase em português pra quem
    // não pediu português. Ver `http-error.js` — "com CÓDIGO, a mensagem
    // interna NÃO viaja".
    const fs = require('node:fs');
    const path = require('node:path');
    const router = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    const linha = router.split('\n').find((l) => l.includes('code: doc.code'));
    expect(linha).toBeTruthy();
    expect(linha).not.toMatch(/error:\s*'/);
  });
});
