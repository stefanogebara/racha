'use strict';

/**
 * O CENSO DE TOKENS.
 *
 * As duas revisões de 2026-09-14 chegaram à mesma conclusão pelo mesmo
 * caminho: o portão de mutação mede a imaginação do autor duas vezes. Ele
 * apaga as peças que alguém LISTOU e alarga os limites que alguém LEMBROU, e
 * o corpo que julga o resultado foi escrito pela mesma mão, no mesmo commit
 * que a regra. Medido de fora, o estrago: 19 de 27 alternativas da regência,
 * 12 de 19 preposições, 11 de 14 tokens da relativa, 5 de 10 da quantidade e
 * 5 de 8 negadores colados não seguravam nada. Metade de uma tradução, três
 * alternativas de moeda mutuamente redundantes, e um `time` inalcançável que
 * fazia um caso do corpo passar por acidente.
 *
 * Então a disciplina das DISPENSAS — cada perdão nomeia a linha que perdoa e
 * é usado exatamente uma vez — passa a valer também pros tokens dos padrões:
 * toda alternativa de toda alternância ou é CARREGADA (apagá-la deixa o corpo
 * vermelho) ou é DECLARADA MORTA com motivo. Não há terceira gaveta.
 *
 * O QUE ISTO NÃO MEDE, dito pra não virar confiança falsa:
 *
 *  · roda só o censo JS — e a justificativa que estava escrita aqui ("os dois
 *    guardas leem os MESMOS tokens do `claims.json`, então token morto é morto
 *    nos dois") é FALSA, e era falsa desde que o
 *    `substantivo_destinatario_runtime` nasceu. As duas listas de destinatário
 *    são diferentes de propósito: `pra gente` na boca de um garçom é a equipe,
 *    na boca do assistente são os CLIENTES. Um token morto na lista longa pode
 *    estar vivo na curta e vice-versa. Além disso o Swift tem peças COMPOSTAS
 *    nele (`destinoEmQualquerLugar`, `ateOSeparador`, as âncoras do `nega`) que
 *    só o `mutar-guarda-swift.sh` alcança. Apontado pela revisão de compliance
 *    de 2026-09-14; a lista longa ganhou sonda própria na mesma rodada;
 *  · mede alternativa, não INTERAÇÃO: duas alternativas redundantes entre si
 *    aparecem as duas como carregadas se cada uma tem seu caso, e as três de
 *    moeda estavam justamente assim.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const G = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;
const F = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'afirmacoes.fixture.json'), 'utf8'));
const FONTE = fs.readFileSync(path.join(__dirname, 'claims.test.js'), 'utf8');

/**
 * TODAS as alternativas de TODAS as alternâncias — inclusive as aninhadas.
 *
 * A primeira versão varria só o nível de topo, e com isso dava `✓` calado em
 * `verbo_finito`, `pronome_sujeito`, `negadores`, `negador_colado` e
 * `marcador_de_lista`: todos eles embrulham a alternância num grupo
 * (`(?:^|[^…])(a|b|c)(?=…)`), então o topo tem UMA alternativa e o teste
 * passava sem varrer nada. Um instrumento que não podia ver a lista que existe
 * pra medir — a mesma forma do guarda que nunca dispara, no arquivo escrito
 * pra achá-la.
 *
 * Fatiar por `split('|')` produziria lixo (`(a|b)c` vira `(a` e `b)c`), que é
 * o erro que o `_porque_so_deteccao` já nomeia.
 */
