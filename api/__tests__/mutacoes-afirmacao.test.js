'use strict';

/**
 * O PORTÃO DE MUTAÇÃO.
 *
 * O corpo compartilhado (`afirmacoes.fixture.json`) fechou a divergência entre
 * os dois guardas — mas a revisão de segurança mediu o que ele PRENDE, e a
 * resposta foi humilhante: das seis peças do desenho, três eram invisíveis.
 * Dava pra apagar o laço da gorjeta, o da direcional e o do destinatário
 * anterior, e o corpo continuava verde. Os quarenta e sete casos tinham sido
 * escritos a partir do conserto — todos os primeiros com vírgula, todos os
 * seguintes com marcador de lista — que é a mesma falha que o
 * `_porque_esta_na_terceira_versao` narra, pela terceira vez, agora com um
 * JSON entre as duas cópias em vez de um porte à mão.
 *
 * Um corpo prova que o código de HOJE passa. Só a mutação prova que cada peça
 * do desenho carrega alguma coisa. Aqui cada mutação nomeada é aplicada ao
 * arquivo de verdade, o corpo roda, e exige-se VERMELHO. Peça que não pode
 * ficar vermelha não tem teste — e, como este repositório aprendeu cinco vezes
 * nesta semana, guarda que não dispara é guarda ausente (inegociável #7).
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const ALVO = path.join(__dirname, 'claims.test.js');
const F = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'afirmacoes.fixture.json'), 'utf8'));

/**
 * Cada peça do desenho, com a mutação que a apaga. O texto é o que está no
 * arquivo; se um refactor mudar a linha, esta lista quebra alto — que é o
 * comportamento certo, porque a lista só vale se descrever o código de hoje.
 */
const MUTACOES = [
  { nome: 'âncora do substantivo da gorjeta',
    de: 'for (const g of gorjetas) if (g.index + g[0].length <= d.index) { ini = Math.max(ini, g.index + g[0].length); achou = true; }',
    para: '' },
  { nome: 'âncora da forma direcional',
    de: 'for (const dir of direcionais) if (dir.index <= d.index) { ini = Math.max(ini, dir.index - 10); achou = true; }',
    para: '' },
  { nome: 'âncora do separador interno',
    de: 'for (const sp of seps) if (sp.index + sp[0].length <= d.index) { ini = Math.max(ini, sp.index + sp[0].length); achou = true; }',
    para: '' },
  // ── SEM COBERTURA, e dito em voz alta ──────────────────────────────────
  //
  // Estas duas peças NÃO conseguem ficar vermelhas contra o corpo, e eu não
  // achei entrada que as distinga — procurei por busca, não por intuição. Pela
  // régua deste arquivo isso quer dizer que elas não têm teste, e ficam aqui
  // marcadas em vez de sumirem do relatório:
  //
  //  · `âncora do destinatário anterior` — impedir que a negação do primeiro
  //    destinatário cubra o segundo. Toda entrada que construí pra isolá-la
  //    tinha também vírgula ou substantivo ancorando no mesmo ponto.
  //  · `nega usando a lista de EVASÃO` — trocar `negadores` por
  //    `revoga_dispensa` no `nega`. A evasão preposicional aparece, na prática,
  //    DEPOIS do destinatário (é onde ela qualifica a folha), e ali a checagem
  //    já usa `negadores`.
  //
  // As duas podem ser redundância — e redundância sob um comentário que afirma
  // o contrário é exatamente o que este repositório passou a semana achando.
  // Ficam porque falham FECHADO (tirá-las aperta o guarda, não afrouxa), e
  // porque decidir removê-las sem entrada que as distinga seria adivinhar nos
  // dois sentidos. O que NÃO se faz é contá-las como cobertas.
  { nome: 'âncora do destinatário anterior', semCobertura: true,
    de: '    let ini = anterior;\n    let achou = anterior > 0;',
    para: '    let ini = 0;\n    let achou = false;' },
  { nome: 'nega volta a usar a lista de EVASÃO em vez da de negadores', semCobertura: true,
    de: 'const antes = ini < d.index && reNegador.test(oracao.slice(ini, d.index));',
    para: 'const antes = ini < d.index && reRevoga.test(oracao.slice(ini, d.index));' },
  { nome: 'o negador DEPOIS do destinatário deixa de contar',
    de: '    if (!antes && !depois) return false;',
    para: '    if (!antes) return false;' },
  { nome: 'janela falha ABERTA quando nada ancora',
    de: 'ini = achou ? Math.max(0, Math.min(ini, d.index)) : d.index;',
    para: 'ini = Math.max(0, Math.min(ini, d.index));' },
  { nome: 'nega olha só o PRIMEIRO destinatário',
    de: '  for (const d of dests) {',
    para: '  for (const d of dests.slice(0, 1)) {' },
  { nome: 'a repartida olha só a PRIMEIRA oração com destinatário',
    de: '  for (let i = 0; i < partes.length; i += 1) {',
    para: '  for (let i = 0; i < Math.min(1, partes.length); i += 1) {' },
  { nome: 'a repartida dispensa a quantidade e o marcador',
    de: '    if (!reMarcador.test(o) && !reQuantidade.test(o)) continue;',
    para: '' },
  { nome: 'a ordem do distribuidor deixa de valer',
    de: '    if (partes.slice(0, i + 1).some(temDistribuidor)) continue;',
    para: '    if (partes.some(temDistribuidor)) continue;' },
  { nome: 'a dispensa volta a valer pela janela toda',
    de: '    if (reGorjeta.test(o) && reDestRuntime.test(o) && !nega(o) && !temDistribuidor(o)) return true;',
    para: '    if (reGorjeta.test(o) && reDestRuntime.test(o) && !nega(o) && !temDistribuidor(janela)) return true;' },
  // O laço sobre TODAS as cláusulas de distribuidor não entra na lista: ele só
  // difere de "só a primeira" quando uma cláusula anterior está revogada e uma
  // posterior não — e aí ele AFROUXA, não aperta. Nenhuma entrada que construí
  // distingue os dois sem ser uma frase que ninguém escreve. O que carrega
  // peso aqui é a janela olhar PRA FRENTE, e essa está logo abaixo. Dito em
  // vez de contado como coberto.
  { nome: 'a janela do distribuidor deixa de olhar pra frente',
    de: 'if (!reRevoga.test(oracao.slice(ini, m.index + m[0].length + 30))) return true;',
    para: 'if (!reRevoga.test(oracao.slice(ini, m.index + m[0].length))) return true;' },
  { nome: 'a forma direcional deixa de ser decisiva',
    de: '    if (reSuprimeGlobal.test(o) && !nega(o)) return true;',
    para: '' },
];

