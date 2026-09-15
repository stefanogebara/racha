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
  });

  /**
   * O PISO ERA `>= 8`, E PISO NÃO É COBERTURA.
   *
   * Um piso diz que existem oito trios; não diz QUAIS. Com ele, apagar o trio
   * do `evasao_de_folha` e duplicar o do `adverbio` passava verde: a contagem
   * não muda, e a peça que só esse trio prende fica sem eixo trilíngue nenhum.
   * É a mesma forma do piso `>= 18` da forma direcional — medir quantidade
   * quando o que importa é identidade.
   *
   * Então a asserção é sobre o CONJUNTO. Trio novo obriga a escrever o nome
   * dele aqui, que é o momento em que alguém pergunta "essa peça já não estava
   * coberta?"; trio removido falha alto. Achado pela revisão de compliance de
   * 2026-09-15 (MEDIUM-3).
   */
  test('o conjunto de peças com eixo trilíngue é exatamente este', () => {
    const PECAS_COM_EIXO = [
      'adversativa_inicial (travessão)',
      'adversativa_inicial / revoga_dispensa',
      'adverbio',
      'cabeca_forte',
      'destino_em_qualquer_lugar + cabeca_genitiva',
      'determinante / sujeito_nominal',
      'evasao_de_folha',
      'gatilho_forma_direcional (quantidade)',
      'negadores',
      'separador_de_clausula',
      'separador_de_clausula (prefixo por segmento)',
      'substantivo_gorjeta',
    ];
    expect([...new Set(T.trios.map((t) => t.peca))].sort()).toEqual(PECAS_COM_EIXO.sort());
    // Dois trios com o MESMO nome de peça seriam dois eixos para uma peça e
    // zero para outra, sem que o conjunto acima percebesse.
    expect(T.trios.map((t) => t.peca).sort()).toEqual(PECAS_COM_EIXO.sort());
    // Toda peça nomeada existe de verdade no desenho: nome que não casa campo
    // nenhum do `claims.json` é eixo que mede uma peça imaginária.
    const G = JSON.parse(fs.readFileSync(
      path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;
    const inexistentes = PECAS_COM_EIXO
      .flatMap((n) => n.split(/[/+]/).map((x) => x.trim().replace(/\s*\(.*\)$/, '')))
      .filter((n) => !(n in G));
    expect(inexistentes).toEqual([]);
  });
});