function todasAsAlternativas(re) {
  const grupos = [], pilha = [];
  let classe = false;
  for (let i = 0; i < re.length; i += 1) {
    const c = re[i];
    if (c === '\\') { i += 1; continue; }
    if (classe) { if (c === ']') classe = false; continue; }
    if (c === '[') { classe = true; continue; }
    if (c === '(') { pilha.push(i); continue; }
    if (c === ')' && pilha.length) { grupos.push([pilha.pop() + 1, i]); }
  }
  // O próprio padrão inteiro também é um recipiente de alternância.
  grupos.push([0, re.length]);
  // E CLASSE DE CARACTERES É ALTERNÂNCIA COM OUTRA SINTAXE. Sem isto, o
  // `marcador_de_lista` (`[-*•+>]`) dava ✓ sem varrer nada — e dois dos seus
  // cinco membros eram buracos de um caractere achados por uma revisão.
  const classes = [];
  classe = false;
  let iniClasse = 0;
  for (let i = 0; i < re.length; i += 1) {
    const c = re[i];
    if (c === '\\') { i += 1; continue; }
    if (!classe && c === '[') { classe = true; iniClasse = i + 1 + (re[i + 1] === '^' ? 1 : 0); continue; }
    if (classe && c === ']' && i > iniClasse) { classes.push([iniClasse, i]); classe = false; }
  }
  const spans = new Map();
  for (const [de, ate] of grupos) {
    const barras = [];
    let nivel = 0; classe = false;
    for (let i = de; i < ate; i += 1) {
      const c = re[i];
      if (c === '\\') { i += 1; continue; }
      if (classe) { if (c === ']') classe = false; continue; }
      if (c === '[') { classe = true; continue; }
      if (c === '(') { nivel += 1; continue; }
      if (c === ')') { nivel -= 1; continue; }
      if (c === '|' && nivel === 0) barras.push(i);
    }
    if (!barras.length) continue;
    let ini = de;
    for (const b of [...barras, ate]) {
      spans.set(`${ini}:${b}`, [ini, b]);
      ini = b + 1;
    }
  }
  // Membros de classe: um caractere cada, menos os intervalos (`a-z`), que
  // são um só token.
  //
  // CLASSE DE LETRAS NÃO É ENUMERAÇÃO DE DECISÕES. `[\\wáéíóúâêôãõç-]` é UMA
  // decisão ("uma palavra") escrita com vinte e três caracteres, e varrer o
  // `õ` dela produz vinte e três perdões que não dizem nada — ruído que
  // afogaria os tokens de verdade e empurraria pro perdão em massa, que é a
  // saída preguiçosa que este arquivo existe pra fechar. Classe que já contém
  // `\\w` ou um intervalo de letras é pulada; `[-*•+>]` e `[\\s*_\`~]`, que são
  // enumerações de símbolos e cada um uma decisão, continuam varridos.
  for (const [de, ate] of classes) {
    const corpoClasse = re.slice(de, ate);
    if (/\\w|a-z|A-Z|À-ÿ|0-9/.test(corpoClasse)) continue;
    // E CLASSE SÓ DE LETRAS É UMA VARIANTE DE GRAFIA OU DE GÊNERO, não uma
    // enumeração de decisões: `d[oae]s?` é UMA preposição escrita com um
    // colchete, `m[ãa]o` é uma palavra com e sem acento. Varrer o `e` de
    // `[oae]` produz um perdão que não diz nada — o mesmo ruído do `\\w`, com
    // outra sintaxe. `[-*•+>]` e `[\\s*_\`~]`, que enumeram SÍMBOLOS e cada um é
    // uma decisão, continuam varridos.
    if (/^[A-Za-zÀ-ÿ]+$/.test(corpoClasse)) continue;
    for (let i = de; i < ate; i += 1) {
      if (re[i] === '\\') { spans.set(`${i}:${i + 2}`, [i, i + 2]); i += 1; continue; }
      if (re[i + 1] === '-' && i + 2 < ate) { spans.set(`${i}:${i + 3}`, [i, i + 3]); i += 2; continue; }
      spans.set(`${i}:${i + 1}`, [i, i + 1]);
    }
  }
  // OPCIONALIDADE E REPETIÇÃO TAMBÉM SÃO DECISÕES. `(MARCADOR)?`,
  // `((QUANT_C)\\s+MOD)?`, `{0,2}`, `^` — nenhuma delas tem `|`, e por isso as
  // DUAS CABEÇAS, que são as peças em que toda esta rodada se apoia, recebiam
  // um ✓ calado sobre zero tokens. Mesma forma do defeito que este arquivo
  // corrigiu pra alternância aninhada, deixado de pé pra alternância escrita
  // com outra sintaxe. Achado pela revisão de segurança de 2026-09-14.
  let g = 0, classe2 = false;
  for (let i = 0; i < re.length; i += 1) {
    const c = re[i];
    if (c === '\\') { i += 1; continue; }
    if (classe2) { if (c === ']') classe2 = false; continue; }
    if (c === '[') { classe2 = true; continue; }
    if (c === '(') { g += 1; continue; }
    if (c === ')') {
      g -= 1;
      // `(...)?` — apagar o `?` torna o grupo OBRIGATÓRIO, que é a decisão.
      if (re[i + 1] === '?') spans.set(`${i + 1}:${i + 2}`, [i + 1, i + 2]);
      continue;
    }
    if (c === '^' && g === 0 && i === 0) spans.set('0:1', [0, 1]);
    const rep = /^\{\d+,\d+\}/.exec(re.slice(i));
    if (rep) { spans.set(`${i}:${i + rep[0].length}`, [i, i + rep[0].length]); i += rep[0].length - 1; }
  }
  return [...spans.values()];
}

