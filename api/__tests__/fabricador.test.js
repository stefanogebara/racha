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
 * `claims.json`, e o teste abaixo prova isso em vez de afirmar. `logo` saiu em
 * 2026-09-14: ele É membro do `palavra_funcional`, então injetado entre o
 * negador e o núcleo tornava o vão MAIS funcional e podia virar acusação em
 * negação — um terço do vocabulário de injeção não era neutro, e a prova não
 * via porque ela nomeava nove campos à mão. Uma injeção
 * que por acaso fosse destinatário, quantidade ou verbo mudaria o SENTIDO, e
 * aí o veredito poderia mudar com razão.
 */
const NEUTRAS = ['sempre', 'assim', 'francamente'];

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

/**
 * Cada texto com UMA palavra neutra injetada em cada fronteira — e as
 * fronteiras incluem o COMEÇO do texto e o começo de cada linha.
 *
 * A primeira versão injetava só depois de espaço INTERNO, e por isso era cega
 * exatamente à região que a rodada que a criou tinha editado: `comecaNaForma`,
 * os dois testes de prefixo do `cabecaValida`, o `marcador_de_lista`, o `^` do
 * `contraste_colado` e o do `negador_colado` leem todos a posição zero. Um
 * instrumento que não alcança o lugar onde as decisões moram mede outra coisa.
 * Com o eixo de POSIÇÃO, três casos do corpo caíam de cara.
 * Achado pela revisão de compliance de 2026-09-14.
 */
function* injecoes(texto) {
  for (const palavra of NEUTRAS) {
    for (let i = 0; i < texto.length; i += 1) {
      // Depois de espaço interno, e ANTES de cada linha (inclusive a primeira).
      const fronteira = texto[i] === ' ' ? i + 1
        : (i === 0 || texto[i - 1] === '\n') ? i : -1;
      if (fronteira < 0) continue;
      yield [`${texto.slice(0, fronteira)}${palavra} ${texto.slice(fronteira)}`, palavra, i];
    }
  }
}

const TOLERADAS = G._injecoes_toleradas || {};

/**
 * A TERCEIRA GAVETA tem a mesma disciplina das dispensas: cada tolerância
 * nomeia o caso, escreve a razão, e é USADA. Sem isso ela vira o lugar onde as
 * falhas vão morar. Apontado pela revisão de compliance antes de ela ter a
 * primeira entrada — que é a hora certa de pôr a regra.
 */
describe('as tolerâncias do fabricador têm a disciplina das dispensas', () => {
  test('cada uma nomeia um caso do corpo, tem razão escrita, e é usada', () => {
    const casos = new Set(F.casos.map((c) => c.texto));
    expect(Object.keys(TOLERADAS).filter((t) => !casos.has(t))).toEqual([]);
    for (const [caso, razoes] of Object.entries(TOLERADAS)) {
      expect(Array.isArray(razoes) && razoes.length).toBeTruthy();
      for (const r of razoes) expect(`${caso}: ${r}`).toMatch(/.{80,}/);
    }
    expect(Object.keys(TOLERADAS).length).toBeLessThanOrEqual(4);
  });
});

