'use strict';

/**
 * O CAMPO QUE O CLIENTE MANDA TINHA TRAVA; O QUE TODO CLIENTE LÊ, NÃO.
 *
 * `payer_label` é `char_length between 1 and 60` desde a 0001, e o nome da
 * conta da casa desde a 0005. `venues.name`, `venues.city` e
 * `venue_tables.label` nasceram `text` puro e as rotas conferiam só se estava
 * vazio — e os três saem, sem autenticação nenhuma, no `/api/check` que todo
 * cliente lê ao encostar o telefone no QR.
 */

const { normalizarTextoDaCasa, nomeDaCasa, rotuloDaMesa, cidadeDaCasa, LIMITES } = require('../_lib/texto-da-casa');

/**
 * Os invisíveis por ESCAPE. Literais, eles sumiriam deste arquivo como somem de
 * qualquer revisão — que é a propriedade que os torna perigosos num rótulo de
 * mesa. A ferramenta de shell desta sessão chegou a recusar o comando que os
 * continha, dizendo que "ficariam escondidos no diálogo de aprovação".
 */
const RLO = '\u202E', LRO = '\u202D', ZWSP = '\u200B', BOM = '\uFEFF', PDI = '\u2069', NUL = '\u0000';

describe('as palavras da casa atravessam inteiras', () => {
  // CLAUDE.md: conteúdo da casa nunca é traduzido nem reescrito. Um
  // normalizador que "limpa" acento está reescrevendo a placa do restaurante.
  test.each([
    ['Boteco do Zé'.normalize('NFC')],
    ["Bar L'Escala"],
    ['Casa & Cia'],
    ['Açaí Ñandú'.normalize('NFC')],
    ['Mesa 7'],
    ['Pizzaria 2ª Rua'],
    ['Restaurante “O Forno”'],
  ])('%s passa sem mudar', (texto) => {
    expect(nomeDaCasa(texto)).toEqual({ ok: true, valor: texto });
  });

  test('espaço repetido e nas pontas some — "Mesa   7" e "Mesa 7" são a mesma mesa', () => {
    expect(rotuloDaMesa('  Mesa   7 ')).toEqual({ ok: true, valor: 'Mesa 7' });
  });
});