/** Roda o corpo contra uma cópia mutada do censo. Devolve quantos casos falham. */
function falhasCom(fonte) {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mut-'));
  const arq = path.join(tmp, 'censo.js');
  // Exporta `acusa` da cópia e corta os `describe`, que não rodam fora do jest.
  // A cópia mora num temporário, então a raiz do repositório tem que virar
  // absoluta — senão ela resolve pra dentro de /tmp e o arquivo some.
  const corpo = fonte.slice(0, fonte.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');",
             'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
             'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/");
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  const { acusa } = require(arq);
  delete require.cache[arq];
  return F.casos.filter((c) => acusa(c.texto) !== c.recusa).length;
}

describe('cada peça do desenho pode ficar vermelha', () => {
  const original = fs.readFileSync(ALVO, 'utf8');

  test('sem mutação, o corpo passa inteiro', () => {
    expect(falhasCom(original)).toBe(0);
  });

  test.each(MUTACOES.map((m) => [m.nome, m]))('%s', (_nome, m) => {
    // A mutação tem que EXISTIR no arquivo: uma lista de mutações que não
    // casam mais é uma lista que passa calada.
    expect(original.includes(m.de)).toBe(true);
    const mutado = original.replace(m.de, m.para);
    expect(mutado).not.toBe(original);
    const falhas = falhasCom(mutado);
    if (m.semCobertura) {
      // Declarada sem cobertura: se um dia ela PASSAR a ficar vermelha, é
      // porque alguém escreveu o caso — e aí a marca tem que sair. Uma
      // exceção que sobrevive à própria razão é a dívida de sempre.
      expect(falhas).toBe(0);
    } else {
      expect(falhas).toBeGreaterThan(0);
    }
  });

  test('a lista de peças sem cobertura não cresce', () => {
    // Duas hoje, as duas falhando FECHADO. Acrescentar uma terceira tem que
    // ser uma decisão, não um efeito colateral.
    expect(MUTACOES.filter((m) => m.semCobertura).length).toBeLessThanOrEqual(2);
  });
});