describe('uma palavra a mais não desfaz uma promessa', () => {
  const { acusa } = carrega();

  test('as palavras injetadas são NEUTRAS de verdade', () => {
    // Prova, não afirma: se uma delas entrar numa lista de vocabulário, a
    // injeção passa a mudar o sentido e o instrumento vira ruído.
    // A LISTA DERIVA DO JSON. Escrita à mão com nove nomes, ela não via um
    // décimo — e não via três: `palavra_funcional`, `sujeito_nominal` e
    // `destinatario_ambiguo` entraram na rodada passada, e `logo` É MEMBRO de
    // `palavra_funcional`. Um terço do vocabulário de injeção não era neutro,
    // no teste escrito pra trocar afirmação por prova.
    // Achado pela revisão de compliance de 2026-09-14.
    const NAO_VOCABULARIO = ['guarda', 'porque', 'frase_sancionada', 'janela_linhas',
      'onde_o_censo_anda', 'destinatarios_so_deteccao', 'frases_aposentadas',
      'frases_aprovadas', 'dispensas',
      // `palavra_funcional` é a exceção declarada, e é o contrário de uma
      // contaminação: ela lista o que NÃO é conteúdo — verbo, preposição,
      // artigo, advérbio. Uma palavra neutra tem que ser funcional; se não
      // fosse, injetá-la mudaria o sentido da frase e o oráculo do fabricador
      // estaria errado, não o guarda. Membro daqui é qualificação, não sujeira.
      // `palavra_funcional`, `negador_colado` e `sujeito_nominal` carregam
      // SLOTS de advérbio, não vocabulário. Uma palavra neutra é, por
      // definição, um advérbio — aparecer num slot de advérbio é o que a
      // qualifica, não o que a contamina. O que contaminaria é ser
      // DESTINATÁRIO, QUANTIDADE, VERBO ou SUBSTANTIVO DE GORJETA.
      'palavra_funcional', 'negador_colado', 'sujeito_nominal', 'adverbio'];
    const listas = Object.keys(G).filter(
      (k) => !k.startsWith('_') && typeof G[k] === 'string' && !NAO_VOCABULARIO.includes(k));
    // A pergunta é de IGUALDADE, não de casamento: `modificador_de_destino` é
    // um slot que casa qualquer palavra, e `artigo_de_destino` tem um `a` que
    // casa dentro de `assim`. Suja é a palavra que É uma alternativa de uma
    // lista, não a que aparece dentro de um padrão.
    const limpa = (t) => t.replace(/\\b|\(\?:|[()^$]/g, '').trim();
    const sujas = [];
    for (const palavra of NEUTRAS) {
      for (const lista of listas) {
        const alts = G[lista].split('|').map(limpa);
        if (alts.includes(palavra)) sujas.push(`${palavra} ∈ ${lista}`);
      }
    }
    expect(sujas).toEqual([]);
  });

  const promessas = F.casos.filter((c) => c.recusa);
  const inocentes = F.casos.filter((c) => !c.recusa);

  /**
   * O LADO INOCENTE. O cabeçalho dizia que ele fica de fora porque "uma
   * inserção pode legitimamente criar uma promessa" — verdade pra uma palavra
   * qualquer, e falso pras palavras que este arquivo PROVA serem neutras. E a
   * direção que ele mede é a que apaga dinheiro da tela: uma palavra neutra
   * que DESTRÓI uma negação correta não cria promessa nenhuma, só faz o guarda
   * recusar a resposta certa.
   * Achado pela revisão de compliance de 2026-09-14.
   */
  test.each(inocentes.map((c) => [c.texto.replace(/\n/g, ' ⏎ ').slice(0, 60), c]))(
    'inocente: %s', (_nome, c) => {
      const caiu = [];
      for (const [variante, palavra] of injecoes(c.texto)) {
        if (acusa(variante)) caiu.push(`+${palavra} → ${variante.replace(/\n/g, '⏎')}`);
      }
      // A tolerância é POR CASO e descreve a CLASSE: a razão escrita explica
      // por que toda injeção neste caso cai do lado fail-closed.
      const naoDeclaradas = TOLERADAS[c.texto] ? [] : caiu;
      expect({ caso: c.texto.slice(0, 40), naoDeclaradas })
        .toEqual({ caso: c.texto.slice(0, 40), naoDeclaradas: [] });
    });

  /**
   * PREÂMBULOS COMUNS, que uma injeção de UMA palavra não consegue construir.
   *
   * `sujeito_nominal` precisa de determinante + substantivo pra disparar, e é
   * ele que VETA a regra 1b — uma peça que DESLIGA uma regra tem que ser
   * medida alargando-a, não apagando-a. A lista é de aberturas ordinárias de
   * frase, nenhuma delas negação: o grid que existia no `RevisaoDeAfirmacoes-
   * Tests` tinha seis preâmbulos e os seis eram negações, porque foi escrito a
   * partir do defeito da rodada anterior.
   * Achado pela revisão de compliance de 2026-09-14.
   */
  const PREAMBULOS = ['Com a conta fechada, ', 'Se a pessoa quiser, ', 'No fim da noite, ',
    'A conta fechou, ', 'Nesse caso, ', 'Pelo que vi, '];
  test.each(promessas.filter((c) => !c.texto.includes('\n'))
    .map((c) => [c.texto.slice(0, 50), c]))('preâmbulo: %s', (_nome, c) => {
      const caiu = PREAMBULOS.filter((p) => !acusa(p + c.texto[0].toLowerCase() + c.texto.slice(1)))
        .map((p) => `${p}… → ${c.texto}`);
      const naoDeclaradas = caiu.filter(
        (v) => !(TOLERADAS[c.texto] || []).some((t) => v.includes(t)));
      expect({ caso: c.texto.slice(0, 40), naoDeclaradas })
        .toEqual({ caso: c.texto.slice(0, 40), naoDeclaradas: [] });
    });
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
