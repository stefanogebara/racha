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
 * do desenho carrega alguma coisa.
 *
 * O QUE ESTE ARQUIVO NÃO MEDE, dito pra não virar confiança falsa:
 *
 *  · ~~ele muta só o lado JS~~ — o `describe` no fim deste arquivo roda o
 *    `scripts/mutar-guarda-swift.sh`, que apaga peça do guarda Swift E insere
 *    atalhos permissivos nele. Corrigido em 2026-09-14; a frase ficou aqui
 *    riscada porque o defeito que este arquivo persegue é justamente o
 *    comentário que afirma o contrário do código;
 *  · e o corpo compartilhado fica verde POR CONCORDÂNCIA quando os dois lados
 *    erram igual. Ele prova convergência, não correção. O retorno precoce da
 *    regra 3 é a prova: os dois guardas o tinham, os dois vazavam, e quem viu
 *    foi uma revisão de fora. Aqui cada mutação nomeada é aplicada ao
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

  { nome: 'a repartida deixa de exigir CABEÇA DE DESTINO',
    de: '    const resto = restoDepoisDaCabeca(o);',
    para: "    const resto = (restoDepoisDaCabeca(o) || '');" },
  { nome: 'o caminho forte deixa de exigir resto SEM PREDICAÇÃO',
    de: '      && !temPredicacao(rForte)) return true;',
    para: '      ) return true;' },
  { nome: 'o caminho FORTE deixa de existir',
    de: `    if ((reMarcador.test(seg) || reCabecaForte.test(seg)) && rForte !== null
      && !temPredicacao(rForte)) return true;`,
    para: '' },
  { nome: 'o caminho forte para de cortar no separador',
    de: '    const seg = ateOSeparador(o);',
    para: '    const seg = o;' },
  { nome: 'o caminho FRACO deixa de exigir resto vazio',
    de: "    if (!(i > 0 && reQuantidade.test(partes[i - 1]) && !/[0-9A-Za-zÀ-ÿ]/.test(resto))) continue;",
    para: '    if (!(i > 0 && reQuantidade.test(partes[i - 1]))) continue;' },
  { nome: 'a negação contrastiva deixa de desqualificar o negador',
    de: '    const depois = new RegExp(G.negador_colado, \'i\').test(cauda)\n      && !reContrastiva.test(cauda);',
    para: "    const depois = new RegExp(G.negador_colado, 'i').test(cauda);" },
  { nome: 'a relativa deixa de sair antes do teste de predicação',
    de: "  const semRelativa = resto.replace(reRelativa, ' ');",
    para: '  const semRelativa = resto;' },
  { nome: 'o pronome regido por preposição volta a contar como sujeito',
    de: '    if (!rePrepPronome.test(semRelativa.slice(0, p))) return true;',
    para: '    return true;' },
  { nome: 'o genitivo descritivo deixa de dispensar',
    de: "  return reDestRuntime.test(oracao.replace(reGenitivoDescritivo, ' '));",
    para: '  return reDestRuntime.test(oracao);' },

  { nome: 'o negador pós-destinatário volta a aceitar qualquer negador em qualquer ponto',
    de: "new RegExp(G.negador_colado, 'i')",
    para: 'reNegador' },

  { nome: 'a dispensa volta a valer pela janela toda',
    de: '    if (reGorjeta.test(o) && destinatarioNaoAtributivo(o) && !nega(o) && !temDistribuidor(o)) return true;',
    para: '    if (reGorjeta.test(o) && destinatarioNaoAtributivo(o) && !nega(o) && !temDistribuidor(janela)) return true;' },
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

