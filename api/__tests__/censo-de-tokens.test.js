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
 *  · roda só o censo JS. Os dois guardas leem os MESMOS tokens do
 *    `claims.json`, então token morto é morto nos dois — mas o Swift tem
 *    peças COMPOSTAS nele (`destinoEmQualquerLugar`, `ateOSeparador`, as
 *    âncoras do `nega`) que só o `mutar-guarda-swift.sh` alcança;
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
    for (let i = de; i < ate; i += 1) {
      if (re[i] === '\\') { spans.set(`${i}:${i + 2}`, [i, i + 2]); i += 1; continue; }
      if (re[i + 1] === '-' && i + 2 < ate) { spans.set(`${i}:${i + 3}`, [i, i + 3]); i += 2; continue; }
      spans.set(`${i}:${i + 1}`, [i, i + 1]);
    }
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
// AS SONDAS RODAM NO CAMINHO FORTE de propósito. A primeira versão montava
// `Tirei os 10%.\nCom o garçom <verbo> tudo certo.`, que cai no caminho FRACO —
// e lá o resto não-vazio já basta pra deixar passar, com verbo ou sem. A sonda
// dava verde sobre uma peça que ela nunca consultava: vacuidade no instrumento
// escrito pra achar vacuidade. Achado rodando o portão de mutação contra ela.
const VOCABULARIO = {
  substantivo_gorjeta: (ex) => [`${ex}: 10%\n- 100% pro garçom`, true],
  substantivo_destinatario_runtime: (ex) => [`Sobre a gorjeta\n- 100% pra ${ex}`, true],
  verbo_finito: (ex) => [`Sobre a gorjeta\n- 100% pra equipe ${ex} tudo certo`, false],
  pronome_sujeito: (ex) => [`Sobre a gorjeta\n- 100% pra equipe ${ex} paga na saída`, false],
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
  if (/[+*{}]|\\[dwsWSD]|\.|\(\?[=!<]/.test(t)) return null;   // não sei fabricar: falha alto
  t = t.replace(/\((?:\?:)?([^()|]*)\|[^()]*\)/g, '$1');        // (a|b) → a
  t = t.replace(/\((?:\?:)?([^()]*)\)\?/g, '');                 // (x)? → ''
  t = t.replace(/\((?:\?:)?([^()]*)\)/g, '$1');
  t = t.replace(/\[\^[^\]]*\]/g, 'x');
  t = t.replace(/\[([^\]])[^\]]*\]/g, '$1');                    // [oa] → o
  t = t.replace(/(.)\?/g, '');                                  // s? → ''
  t = t.replace(/\\b|\^|\$/g, '').replace(/\\(.)/g, '$1').trim();
  return /^[\wáéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ %,.$€-]+$/.test(t) && t ? t : null;
}

describe('toda palavra das listas de vocabulário é ALCANÇÁVEL', () => {
  test.each(Object.keys(VOCABULARIO))('%s', (campo) => {
    const { acusa } = censoCom(G);
    const alts = listaDominante(G[campo]);
    // Se o varredor deixar de achar a lista, ele falha ALTO em vez de dar ✓
    // sobre zero tokens — que foi o primeiro defeito deste arquivo.
    expect({ campo, tokens: alts.length }).toEqual({ campo, tokens: alts.length });
    expect(alts.length).toBeGreaterThanOrEqual(3);
    const mudas = [];
    for (const token of alts) {
      const ex = exemplar(token);
      if (ex === null) continue;                 // não é palavra (classe, âncora)
      const [texto, esperado] = VOCABULARIO[campo](ex);
      if (acusa(texto) !== esperado) mudas.push(token);
    }
    const naoDeclaradas = mudas.filter((t) => !(SEM_SONDA[campo] || {})[t]);
    expect({ campo, naoDeclaradas }).toEqual({ campo, naoDeclaradas: [] });
    // Declaração que envelheceu: token que voltou a ser sondável sai da lista.
    const sondaveis = Object.keys(SEM_SONDA[campo] || {}).filter((t) => !mudas.includes(t));
    expect({ campo, sondaveis }).toEqual({ campo, sondaveis: [] });
    for (const [t, porque] of Object.entries(SEM_SONDA[campo] || {})) {
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
    expect(Object.keys(FORA).length).toBeLessThanOrEqual(5);
    for (const [campo, porque] of Object.entries(FORA)) {
      expect(`${campo}: ${porque}`).toMatch(/.{80,}/);
    }
  });

  test.each(CAMPOS.filter((c) => !(c in VOCABULARIO) && !(c in FORA)))('%s', (campo) => {
    const re = G[campo];
    const alts = todasAsAlternativas(re);
    // Padrão sem alternância nenhuma não tem token a varrer — e isso tem que
    // ser raro: se um campo de lista cair aqui, o varredor quebrou.
    expect({ campo, alternativas: alts.length })
      .toEqual({ campo, alternativas: alts.length });
    if (!alts.length) return;
    const mortas = [], vivas = [];
    for (const [ini, fim] of alts) {
      const token = re.slice(ini, fim);
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