describe('o que não atravessa', () => {
  test('não-string recusa — `String({})` é verdadeiro e viraria o nome de uma casa', () => {
    for (const v of [{}, [], 42, true, { toString: () => 'Casa' }]) {
      expect({ v: typeof v, r: nomeDaCasa(v).ok }).toEqual({ v: typeof v, r: false });
    }
  });

  test('vazio e só-espaço recusam com CÓDIGO, não com frase', () => {
    expect(nomeDaCasa('')).toEqual({ ok: false, code: 'venue_name_invalid', vars: { maxChars: LIMITES.nomeDaCasa } });
    expect(nomeDaCasa('   ')).toEqual({ ok: false, code: 'venue_name_invalid', vars: { maxChars: LIMITES.nomeDaCasa } });
    expect(rotuloDaMesa(null)).toEqual({ ok: false, code: 'table_label_invalid', vars: { maxChars: LIMITES.rotuloDaMesa } });
  });

  test('a cidade é OPCIONAL — ausente vira null, não recusa', () => {
    expect(cidadeDaCasa(null)).toEqual({ ok: true, valor: null });
    expect(cidadeDaCasa('')).toEqual({ ok: true, valor: null });
    expect(cidadeDaCasa('   ')).toEqual({ ok: true, valor: null });
    expect(cidadeDaCasa('São Paulo'.normalize('NFC')).valor).toBe('São Paulo'.normalize('NFC'));
  });

  test('o limite é medido em PONTOS DE CÓDIGO, como o `char_length` do Postgres', () => {
    // Emoji: um ponto de código, DUAS unidades UTF-16. Contar `.length` daria um
    // limite diferente do que o banco aplica — o portão aprova e a escrita falha,
    // ou o contrário.
    const cheio = '\u{1F37B}'.repeat(LIMITES.rotuloDaMesa);
    expect(cheio.length).toBe(LIMITES.rotuloDaMesa * 2);      // UTF-16
    expect([...cheio].length).toBe(LIMITES.rotuloDaMesa);     // pontos de código
    expect(rotuloDaMesa(cheio).ok).toBe(true);
    expect(rotuloDaMesa(cheio + '\u{1F37B}').ok).toBe(false);
  });

  test('um nome de 1 MB é recusado sem ser percorrido quatro vezes', () => {
    const t0 = Date.now();
    expect(nomeDaCasa('x'.repeat(1000000)).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe('os caracteres que somem no diff', () => {
  /**
   * A MARCA DE DIREÇÃO NO RÓTULO.
   *
   * U+202E (RLO) faz o resto da linha ser DESENHADO ao contrário: num rótulo de
   * mesa, "Mesa 7" vira outra coisa na tela de quem senta. U+200B (zero-width)
   * faz duas mesas com rótulos idênticos aos olhos passarem pela unicidade do
   * banco — e aí o cliente lê "Mesa 12" em duas mesas e paga a conta da outra.
   */
  test.each([
    ['RLO', 'Mesa' + RLO + ' 7', 'Mesa 7'],
    ['LRO', LRO + 'Mesa 7', 'Mesa 7'],
    ['zero-width', 'Mesa' + ZWSP + ' 12', 'Mesa 12'],
    ['BOM', BOM + 'Mesa 3', 'Mesa 3'],
    ['isolate', 'Mesa 4' + PDI, 'Mesa 4'],
    ['NUL', 'Mesa' + NUL + '5', 'Mesa5'],
  ])('%s some do rótulo', (_nome, entrada, esperado) => {
    expect(rotuloDaMesa(entrada)).toEqual({ ok: true, valor: esperado });
  });

  test('duas mesas "iguais aos olhos" viram a MESMA string — o `unique` passa a enxergá-las', () => {
    expect(rotuloDaMesa('Mesa' + ZWSP + ' 12').valor).toBe(rotuloDaMesa('Mesa 12').valor);
  });

  test('um rótulo que era SÓ invisível não vira mesa', () => {
    expect(rotuloDaMesa(ZWSP + BOM + RLO).ok).toBe(false);
  });

  test('NFC: as duas formas de "é" viram a mesma', () => {
    const decomposto = 'Café';
    expect(decomposto.length).toBe(5);
    expect([...nomeDaCasa(decomposto).valor].length).toBe(4);
  });
});

describe('o limite do código é o limite do banco', () => {
  test('o CHECK da migração usa os mesmos números', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
    const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    // Um limite MAIOR no banco deixa passar o que o portão recusa (inofensivo);
    // um MENOR faz o portão aprovar e a escrita falhar com erro de Postgres na
    // cara do dono. Os dois têm que ser o mesmo número.
    for (const [nome, max] of [
      ['venues_name_len', LIMITES.nomeDaCasa],
      ['venues_city_len', LIMITES.cidade],
      ['venue_tables_label_len', LIMITES.rotuloDaMesa],
    ]) {
      const m = sql.match(new RegExp(nome + '[\\s\\S]{0,200}?between 1 and (\\d+)'));
      expect({ nome, achou: !!m }).toEqual({ nome, achou: true });
      expect({ nome, max: Number(m[1]) }).toEqual({ nome, max });
    }
  });
});

describe('a rota usa o normalizador — não uma cópia', () => {
  test('o `router` não confere nome/rótulo por conta própria', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A forma antiga, que dizia só "não está vazio".
    expect(fonte).not.toMatch(/String\(b\.(name|label)\)\.trim\(\)/);
    expect(fonte).toContain('nomeDaCasa(b.name)');
    expect(fonte).toContain('rotuloDaMesa(b.label)');
  });

  test('o mesmo normalizador serve o nome da conta da casa', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '_lib', 'house', 'house-service.js'), 'utf8');
    expect(fonte).toContain('normalizarTextoDaCasa');
    expect(normalizarTextoDaCasa('Ana' + RLO, { max: 60, code: 'x' })).toEqual({ ok: true, valor: 'Ana' });
  });
});