/**
 * AFROUXAMENTOS — e este é o buraco do próprio instrumento.
 *
 * As mutações acima APAGAM peças e exigem vermelho. Uma linha que AFROUXA o
 * guarda é invisível pra esse formato por construção: apagá-la deixaria o
 * corpo mais verde, não mais vermelho. Foi assim que um retorno precoce ficou
 * no código — "a regra 1 já julgou essa oração", só que a regra 1 ABSOLVE a
 * oração do distribuidor e a absolvição virava o veredito do texto inteiro.
 * A revisão de compliance achou; nem o corpo compartilhado (os dois lados
 * erravam igual, então ele ficava verde por concordância) nem este arquivo
 * podiam ver.
 *
 * Então o instrumento ganha a metade que faltava: ACRESCENTAR um atalho
 * permissivo e exigir que o corpo acuse. Um corpo que não reage a um atalho
 * novo não está prendendo o guarda — está prendendo o formato dele.
 */
const AFROUXAMENTOS = [
  { nome: 'atalho: qualquer oração com os dois substantivos encerra o julgamento',
    ancora: '  const iDest = -1;',
    insere: '  if (partes.some((o) => reGorjeta.test(o) && reDestRuntime.test(o))) return false;\n' },
  { nome: 'atalho: qualquer distribuidor em qualquer lugar dispensa',
    ancora: '  const iDest = -1;',
    insere: '  if (partes.some(temDistribuidor)) return false;\n' },
  { nome: 'atalho: negação em qualquer lugar do texto dispensa',
    ancora: '  const iDest = -1;',
    insere: '  if (reNegador.test(janela)) return false;\n' },
  { nome: 'atalho: só a primeira oração é olhada',
    ancora: '  const iDest = -1;',
    insere: '  partes = partes.slice(0, 1);\n' },
];

/**
 * ALARGAMENTOS — a terceira metade do instrumento.
 *
 * Apagar uma peça mede FALSO POSITIVO: o corpo fica vermelho porque o guarda
 * passou a deixar coisa entrar. Inserir um atalho mede o mesmo pelo outro
 * lado. Nenhum dos dois enxerga um TETO DE ARIDADE, e por construção: a peça
 * o teto de palavras da regra 3 era `<= 4`, e a revisão mediu a lista de limites —
 * 3, 4, 5, 6, 40 — e achou que o corpo prendia o botão a UMA casa e não dizia
 * nada sobre a classe. Subir o limite deixava tudo verde. Quarenta e oito de
 * sessenta e quatro afirmações partidas escapavam por cima de um teto que
 * nenhuma mutação conseguia tocar.
 *
 * Então: ALARGAR a peça e exigir vermelho. Um limite que pode ser afrouxado
 * sem o corpo reagir é um limite que ninguém escolheu.
 * Pedido pelas revisões de compliance e segurança de 2026-09-14.
 */
