'use strict';

/**
 * O FABRICADOR.
 *
 * O terceiro instrumento, e ele existe porque os dois primeiros não conseguem
 * ver a família de defeito que mais apareceu neste arquivo.
 *
 * O portão de mutação APAGA peças e ALARGA limites. O censo de tokens varre as
 * alternativas que estão ESCRITAS. Nenhum dos dois enxerga uma peça que decide
 * por ADJACÊNCIA ou por um orçamento fixo de caracteres — porque não há token
 * pra apagar nem alternativa pra varrer: o defeito é uma palavra que NÃO está
 * lá. A lista do que já custou caro por essa forma exata:
 *
 *  · o olho mágico de 14 caracteres do teste de oblíquo (1250 de 3125);
 *  · a contrastiva por adjacência, que perdia pro advérbio de foco (80 de 135);
 *  · `evasao_de_caminho` sem slot de modificador (`na conta PESSOAL dela`);
 *  · a janela de −10 caracteres do `nega` (`nunca MAIS vai pro garçom`);
 *  · e, do outro lado, `cai(em)?` e `[oad]o?s? time`, que eram palavras que
 *    ninguém conseguia escrever.
 *
 * Então: pega cada caso `recusa: true` do corpo, INJETA uma palavra neutra em
 * cada fronteira de palavra, e exige que o veredito AGUENTE. Uma promessa que
 * deixa de ser promessa porque alguém pôs um advérbio no meio nunca foi uma
 * regra — era uma coincidência de espaçamento.
 *
 * O QUE ISTO NÃO MEDE: injeta UMA palavra, não duas; injeta palavras neutras,
 * não qualquer palavra (um token de vocabulário mudaria o sentido de verdade);
 * e só olha o lado `recusa: true`, porque do lado inocente uma inserção pode
 * legitimamente criar uma promessa.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const F = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'afirmacoes.fixture.json'), 'utf8'));
const G = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;
const FONTE = fs.readFileSync(path.join(__dirname, 'claims.test.js'), 'utf8');

/**
 * PALAVRAS NEUTRAS — nenhuma delas está em lista de vocabulário nenhuma do
 * `claims.json`, e o teste abaixo prova isso em vez de afirmar. Uma injeção
 * que por acaso fosse destinatário, quantidade ou verbo mudaria o SENTIDO, e
 * aí o veredito poderia mudar com razão.
 */
const NEUTRAS = ['sempre', 'assim', 'logo'];

function carrega() {
  const corpo = FONTE.slice(0, FONTE.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-'));
  const arq = path.join(tmp, 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  return require(arq);
}

/** Cada texto com UMA palavra neutra injetada em cada fronteira de palavra. */
function* injecoes(texto) {
  for (const palavra of NEUTRAS) {
    // Fronteiras: depois de cada espaço interno de cada linha.
    for (let i = 0; i < texto.length; i += 1) {
      if (texto[i] !== ' ') continue;
      yield [`${texto.slice(0, i + 1)}${palavra} ${texto.slice(i + 1)}`, palavra, i];
    }
  }
}

const TOLERADAS = G._injecoes_toleradas || {};

describe('uma palavra a mais não desfaz uma promessa', () => {
  const { acusa } = carrega();

  test('as palavras injetadas são NEUTRAS de verdade', () => {
    // Prova, não afirma: se uma delas entrar numa lista de vocabulário, a
    // injeção passa a mudar o sentido e o instrumento vira ruído.
    const listas = ['substantivo_gorjeta', 'substantivo_destinatario', 'quantidade',
      'quantidade_consumida', 'verbo_finito', 'pronome_sujeito', 'negadores',
      'nucleo_de_atribuicao', 'preposicao_de_destino'];
    const sujas = [];
    for (const palavra of NEUTRAS) {
      for (const lista of listas) {
        if (new RegExp(G[lista], 'i').test(` ${palavra} `)) sujas.push(`${palavra} ∈ ${lista}`);
      }
    }
    expect(sujas).toEqual([]);
  });

  const promessas = F.casos.filter((c) => c.recusa);
  test.each(promessas.map((c) => [c.texto.replace(/\n/g, ' ⏎ ').slice(0, 60), c]))(
    '%s', (_nome, c) => {
      const caiu = [];
      for (const [variante, palavra] of injecoes(c.texto)) {
        if (!acusa(variante)) caiu.push(`+${palavra} → ${variante.replace(/\n/g, '⏎')}`);
      }
      const naoDeclaradas = caiu.filter(
        (v) => !(TOLERADAS[c.texto] || []).some((t) => v.includes(t)));
      expect({ caso: c.texto.slice(0, 40), naoDeclaradas })
        .toEqual({ caso: c.texto.slice(0, 40), naoDeclaradas: [] });
    });
});