/** Carrega o censo de `claims.test.js` com um `claims.json` qualquer. */
function censoCom(mutado) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  fs.writeFileSync(path.join(tmp, 'claims.json'), JSON.stringify({ gorjeta_destino: mutado }));
  const corpo = FONTE.slice(0, FONTE.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/")
    // O JSON vem do temporário; todo o resto continua vindo da raiz de verdade.
    .replace(/path\.join\(RAIZ, 'docs', 'compliance', 'claims\.json'\)/g, JSON.stringify(path.join(tmp, 'claims.json')));
  const arq = path.join(tmp, 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  try {
    const m = require(arq);
    delete require.cache[arq];
    return m;
  } catch { return null; }   // padrão inválido
}

/** Roda o corpo com `claims.json` mutado. Devolve quantos casos divergem. */
function falhasCom(mutado) {
  const m = censoCom(mutado);
  if (!m) return null;
  return F.casos.filter((c) => m.acusa(c.texto) !== c.recusa).length;
}

const MORTAS = G._alternativas_mortas || {};
// Alcance e peso são perguntas diferentes, então os perdões também são: um
// token pode ser ALCANÇÁVEL e não ter caso próprio no corpo, ou ter caso e não
// ser sondável. Uma gaveta só borraria as duas.
const SEM_SONDA = G._tokens_sem_sonda || {};
// Campos que NÃO entram na varredura estrutural, cada um com motivo escrito.
// Todos são listas de vocabulário ou de gatilho, de dezenas de tokens, em que
// exigir caso de corpo por token produziria ou teatro ou perdão em massa — as
// duas saídas preguiçosas. A lista não pode crescer em silêncio.
const FORA = G._campos_fora_do_censo_de_tokens || {};
const CAMPOS = Object.keys(G).filter(
  (k) => !k.startsWith('_') && typeof G[k] === 'string'
    && !['guarda', 'porque', 'frase_sancionada'].includes(k));

/**
 * DUAS COISAS DIFERENTES ESTÃO SENDO MEDIDAS, e misturá-las produz ou 200
 * casos de corpo escritos à mão ou 200 perdões escritos à mão — as duas
 * saídas preguiçosas.
 *
 * · PADRÃO ESTRUTURAL (a cabeça, o corte, a contrastiva, o marcador): poucas
 *   alternativas, cada uma uma DECISÃO. Varre-se apagando: ou o corpo fica
 *   vermelho, ou o token é declarado morto com motivo.
 * · LISTA DE VOCABULÁRIO (substantivos de gorjeta, destinatários, verbos,
 *   pronomes): dezenas de tokens, cada um uma PALAVRA. Exigir caso de corpo
 *   por palavra é teatro. O que importa nelas é ALCANCE — e é exatamente onde
 *   o defeito real apareceu: `time` estava escrito `[oad]o?s? time\b`, com o
 *   artigo embutido, e era inalcançável em toda a classe sem verbo. Um caso do
 *   corpo passava por causa disso, e lia-se como cobertura.
 *
 * Então a lista de vocabulário é SONDADA: pra cada token, monta-se a frase
 * canônica que ele deveria disparar e exige-se o veredito. Token novo entra
 * coberto sem ninguém lembrar; token inalcançável falha alto.
 */
// AS SONDAS TÊM QUE RODAR NO RAMO EM QUE A PEÇA DECIDE, e isso as faz mudar
// quando o código muda — o que é o comportamento certo e já aconteceu duas
// vezes. Primeiro elas rodavam no caminho FRACO, onde o resto não-vazio já
// bastava e o verbo nunca era consultado. Depois, no ramo da quantidade
// CONSUMIDA — que deixou de perguntar por predicação quando a revisão mostrou
// que, pelo CDC art. 30, `- 100% pro garçom` já vincula. Hoje rodam no ramo do
// MARCADOR SEM QUANTIDADE, que é o único em que `verbo_finito` e
// `pronome_sujeito` mudam veredito. Sonda que não muda quando o ramo muda é
// sonda que parou de medir. A primeira versão montava
// `Tirei os 10%.\nCom o garçom <verbo> tudo certo.`, que cai no caminho FRACO —
// e lá o resto não-vazio já basta pra deixar passar, com verbo ou sem. A sonda
// dava verde sobre uma peça que ela nunca consultava: vacuidade no instrumento
// escrito pra achar vacuidade. Achado rodando o portão de mutação contra ela.
const VOCABULARIO = {
  substantivo_gorjeta: (ex) => [`${ex}: 10%\n- 100% pro garçom`, true],
  substantivo_destinatario_runtime: (ex) => [`Sobre a gorjeta\n- 100% pra ${ex}`, true],
  verbo_finito: (ex) => [`Sobre a gorjeta\n- com a equipe ${ex} tudo certo`, false],
  pronome_sujeito: (ex) => [`Sobre a gorjeta\n- com a equipe ${ex} paga na saída`, false],
  preposicao_de_destino: (ex) => [`Sobre a gorjeta\n- 100% ${ex} equipe`, true],
  artigo_de_destino: (ex) => [`Sobre a gorjeta\n- 100% pra ${ex} equipe`, true],
  marcador_de_lista: (ex) => [`Sobre a gorjeta\n${ex} 100% pro garçom`, true],
  quantidade_consumida: (ex) => [`Sobre a gorjeta\n- ${ex} pro garçom`, true],
  genitivo_de_destino_simples: (ex) => [`A gorjeta é ${ex} equipe.`, true],
  negador_colado: (ex) => [`Com o garçom ${ex} tem gorjeta nenhuma.`, false],
  negadores: (ex) => [`A gorjeta ${ex} fica com o garçom.`, false],
  preposicao_antes_de_pronome: (ex) => [`Serviço: 10%\n- 100% pra equipe que cuidou ${ex} você`, true],
  nucleo_de_atribuicao: (ex) => [`${ex} da equipe sai por folha, como manda a lei.`, false],
  relativo_pronome: (ex) => [`Serviço: 10%\n- 100% pra equipe ${ex} cuidou de você`, true],
  relativo_clitico: (ex) => [`Serviço: 10%\n- 100% pra equipe que ${ex} atendeu hoje`, true],
  quantidade: (ex) => [`Gorjeta: ${ex}\npro garçom`, true],
  preposicao_direcional: (ex) => [`Gorjeta: 10%\n${ex} equipe`, true],
  // DOIS QUADROS, e os DOIS têm que valer. A sonda antiga montava só o quadro
  // ALATIVO (`Vai pra …`) porque foi escrita a partir do achado que criou a
  // peça — e por isso não via que `Fica com o salão.` e `É da copa.` escapavam
  // com os mesmos três tokens. Um cômodo é destino de MOVIMENTO e não é dono
  // de dinheiro: a ambiguidade está na RELAÇÃO. Ver `_porque_ambiguo`.
  destinatario_ambiguo: (ex) => [[`Vai pra ${ex}, já avisei.`, false],
    [`Fica com ${ex}.`, true]],
  // A LISTA LONGA — a que só o CENSO usa — ganhou sonda própria. O charter
  // dizia que os dois guardas leem os mesmos tokens, e isso é falso desde que
  // o `substantivo_destinatario_runtime` nasceu: `pra gente` na boca de um
  // garçom é a equipe, na boca do assistente é o cliente. Os tokens de
  // primeira e segunda pessoa vêm do `destinatarios_so_deteccao` e são
  // pulados por DERIVAÇÃO, não por lista escrita à mão.
  // E o token que TRAZ a própria regência (`pro pessoal`, `pra gente`) não
  // leva outra por cima: a moldura que acrescenta `pra` a um token que já tem
  // preposição mede uma frase que ninguém escreve.
  substantivo_destinatario: (ex) => [
    /^(pra|pro|para|com|to|ao|al)\b/.test(ex)
      ? `Sobre a gorjeta\n- 100% ${ex}` : `Sobre a gorjeta\n- 100% pra ${ex}`, true],
  // A lista de determinantes SAIU do `sujeito_nominal` — ela estava escrita
  // duas vezes lá dentro e uma terceira cópia ia nascer na `anafora_de_dinheiro`.
  // Virou peça com nome, e a sonda foi junto: é a mesma frase, medindo a mesma
  // decisão, no campo que agora tem a lista.
  determinante: (ex) => [`Sua parte é R$ 61,00. ${ex} comanda vai pro garçom.`, false],
  // O sujeito que o veto da regra 1b existe pra proteger. A sonda prova
  // ALCANCE com a polaridade certa: dentro de janela de dinheiro, só um
  // substantivo NOMEADO aqui desarma a regra. Palavra que sumir desta lista
  // passa a produzir RECUSA, nunca escape — que é a direção que este arquivo
  // exige de toda enumeração.
  substantivo_nao_dinheiro: (ex) => [`Sua parte é R$ 61,00. A ${ex} vai pro garçom.`, false],
  separador_interno: (ex) => [`Sobre a gorjeta\n- 100% pra equipe ${ex} você não paga nada a mais`, true],
  enfase_markdown: (ex) => [`Sobre a gorjeta\n${ex}100% pro garçom${ex}`, true],
};

/**
 * A LISTA de um padrão de vocabulário: a alternância com MAIS ramos.
 *
 * Não é o nível de topo — `verbo_finito` e `pronome_sujeito` embrulham a lista
 * em `(?:^|[^…])(…)(?=…)`, então o topo tem um ramo só. E não é toda
 * alternância — `servi(ç|c|ci)o` tem uma alternância de GRAFIA dentro de uma
 * palavra, e grafia não é vocabulário: ela é varrida pelo censo estrutural, em
 * que o critério é carregar peso, não ter frase própria.
 */
function listaDominante(re) {
  const porContainer = new Map();
  for (const [a, b] of todasAsAlternativas(re)) {
    // Alternativas do mesmo container compartilham o ponto de corte anterior;
    // agrupa por onde a alternância começa.
    const chave = [...porContainer.keys()].find((k) => {
      const ult = porContainer.get(k);
      return ult.some(([, fim]) => fim + 1 === a) || ult.some(([ini]) => b + 1 === ini);
    });
    if (chave === undefined) porContainer.set(a, [[a, b]]);
    else porContainer.get(chave).push([a, b]);
  }
  let melhor = [];
  for (const v of porContainer.values()) if (v.length > melhor.length) melhor = v;
  return melhor.map(([a, b]) => re.slice(a, b));
}

/**
 * Um EXEMPLAR de texto para um token de regex: primeira alternativa de cada
 * classe, grupo opcional descartado, âncoras removidas. Não é um de-regex
 * geral — é o bastante pras listas de vocabulário deste arquivo, e quando não
 * é, o teste falha em vez de passar calado.
 */
function exemplar(token) {
  let t = token;
  // NOTAÇÃO DE NÚMERO é fabricável, e precisa ser: a `quantidade` é uma lista
  // de NOTAÇÕES, e as três de moeda são justamente as que o fabricador
  // genérico recusava — as mesmas que, mortas, produziram
  // `Gorjeta: R$ 12,00 — pra equipe.` na rodada anterior.
  t = t.replace(/\\d\+\[\.,\]\\d\{2\}/g, '12,00')
    .replace(/\\d\+\\s\*%/g, '10%')
    .replace(/\\d\+/g, '12')
    .replace(/\\\$/g, '\u0001')   // cifrão LITERAL, marcado
    .replace(/\\s[*+]/g, ' ')
    .replace(/\\d/g, '2');
  if (/[+*{}]|\\[dwsWSD]|\.|\(\?[=!<]/.test(t)) return null;   // não sei fabricar: falha alto
  t = t.replace(/\((?:\?:)?([^()|]*)\|[^()]*\)/g, '$1');        // (a|b) → a
  t = t.replace(/\((?:\?:)?([^()]*)\)\?/g, '');                 // (x)? → ''
  t = t.replace(/\((?:\?:)?([^()]*)\)/g, '$1');
  t = t.replace(/\[\^[^\]]*\]/g, 'x');
  t = t.replace(/\[([^\]])[^\]]*\]/g, '$1');                    // [oa] → o
  t = t.replace(/(.)\?/g, '');                                  // s? → ''
  // O `$` LITERAL da moeda é marcado antes e devolvido depois: a limpeza de
  // âncoras (`^`, `$`) comia o cifrão de `R$ 2` e a sonda passava a medir
  // `R 2`, que não é notação nenhuma. A peça que a sonda existe pra provar era
  // a única que ela não conseguia escrever.
  t = t.replace(/\\b|\^|\$/g, '').replace(/\\(.)/g, '$1').replace(/\u0001/g, '$').trim();
  return /^[\wáéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ %,.$€-]+$/.test(t) && t ? t : null;
}

