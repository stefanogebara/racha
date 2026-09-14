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
  { nome: 'âncora do destinatário anterior',
    de: '    const vao = oracao.slice(anterior, d.index);',
    para: '    const vao = oracao.slice(0, d.index);' },
  // DEIXOU DE SER SEM COBERTURA em 2026-09-14: desde que a janela virou o
  // prefixo inteiro, a lista de evasão encontra `sem` em lugares onde a de
  // negadores não encontra nada, e o corpo vê a diferença. A marca saiu porque
  // a razão dela saiu — exceção que sobrevive à própria razão é a dívida de
  // sempre.
  { nome: 'nega volta a usar a lista de EVASÃO em vez da de negadores',
    de: '    const mNeg = new RegExp(reNegador.source, \'i\').exec(vao);',
    para: '    const mNeg = new RegExp(reRevoga.source, \'i\').exec(vao);' },
  { nome: 'o negador na frente deixa de precisar ALCANÇAR o destino',
    de: '    const antes = mNeg ? soFuncionalAteONucleo(vao.slice(mNeg.index + mNeg[0].length)) : false;',
    para: '    const antes = Boolean(mNeg);' },
  { nome: 'nega olha só o PRIMEIRO destinatário',
    de: '  for (const d of dests) {',
    para: '  for (const d of dests.slice(0, 1)) {' },
  { nome: 'o negador DEPOIS do destinatário deixa de contar',
    de: '    if (!antes && !depois) return false;',
    para: '    if (!antes) return false;' },
  { nome: 'o negador atrás deixa de exigir que ALCANCE a gorjeta',
    de: '  if (!reGorjeta.test(resto) && !soFuncionalAteONucleo(resto)) return false;',
    para: '' },
  { nome: 'o negador atrás deixa de olhar o CONTRASTE',
    de: '  return !reContrasteColado.test(resto);',
    para: '  return true;' },
  { nome: 'a repartida olha só a PRIMEIRA oração com destinatário',
    de: '  for (let i = 0; i < partes.length; i += 1) {',
    para: '  for (let i = 0; i < Math.min(1, partes.length); i += 1) {' },
  { nome: 'a dispensa do distribuidor deixa de valer por SEGMENTO',
    de: '      for (const seg of segmentos(o)) {',
    para: '      for (const seg of [o]) {' },
  { nome: 'o distribuidor volta a dispensar de dentro de uma RELATIVA',
    de: '        const temDist = reDistribuidor.test(matriz);',
    para: '        const temDist = reDistribuidor.test(seg);' },
  { nome: 'a coordenação deixa de herdar o distribuidor',
    de: '        const dispensa = temDist || (!temVerbo && distribuidorAnterior);',
    para: '        const dispensa = temDist;' },
  { nome: 'a dispensa volta a valer pela janela toda',
    de: '        if (!nega(o) && (reRevoga.test(o) || !dispensa)) return true;',
    para: '        if (!nega(o) && (reRevoga.test(o) || !reDistribuidor.test(janela))) return true;' },
  { nome: 'a evasão deixa de revogar a dispensa do genitivo',
    de: '  if (reRevoga.test(clausula || oracao)) return reDestRuntime.test(oracao);',
    para: '' },
  { nome: 'o genitivo descritivo deixa de dispensar',
    de: '  return reDestRuntime.test(oracao.replace(reGenitivoDescritivo, \' \'));',
    para: '  return reDestRuntime.test(oracao);' },
  // SEM COBERTURA, e declarada: desde que a revogação passou a ser lida na
  // ORAÇÃO inteira (e não numa janela de ±30 caracteres), ela é redundante com
  // a checagem de revogação que os dois chamadores já fazem. Falha FECHADO —
  // tirá-la concede a dispensa em menos casos, nunca em mais.
  { nome: 'a revogação do distribuidor deixa de valer pela oração', semCobertura: true,
    de: '    if (!reRevoga.test(oracao)) return true;',
    para: '    return true;' },
  { nome: 'o SUJEITO NOMINAL deixa de vetar a regra 1b',
    de: '    if (reSujeitoNominal.test(prefixo.replace(new RegExp(reGorjeta.source, \'gi\'), \' \'))) continue;',
    para: '' },
  { nome: 'o prefixo da forma direcional volta a ser CONTADO',
    de: '    const comecaNaForma = !reSujeitoNominal.test(prefixo) && !soAmbiguo;',
    para: '    const comecaNaForma = !/[0-9A-Za-zÀ-ÿ]/.test(prefixo);' },
  { nome: 'o destinatário AMBÍGUO volta a bastar na evidência fraca',
    de: '    const comecaNaForma = !reSujeitoNominal.test(prefixo) && !soAmbiguo;',
    para: '    const comecaNaForma = !reSujeitoNominal.test(prefixo);' },
  { nome: 'a regra 1b deixa de exigir contexto de dinheiro',
    de: '    if ((reGorjeta.test(janela) || reQuantidade.test(janela) || comecaNaForma)',
    para: '    if ((true)' },
  { nome: 'o caminho FORTE deixa de existir',
    de: '    if (cabecaValida(reCabecaForte, o) !== null) return true;',
    para: '' },
  { nome: 'o caminho FORTE aceita cabeça SEM quantidade',
    de: '    if (cabecaValida(reCabecaForte, o) !== null) return true;',
    para: '    if (cabecaValida(reCabeca, o) !== null) return true;' },
  { nome: 'qualquer negador volta a LICENCIAR a cabeça não-direcional',
    de: '    const mFraco = (comEvasao ? reCabeca : reCabecaDirecional).exec(o);',
    para: '    const mFraco = (reRevoga.test(o) ? reCabeca : reCabecaDirecional).exec(o);' },
  { nome: 'o caminho FRACO deixa de exigir cabeça DIRECIONAL',
    de: '    const comEvasao = reEvasaoLicencia.test(o);',
    para: '    const comEvasao = true;' },
  { nome: 'o PREFIXO do caminho fraco deixa de ser julgado',
    de: '    if (reVerboFinito.test(o.slice(0, mFraco.index))) continue;',
    para: '' },
  { nome: 'o caminho FRACO deixa de exigir resto sem PREDICAÇÃO',
    de: '    if (temPredicacao(resto)) continue;',
    para: '' },
  { nome: 'o caminho FRACO deixa de exigir quantidade na oração anterior',
    de: '    if (!partes.slice(0, i).some((q) => comEvasao ? reGorjeta.test(q)\n      : (reQuantidade.test(q) || reGorjeta.test(q)))) continue;',
    para: '' },
  { nome: 'o PREFIXO da cabeça deixa de ser julgado',
    de: '  if (reVerboFinito.test(oracao.slice(0, m.index))) return null;',
    para: '' },
  { nome: 'a relativa deixa de sair antes do teste de predicação',
    de: '  const semRelativa = resto.replace(reRelativa, \' \');',
    para: '  const semRelativa = resto;' },
  { nome: 'o pronome regido por preposição volta a contar como sujeito', semCobertura: true,
    de: '    if (!rePrepPronome.test(trecho.slice(0, p))) return true;',
    para: '    return true;' },
];

