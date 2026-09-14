'use strict';

/**
 * O SEXTO INSTRUMENTO: O EIXO TRILÍNGUE.
 *
 * O guarda é trilíngue por desenho e o corpo era ~99% português. Os seis
 * defeitos de meia-tradução que este repositório já pagou foram todos achados
 * por acaso. Aqui a pergunta é feita de propósito: a MESMA frase nas três
 * línguas tem que dar o MESMO veredito.
 *
 * O QUE ISTO NÃO MEDE: oito trios não são um corpo. Ele prende as peças que
 * cada trio NOMEIA, e a lista cresce quando uma peça nova nascer só numa
 * língua — que é como todas as seis nasceram.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const T = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'trilingue.fixture.json'), 'utf8'));
const FONTE = fs.readFileSync(path.join(__dirname, 'claims.test.js'), 'utf8');

function carrega() {
  const corpo = FONTE.slice(0, FONTE.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tri-'));
  const arq = path.join(tmp, 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  return require(arq);
}

describe('a mesma frase nas três línguas dá o mesmo veredito', () => {
  const { acusa } = carrega();

  test.each(T.trios.map((t) => [`${t.peca} — ${t.pt.replace(/\n/g, ' ⏎ ').slice(0, 44)}`, t]))(
    '%s', (_nome, t) => {
      const fora = ['pt', 'en', 'es']
        .filter((l) => acusa(t[l]) !== t.recusa)
        .map((l) => `${l}: ${JSON.stringify(t[l])} deu ${acusa(t[l])}, esperado ${t.recusa}`);
      expect(fora).toEqual([]);
    });

  test('cada trio nomeia a peça que mede e escreve o porquê', () => {
    for (const t of T.trios) {
      expect(`${t.peca}: ${t.porque}`).toMatch(/.{120,}/);
      for (const l of ['pt', 'en', 'es']) expect(typeof t[l]).toBe('string');
    }
    // As três línguas do produto, e o `es` está construído e desligado — o que
    // não o dispensa do guarda: o censo governa o texto dele hoje.
    expect(T.trios.length).toBeGreaterThanOrEqual(8);
  });
});