describe('toda palavra das listas de vocabulário é ALCANÇÁVEL', () => {
  test.each(Object.keys(VOCABULARIO))('%s', (campo) => {
    const { acusa } = censoCom(G);
    const alts = listaDominante(G[campo]);
    // Se o varredor deixar de achar a lista, ele falha ALTO em vez de dar ✓
    // sobre zero tokens — que foi o primeiro defeito deste arquivo.
    expect({ campo, tokens: alts.length })
      .toEqual({ campo, tokens: expect.any(Number) });
    expect(alts.length).toBeGreaterThanOrEqual(2);
    const mudas = [];
    for (const token of alts) {
      const ex = exemplar(token);
      if (ex === null) continue;                 // não é palavra (classe, âncora)
      // SÓ-DETECÇÃO: os tokens de primeira e segunda pessoa do
      // `substantivo_destinatario` querem dizer os CLIENTES quando é o
      // assistente que fala, e por isso não estão na lista de runtime nem
      // disparam a frase canônica. A exclusão é DERIVADA do
      // `destinatarios_so_deteccao`, não escrita à mão aqui.
      if (campo === 'substantivo_destinatario'
        && (G.destinatarios_so_deteccao || []).some((d) => ex.includes(d))) continue;
      const r = VOCABULARIO[campo](ex);
      // Um quadro ou VÁRIOS, e quando são vários os DOIS têm que valer: uma
      // peça que decide por relação precisa da relação certa E da errada.
      const quadros = Array.isArray(r[0]) ? r : [r];
      for (const [texto, esperado] of quadros) {
        // A falha mostra a FRASE, não só o token: token sozinho não diz se
        // quem errou foi o padrão ou a sonda.
        if (acusa(texto) !== esperado) mudas.push(`${token}  →  ${JSON.stringify(texto)}`);
      }
    }
    const naoDeclaradas = mudas.filter((m) => !(SEM_SONDA[campo] || {})[m.split('  →  ')[0]]);
    expect({ campo, naoDeclaradas }).toEqual({ campo, naoDeclaradas: [] });
    // Declaração que envelheceu: token que voltou a ser sondável sai da lista.
    const sondaveis = Object.keys(SEM_SONDA[campo] || {})
      .filter((t) => !mudas.some((m) => m.split('  →  ')[0] === t));
    expect({ campo, sondaveis }).toEqual({ campo, sondaveis: [] });
    for (const [t, porque] of Object.entries(SEM_SONDA[campo] || {})) {
      expect(`${campo}/${t}: ${porque}`).toMatch(/.{40,}/);
    }
  });
});