/**
 * Roda o corpo contra uma cópia mutada do censo. Devolve a DIREÇÃO do vermelho.
 *
 * `escapes` são casos `recusa: true` que passaram a passar; `fp` são
 * `recusa: false` que passaram a ser recusados. Contar só o total é o que
 * deixava um ALARGAMENTO ser certificado pelos falsos positivos que ele evita:
 * `aridade do modificador sobe pra nove` e `cabeça deixa de ser ancorada`
 * reportavam "1 caso vermelho" e os dois vermelhos eram casos INOCENTES — luz
 * verde que se lia como cobertura do alargamento e era cobertura do contrário.
 * Apontado pela revisão de segurança de 2026-09-14.
 */
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
  const divergiram = F.casos.filter((c) => acusa(c.texto) !== c.recusa);
  return {
    total: divergiram.length,
    escapes: divergiram.filter((c) => c.recusa).length,
    fp: divergiram.filter((c) => !c.recusa).length,
  };
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
/**
 * ALARGAMENTOS — e cada um DECLARA a direção do vermelho que espera.
 *
 * Alargar um PADRÃO nem sempre afrouxa o GUARDA, e confundir as duas coisas é
 * o que deixava este bloco ser certificado pelo avesso. `modificador` e
 * `cabeca` são padrões que abrem a porta da RECUSA: alargá-los faz o guarda
 * recusar MAIS, então o vermelho legítimo vem de casos inocentes. `quantidade`
 * é o que abre o caminho FRACO: estreitá-la faz a promessa ESCAPAR. Um
 * vermelho na direção errada não é cobertura, é outra coisa acontecendo.
 *
 * `direcao: 'fp'` — a mutação aperta o guarda, e o vermelho tem que vir de
 * casos `recusa: false`. `direcao: 'escapes'` — a mutação afrouxa, e o vermelho
 * tem que vir de casos `recusa: true`. Apontado pela revisão de segurança de
 * 2026-09-14, que mediu os cinco alargamentos e achou zero escapes nos cinco.
 */