const ALARGAMENTOS = [
  { nome: 'a aridade do modificador sobe de dois pra nove',
    insere: "G.modificador_de_destino = G.modificador_de_destino.replace('{0,2}', '{0,9}');\n" },
  { nome: 'a cabeça deixa de ser ancorada no começo da oração',
    insere: "G.cabeca_de_destino = G.cabeca_de_destino.replace('^', '');\n" },
  { nome: 'o núcleo de atribuição passa a aceitar qualquer substantivo',
    insere: "G.nucleo_de_atribuicao = '[\\\\wáéíóúâêôãõç-]+';\n" },
  { nome: 'o verbo finito deixa de ver o sujeito nulo',
    insere: "G.verbo_finito = 'zzzznuncacasa';\n" },
  { nome: 'o pronome sujeito deixa de contar',
    insere: "G.pronome_sujeito = 'zzzznuncacasa';\n" },
  { nome: 'a quantidade consumida passa a aceitar qualquer palavra',
    insere: "G.quantidade_consumida = '([\\\\wáéíóúâêôãõç%$€.,-]+)';\n" },
];
// Os alargamentos entram ANTES do primeiro padrão composto, porque as peças
// são compartilhadas: alargar só a cabeça e não o `destino_em_qualquer_lugar`,
// que é pré-condição da mesma regra, mediria uma metade e chamaria de medição.
//
// E CADA UM NOMEIA A PEÇA, não um literal. A versão anterior fazia
// `replace('{0,2}', '{0,9}')` sobre o arquivo INTEIRO, e `{0,2}` aparecia em
// três peças diferentes: o vermelho vinha do adverbio da forma direcional e da
// cauda da relativa, e o modificador — a peça que a mutação nomeia, a que
// existe por causa de `to the FLOOR staff` — não era medida. Um portão que
// reporta verde-virou-vermelho pelo motivo errado. Achado pela revisão de
// segurança de 2026-09-14.
const ANCORA_ALARGAMENTO = 'const reDestinoQualquer = new RegExp(';

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

  test.each(AFROUXAMENTOS.map((m) => [m.nome, m]))('afrouxar: %s', (_nome, m) => {
    // O atalho entra logo antes do laço da regra 3 e o corpo tem que ACUSAR a
    // perda. Se ficar verde, é o corpo que não está prendendo nada.
    expect(original.includes(m.ancora)).toBe(true);
    const mutado = original.replace(m.ancora, m.insere + m.ancora);
    expect(mutado).not.toBe(original);
    expect(falhasCom(mutado)).toBeGreaterThan(0);
  });

  test.each(ALARGAMENTOS.map((m) => [m.nome, m]))('alargar: %s', (_nome, m) => {
    // A peça é AFROUXADA no lugar, e o corpo tem que acusar. Vermelho aqui é
    // prova de que o valor escolhido carrega peso; verde é botão decorativo.
    expect(original.includes(ANCORA_ALARGAMENTO)).toBe(true);
    const mutado = original.replace(ANCORA_ALARGAMENTO, m.insere + ANCORA_ALARGAMENTO);
    expect(mutado).not.toBe(original);
    expect(falhasCom(mutado)).toBeGreaterThan(0);
  });

  test('a lista de peças sem cobertura não cresce', () => {
    // Duas hoje, as duas falhando FECHADO. Acrescentar uma terceira tem que
    // ser uma decisão, não um efeito colateral.
    expect(MUTACOES.filter((m) => m.semCobertura).length).toBeLessThanOrEqual(2);
  });
});

describe('o guarda SWIFT também é medido', () => {
  /**
   * O resto deste arquivo muta o CENSO. O guarda que chega ao cliente é o
   * Swift, e até 2026-09-14 ninguém tinha apagado peça dele pra ver se o corpo
   * compartilhado reage — a medição que envergonhou o desenho JS (três de seis
   * peças apagáveis com o corpo verde) nunca tinha sido rodada do outro lado,
   * e os quatro achados daquela rodada eram todos de peças que os DOIS lados
   * compartilham. Apontado pela revisão de segurança.
   *
   * O script roda `swiftc` direto sobre os dois arquivos do Agent — dois
   * segundos por mutação, sem Xcode. Fica sob `describe` pra que `npx jest`
   * cubra os dois lados; num ambiente sem toolchain Swift ele é PULADO, e
   * pular é dito em voz alta, não silencioso.
   */
  const { execFileSync } = require('node:child_process');
  const temSwift = (() => {
    try { execFileSync('which', ['swiftc'], { stdio: 'pipe' }); return true; } catch { return false; }
  })();

  (temSwift ? test : test.skip)('cada peça do guarda Swift pode ficar vermelha', () => {
    const saida = execFileSync(path.join(RAIZ, 'scripts', 'mutar-guarda-swift.sh'),
      { encoding: 'utf8', timeout: 600000 });
    // Toda linha tem que começar com ✓: um `✗` é peça sem cobertura, um `·` é
    // mutação que nem compila.
    const ruins = saida.split('\n').filter((l) => l.startsWith('✗'));
    expect(ruins).toEqual([]);
    expect(saida).toMatch(/sem mutação: \d+ casos, 0 falhas/);
    // Sete peças hoje. Encolher a lista tem que ser decisão, não descuido.
    expect((saida.match(/^✓/gm) || []).length).toBeGreaterThanOrEqual(8);
  });
});