/**
 * TODA ALTERNATIVA É ALCANÇÁVEL COMO *A* CASADA — o teste de SOMBRA.
 *
 * As duas medições que já existiam não veem esta: o peso mede se apagar a
 * alternativa muda veredito, e a sonda mede se o token dispara a frase
 * canônica. Nenhuma das duas percebe que uma alternativa nunca é A QUE CASA
 * porque outra, mais curta e ANTES dela na mesma alternância, sempre casa
 * primeiro. `de\s+la` vive à sombra de `de`; `para\s+el` à de `para`;
 * `a\s+gente` à de `a`. Três alternativas do `palavra_funcional` estavam
 * mortas desde que foram escritas, e o arquivo as anunciava como vivas — que é
 * a forma "peça que nunca dispara" aplicada a uma alternância.
 * Apontado pela revisão de segurança de 2026-09-14, que as mediu uma a uma.
 *
 * O teste: monta o exemplar da alternativa, roda a alternância INTEIRA sobre
 * ele, e exige que o casamento seja o exemplar todo. Se vier mais curto,
 * alguém antes comeu o começo.
 */
describe('nenhuma alternativa vive à SOMBRA de outra', () => {
  const SOMBRAS = G._alternativas_na_sombra || {};
  // TODOS OS CAMPOS, inclusive os do `_campos_fora_do_censo_de_tokens`: a
  // isenção deles é da pergunta do PESO ("exigir caso de corpo por palavra é
  // teatro"), e sombra é outra pergunta. `palavra_funcional` está lá, e é
  // justamente onde as três alternativas mortas moravam.
  test.each(CAMPOS)('%s', (campo) => {
    const re = G[campo];
    const alvo = listaDominante(re);
    if (alvo.length < 2) return;
    // SÓ a alternância, ANCORADA: o que se mede é qual ramo vence no mesmo
    // ponto de partida, não o padrão inteiro com os delimitadores dele.
    // Um ramo que não compila SOZINHO é recorte do varredor (`?`, `{0,2}`),
    // não alternativa da regra: ele sai da alternância em vez de rebentá-la.
    const compila = (t) => { try { new RegExp(t); return true; } catch { return false; } };
    const ramos = alvo.filter(compila);
    if (ramos.length < 2) return;
    const alternancia = new RegExp(`^(?:${ramos.join('|')})`, 'i');
    const sombreadas = [];
    for (const token of alvo) {
      const ex = exemplar(token);
      // Só as de MAIS DE UMA palavra podem ser comidas por uma mais curta.
      if (ex === null || !/\s/.test(ex)) continue;
      const m = alternancia.exec(ex);
      if (!m || m[0].length !== ex.length) {
        sombreadas.push(`${token}  →  casou ${JSON.stringify(m && m[0])} em ${JSON.stringify(ex)}`);
      }
    }
    const naoDeclaradas = sombreadas.filter((x) => !(SOMBRAS[campo] || {})[x.split('  →  ')[0]]);
    expect({ campo, naoDeclaradas }).toEqual({ campo, naoDeclaradas: [] });
    for (const [t, porque] of Object.entries(SOMBRAS[campo] || {})) {
      expect(`${campo}/${t}: ${porque}`).toMatch(/.{40,}/);
    }
  });
});