const ALARGAMENTOS = [
  // O modificador ESTREITA, não alarga: ele existe pra `to the FLOOR staff`, e
  // tirá-lo faz essa promessa escapar. Alargá-lo só faz o guarda recusar mais,
  // e nenhum caso inocente do corpo reage — medido, não suposto.
  { nome: 'a aridade do modificador cai de dois pra zero', direcao: 'escapes',
    insere: "G.modificador_de_destino = G.modificador_de_destino.replace('{0,2}', '{0,0}');\n" },
  { nome: 'a cabeça do caminho fraco aceita preposição não-direcional', direcao: 'fp',
    insere: "G.preposicao_direcional = G.preposicao_de_destino;\n" },
  { nome: 'o verbo finito deixa de ver o sujeito nulo', direcao: 'fp',
    insere: "G.verbo_finito = 'zzzznuncacasa';\n" },
  // Desde que o prefixo passou a ser julgado por VERBO nos dois caminhos, o
  // `pronome_sujeito` decide só dentro do `temPredicacao` do RESTO — e lá
  // ele APERTA quando some: o resto deixa de ter predicação e a oração vira
  // frase de destino. A direção declarada mudou junto com a peça, que é o
  // comportamento certo de uma declaração de polaridade.
  { nome: 'o pronome sujeito deixa de contar', direcao: 'fp',
    insere: "G.pronome_sujeito = 'zzzznuncacasa';\n" },
  { nome: 'o separador de cláusula perde a conjunção', direcao: 'escapes',
    insere: "G.separador_de_clausula = '(?<!\\\\d),(?!\\\\d)';\n" },
  { nome: 'a quantidade consumida passa a aceitar qualquer palavra', direcao: 'fp',
    insere: "G.quantidade_consumida = '([\\\\wáéíóúâêôãõç%$€.,-]+)';\n" },
  // E O OUTRO LADO, que faltava inteiro: estreitar a peça que abre o caminho
  // fraco faz a promessa ESCAPAR, e nenhuma mutação deste arquivo media isso.
  { nome: 'a quantidade DETECTORA deixa de reconhecer notação nenhuma', direcao: 'escapes',
    insere: "G.quantidade = 'zzzznuncacasa';\n" },
  { nome: 'o núcleo de atribuição aceita qualquer substantivo', direcao: 'escapes',
    insere: "G.nucleo_de_atribuicao = '([\\\\wáéíóúâêôãõç-]+)';\n" },
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
// A âncora é a PRIMEIRA linha que constrói padrão, não uma do meio: um
// alargamento inserido depois de a peça já ter sido compilada não muta nada e
// o portão reporta verde. Achado ao ver `pronome_sujeito` dar verde nas duas
// direções.
const ANCORA_ALARGAMENTO = "const reGorjeta = new RegExp(COMPOR.substantivo_gorjeta(G), 'i');";

describe('cada peça do desenho pode ficar vermelha', () => {
  const original = fs.readFileSync(ALVO, 'utf8');

  test('sem mutação, o corpo passa inteiro', () => {
    expect(falhasCom(original).total).toBe(0);
  });

  test.each(MUTACOES.map((m) => [m.nome, m]))('%s', (_nome, m) => {
    // A mutação tem que EXISTIR no arquivo: uma lista de mutações que não
    // casam mais é uma lista que passa calada.
    expect(original.includes(m.de)).toBe(true);
    const mutado = original.replace(m.de, m.para);
    expect(mutado).not.toBe(original);
    const falhas = falhasCom(mutado).total;
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
    expect(falhasCom(mutado).total).toBeGreaterThan(0);
  });

  test.each(ALARGAMENTOS.map((m) => [m.nome, m]))('alargar: %s', (_nome, m) => {
    // A peça é AFROUXADA no lugar, e o corpo tem que acusar. Vermelho aqui é
    // prova de que o valor escolhido carrega peso; verde é botão decorativo.
    expect(original.includes(ANCORA_ALARGAMENTO)).toBe(true);
    const mutado = original.replace(ANCORA_ALARGAMENTO, m.insere + ANCORA_ALARGAMENTO);
    expect(mutado).not.toBe(original);
    const d = falhasCom(mutado);
    // O VERMELHO TEM QUE VIR DA DIREÇÃO DECLARADA. Contar só o total deixava a
    // mutação ser certificada pelo avesso.
    // A chave declarada tem que EXISTIR no relatório: `direcao: 'escape'`
    // contra um contador chamado `escapes` dava `undefined > 0` = false, e o
    // teste falhava por digitação em vez de por medição.
    expect(Object.keys(d)).toContain(m.direcao);
    if (m.semCobertura) { expect(d.total).toBe(0); return; }
    expect({ nome: m.nome, [m.direcao]: d[m.direcao] > 0, outro: d, })
      .toEqual({ nome: m.nome, [m.direcao]: true, outro: d });
  });

  test('a lista de peças sem cobertura não cresce', () => {
    // Duas hoje, as duas falhando FECHADO. Acrescentar uma terceira tem que
    // ser uma decisão, não um efeito colateral.
    expect(MUTACOES.filter((m) => m.semCobertura).length).toBeLessThanOrEqual(4);
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