describe('toda alternativa de todo padrão ESTRUTURAL carrega peso, ou é declarada morta', () => {
  test('sem mutação, o corpo passa inteiro', () => {
    expect(falhasCom(G)).toBe(0);
  });

  test('a lista de campos fora do censo não cresce em silêncio', () => {
    expect(Object.keys(FORA).filter((k) => !(k in G))).toEqual([]);
    // O teto subiu de 5 pra 7 em 2026-09-14, e é uma DECISÃO: as duas novas
    // (`palavra_funcional`, `evasao_que_licencia`) são UNIÕES de listas que o
    // censo já varre em separado, e varrê-las de novo produziria perdões
    // duplicados. Toda vez que este número sobe, alguém tem que escrever por quê.
    expect(Object.keys(FORA).length).toBeLessThanOrEqual(7);
    for (const [campo, porque] of Object.entries(FORA)) {
      expect(`${campo}: ${porque}`).toMatch(/.{80,}/);
    }
  });

  test.each(CAMPOS.filter((c) => !(c in VOCABULARIO) && !(c in FORA)))('%s', (campo) => {
    const re = G[campo];
    const alts = todasAsAlternativas(re);
    // PISO DE VERDADE. Aqui estava `expect({campo, n}).toEqual({campo, n})` —
    // uma comparação do valor com ele mesmo, que não pode falhar, logo abaixo
    // de um comentário dizendo que um campo sem tokens significa varredor
    // quebrado. Vacuidade dentro do instrumento escrito pra achar vacuidade,
    // e ela escondia que cinco dos sete campos estruturais — as duas cabeças
    // entre eles — eram varridos sobre zero tokens.
    // Achado pela revisão de segurança de 2026-09-14.
    expect({ campo, tokens: alts.length }).toEqual({ campo, tokens: alts.length || 'NENHUM' });
    const mortas = [], vivas = [];
    // A CHAVE DA DECLARAÇÃO PRECISA DISTINGUIR OCORRÊNCIAS DO MESMO TEXTO. O
    // `contraste_colado` e o `sujeito_nominal` têm DOIS `{0,2}` cada, e um de
    // cada par carrega peso enquanto o outro não: declarado, o teste acusava
    // `ressuscitada`; não declarado, acusava `não declarada`. Impasse — e o
    // impasse é a prova de que a gaveta estava indexada pela coisa errada. A
    // primeira ocorrência mantém o texto puro (toda declaração já escrita
    // continua valendo); as repetições ganham `#2`, `#3`.
    const vistos = new Map();
    for (const [ini, fim] of alts) {
      const texto = re.slice(ini, fim);
      const ordem = (vistos.get(texto) || 0) + 1;
      vistos.set(texto, ordem);
      const token = ordem === 1 ? texto : `${texto}#${ordem}`;
      // Apaga a alternativa E o `|` que a acompanha.
      // Tira a alternativa E a barra que a acompanha — a de trás se ela é a
      // primeira do grupo, a da frente se não.
      const sem = re[fim] === '|' ? re.slice(0, ini) + re.slice(fim + 1)
        : (re[ini - 1] === '|' ? re.slice(0, ini - 1) + re.slice(fim)
          : re.slice(0, ini) + re.slice(fim));   // membro de classe: só recorta
      const n = falhasCom({ ...G, [campo]: sem });
      (n ? vivas : mortas).push(token);
    }
    const naoDeclaradas = mortas.filter((t) => !(MORTAS[campo] || {})[t]);
    expect({ campo, naoDeclaradas }).toEqual({ campo, naoDeclaradas: [] });
    // E a declaração não pode envelhecer: token que VOLTOU a carregar peso
    // sai da lista, senão a lista vira um perdão permanente.
    const ressuscitadas = Object.keys(MORTAS[campo] || {}).filter((t) => vivas.includes(t));
    expect({ campo, ressuscitadas }).toEqual({ campo, ressuscitadas: [] });
    // Motivo escrito, não um `''` pra calar o teste.
    for (const [t, porque] of Object.entries(MORTAS[campo] || {})) {
      expect(`${campo}/${t}: ${porque}`).toMatch(/.{40,}/);
    }
  });
});
