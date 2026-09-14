'use strict';
/**
 * Gera `ios/Racha/Agent/ClaimPatterns.swift` a partir do `claims.json`.
 *
 * `{DEST}` no `gatilho_forma_direcional` é expandido com
 * `substantivo_destinatario_runtime`: as duas listas eram escritas à mão e
 * divergiram três vezes, a última por um acento (`ma[îi]tre` × `maitre`).
 *
 * Os dois guardas da mesma política — o censo de build (Node) e a revisão de
 * runtime (Swift) — precisam dos MESMOS padrões, e a v3 os tinha escrito duas
 * vezes à mão. Já tinham divergido em quatro tokens no commit cujo teste dizia
 * impedir isso: `couvert art` e `\bmoço` só no JSON, `sai por folha` e a
 * alternativa do `CNPJ` só no JSON — e o efeito não é simétrico. Uma frase
 * pegada no build e não no runtime passa viva pro cliente; uma frase exempta
 * no build e acusada no runtime faz o guarda REESCREVER texto correto.
 *
 * Um teste comparando comportamento não fecharia isso (NSRegularExpression e
 * RegExp divergem em construções), então o Swift deixa de ter cópia: ele é
 * gerado, e o `claims.test.js` falha se o arquivo no disco não for o que este
 * script produz — a mesma forma da reprodutibilidade do `racha-ios.html`.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const expandirDest = (re, dest) => re.split('{DEST}').join(dest);

/**
 * O DIMINUTIVO É CLASSE PRODUTIVA, e por isso ele é DERIVADO aqui em vez de
 * escrito à mão na lista. Em português qualquer substantivo ganha
 * `-inho/-inha`, e no salão o cliente usa: `gorjetinha`, `dinheirinho`,
 * `graninha`, `ajudinha`, `troquinho`. Enumerá-los é o jogo que a língua
 * natural sempre ganha — o mesmo argumento que fez o `adverbio` tratar
 * `-mente` como morfologia. Achado pela grade adversarial de 2026-09-14, que
 * derrubou onze diminutivos de palavras que a lista JÁ conhecia.
 *
 * A derivação é CONSERVADORA: só a forma mecânica, `-o`/`-a` átono precedido
 * de consoante. Nasal (`-ão`), hiato (`fatia`, `prêmio`) e final consonântico
 * pedem `-zinho`, cuja forma varia com o falante; derivá-las produziria
 * `comissãinho` e `fatiinha`. O que não é mecânico fica declarado no
 * `_diminutivo_nao_mecanico`, não esquecido.
 */
/**
 * VOCABULÁRIO DE DINHEIRO: fronteira, diminutivo e PLURAL, derivados.
 *
 * Três defeitos da mesma família, e os três foram achados na mesma rodada:
 *
 *  · FRONTEIRA. `ajuda` sem delimitador casa dentro de `ajudar`, e
 *    `Posso ajudar você a acertar com o garçom.` virava RECUSA — o turno
 *    inteiro trocado pela resposta segura, com o valor da conta dentro dele.
 *    `troco` dentro de `trocou`, `renda` dentro de `aprenda`, `agrado` dentro
 *    de `agradou`. É a quarta encarnação do delimitador errado neste arquivo,
 *    agora na lista de vocabulário que a rodada anterior fez crescer.
 *  · PLURAL. `gratifica[çc][ãa]o` não casa `gratificações`, e o plural
 *    irregular defeitava as DUAS metades do conserto do veto: a palavra não
 *    está no detector, e um turno que responde sobre gorjeta sem citar valor
 *    não é janela de dinheiro. `As gratificações ficam com a equipe.`, `As
 *    comissões vão pro garçom.`, `Os adicionais vão pro garçom.` — cinco
 *    escapes, na classe de frase que este arquivo inteiro existe pra pegar.
 *    Os plurais em `+s` sobreviviam por ACIDENTE: sem fronteira à direita,
 *    `mimo` casa dentro de `mimos`. Acidente, não desenho — e o mesmo acidente
 *    é o defeito da fronteira.
 *  · DIMINUTIVO, que já era derivado e continua.
 *
 * Tudo conservador: plural mecânico é `-ão→-ões`, `-al→-ais`, `-m→-ns`,
 * `-r|-s|-z→+es` e vogal→`+s`; o resto fica declarado em
 * `_plural_nao_mecanico`. Derivar inflexão, não um sufixo — foi a lição que o
 * diminutivo devia ter sugerido e não sugeriu.
 * Achado pela revisão de compliance de 2026-09-15.
 */
const L = '0-9A-Za-zÀ-ÿ';
const cerca = (w) => `(?<![${L}])${w}(?![${L}])`;
const simples = (alt) => /^[a-záéíóúâêôãõçà]+$/.test(alt);

const diminutivoDe = (alt) => {
  if (/inh[oa]$/.test(alt)) return null;
  if (!new RegExp(`[bcdfgjlmnprstvxzç][oa]$`).test(alt)) return null;
  const raiz = alt.slice(0, -1).replace(/c$/, 'qu').replace(/g$/, 'gu').replace(/ç$/, 'c');
  return raiz + (alt.endsWith('a') ? 'inha' : 'inho');
};

const pluralDe = (alt) => {
  if (/s$/.test(alt)) return null;                    // já é plural ou invariável
  if (/ão$/.test(alt)) return `${alt.slice(0, -2)}ões`;
  if (/al$/.test(alt)) return `${alt.slice(0, -2)}ais`;
  if (/el$/.test(alt)) return `${alt.slice(0, -2)}éis`;
  if (/il$/.test(alt)) return `${alt.slice(0, -2)}is`;
  if (/ol$/.test(alt)) return `${alt.slice(0, -2)}óis`;
  if (/ul$/.test(alt)) return `${alt.slice(0, -2)}uis`;
  if (/m$/.test(alt)) return `${alt.slice(0, -1)}ns`;
  if (/[rz]$/.test(alt)) return `${alt}es`;
  if (/[aeiouáéíóúâêôãõ]$/.test(alt)) return `${alt}s`;
  return null;                                        // consoante rara: declarado
};

/**
 * O `\b` sai e a alternativa vira palavra simples: a fronteira passa a ser a
 * explícita, que é a mesma nos dois motores — o `\b` é ASCII em JavaScript e
 * Unicode em ICU, divergência que este arquivo já pagou três vezes.
 */
const semB = (alt) => alt.replace(/^\\b/, '').replace(/\\b$/, '');

/**
 * Plural de alternativa que tem CLASSE de caractere no fim — `gratifica[çc][ãa]o`
 * é a mesma palavra escrita pra aceitar duas grafias, e o plural dela é
 * regular. Sem isto, os cinco escapes da revisão 19 eram exatamente as
 * palavras cuja grafia alternativa as tirava da derivação.
 */
const pluralComClasse = (alt) => {
  if (/\[[^\]]*\]o$/.test(alt)) return `${alt.replace(/\[[^\]]*\]o$/, '')}[õo]es`;
  return null;
};

const comDiminutivo = (lista) => {
  const fora = [];
  for (const cru of lista.split('|')) {
    const alt = semB(cru);
    if (!simples(alt)) {
      const pl = pluralComClasse(alt);
      fora.push(cru);
      if (pl) fora.push(cerca(pl));
      continue;
    }
    const formas = new Set([alt]);
    for (const f of [diminutivoDe(alt), pluralDe(alt)]) if (f) formas.add(f);
    const dim = diminutivoDe(alt);
    if (dim) { const dp = pluralDe(dim); if (dp) formas.add(dp); }
    for (const f of formas) fora.push(cerca(f));
  }
  return fora.join('|');
};
/**
 * Compõe os padrões que têm MARCADORES EM CAIXA ALTA no JSON. Fica aqui, e não
 * escrito duas vezes, porque o censo de build importa daqui: escrita à mão nos
 * dois lados, esta é exatamente a peça que já divergiu três vezes.
 */
const PECAS = (G) => ({
  MARCADOR: G.marcador_de_lista.replace(/^\^/, '').replace(/\$$/, ''),
  QUANT_C: G.quantidade_consumida,
  PREPDEST: G.preposicao_de_destino + '|' + G.genitivo_de_destino_simples,
  PREPDIR: G.preposicao_direcional,
  EVASAOCAMINHO: G.evasao_de_caminho.replace('DEST', G.substantivo_destinatario_runtime),
  PREP: G.preposicao_de_destino,
  ART: G.artigo_de_destino,
  GORJETANOME: G.substantivo_gorjeta,
  QUANTIANOME: comDiminutivo(G.nome_de_quantia),
  NEGAVEL: G.nucleo_negavel,
  SEPCLAUSULA: G.separador_de_clausula,
  DESTRUNTIME: G.substantivo_destinatario_runtime,
  DESTCENSO: G.substantivo_destinatario,
  PRONOME: G.pronome_sujeito.replace(/^\(\?:\^\|\[\^0-9A-Za-zÀ-ÿ\]\)\(/, '').replace(/\)\(\?=\[\^0-9A-Za-zÀ-ÿ\]\|\$\)$/, ''),
  MODSEMART: G.modificador_sem_artigo,
  MODLONGO: G.modificador_longo,
  MOD: G.modificador_de_destino,
  DEST: G.substantivo_destinatario_runtime,
  NEGCOLADO: G.negador_colado,
  VERBOESP: G.verbo_espanhol,
  VERBOS: G.verbo_finito.replace(/^\(\?:\^\|\[\^0-9A-Za-zÀ-ÿ\]\)\(/, '').replace(/\)\(\?=\[\^0-9A-Za-zÀ-ÿ\]\|\$\)$/, ''),
  ENFASE: G.enfase_markdown,
  ADVERBIO: G.adverbio,
  PREPPRON: G.preposicao_antes_de_pronome,
  NUCLEO: G.nucleo_de_atribuicao,
  GEN: G.genitivo_de_destino_simples,
  RELPRON: G.relativo_pronome,
  RELCLIT: G.relativo_clitico,
  DET: G.determinante,
  AMBIGUO: G.destinatario_ambiguo,
});
/** Substitui TODOS os marcadores, do mais longo pro mais curto — senão `PREP`
 *  comeria o começo de `PREPDEST` e o padrão sairia calado e errado. */
const compor = (G, re) => Object.entries(PECAS(G))
  .sort((a, b) => b[0].length - a[0].length)
  .reduce((acc, [nome, valor]) => acc.split(nome).join(valor), re);
const COMPOSTOS = {
  substantivo_gorjeta: (G) => compor(G, comDiminutivo(G.substantivo_gorjeta)),
  gatilho_forma_direcional: (G) => compor(G, expandirDest(G.gatilho_forma_direcional, G.substantivo_destinatario_runtime)),
  cabeca_de_destino: (G) => compor(G, G.cabeca_de_destino),
  destino_em_qualquer_lugar: (G) => compor(G, G.destino_em_qualquer_lugar),
  destino_em_qualquer_lugar_censo: (G) => compor(G, G.destino_em_qualquer_lugar_censo),
  cabeca_forte: (G) => compor(G, G.cabeca_forte),
  contraste_colado: (G) => compor(G, G.contraste_colado),
  regencia_do_nucleo: (G) => compor(G, G.regencia_do_nucleo),
  evasao_que_licencia: (G) => compor(G, G.evasao_que_licencia),
  palavra_funcional: (G) => compor(G, G.palavra_funcional),
  negador_colado: (G) => compor(G, G.negador_colado),
  cabeca_direcional: (G) => compor(G, G.cabeca_direcional),
  revoga_dispensa: (G) => compor(G, G.revoga_dispensa),
  evasao_de_caminho: (G) => compor(G, G.evasao_de_caminho),
  preposicao_regendo_pronome: (G) => compor(G, G.preposicao_regendo_pronome),
  genitivo_descritivo: (G) => compor(G, G.genitivo_descritivo),
  sujeito_nominal: (G) => compor(G, G.sujeito_nominal),
  sintagma_nominal: (G) => compor(G, G.sintagma_nominal),
  relativa_qualquer: (G) => compor(G, G.relativa_qualquer),
  negadores: (G) => compor(G, G.negadores),
  adversativa_inicial: (G) => compor(G, G.adversativa_inicial),
  modificador_sem_artigo: (G) => compor(G, G.modificador_sem_artigo),
  cabeca_genitiva: (G) => compor(G, G.cabeca_genitiva),
  ambiguo_possuido: (G) => compor(G, G.ambiguo_possuido),
  anafora_de_dinheiro: (G) => compor(G, G.anafora_de_dinheiro),
};
const G = JSON.parse(fs.readFileSync(path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;

/** Literal de string Swift, com as barras e aspas escapadas. */
const lit = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function gerar() {
  return `// GERADO por scripts/gen-claim-patterns.js — NÃO EDITE À MÃO.
//
// A fonte é docs/compliance/claims.json. O censo de build e este guarda de
// runtime têm que aplicar a MESMA regra; escrever os padrões duas vezes já os
// fez divergir em quatro tokens, e a divergência não é simétrica — o que o
// build pega e o runtime não, chega ao cliente.
//
// Pra mudar a regra: edite o JSON e rode \`node scripts/gen-claim-patterns.js\`.
// O \`api/__tests__/claims.test.js\` falha se este arquivo sair de sincronia.

import Foundation

enum ClaimPatterns {
    // NÃO EMITE \`preposicaoDeDestino\`, \`artigoDeDestino\` nem
    // \`modificadorDeDestino\`: desde que o \`destinoEmQualquerLugar\` passou a
    // ser gerado (e não montado à mão nos dois gêmeos), o guarda não consulta
    // nenhuma das três DIRETAMENTE — elas vivem dentro das composições. Padrão
    // emitido e não consultado é o vão pelo qual o \`preposicaoColadaAtras\`
    // sobreviveu à própria remoção da regra.
    static let substantivoGorjeta = ${lit(COMPOSTOS.substantivo_gorjeta(G))}
    /// O que o NEGADOR pode estar negando. Detector e consumidor são listas
    /// diferentes: aqui a polaridade é fail-ABERTO — mais palavras, mais
    /// resgate, menos recusa. Ver \`_porque_nucleo_negavel\`.
    static let nucleoNegavel = ${lit(G.nucleo_negavel)}
    /// Mais curta: sem os pronomes que, na mesa, querem dizer os CLIENTES.
    /// Ver \`_porque_lista_runtime\` no claims.json.
    static let destinatarioRuntime = ${lit(G.substantivo_destinatario_runtime)}
    static let distribuidorComSujeito = ${lit(G.distribuidor_com_sujeito)}
    static let revogaDispensa = ${lit(COMPOSTOS.revoga_dispensa(G))}
    /// Só os negadores de verdade — a evasão preposicional fica na dispensa.
    static let negadores = ${lit(COMPOSTOS.negadores(G))}
    /// Alta precisão, baixa cobertura. Oráculo de teste: ver claims.json.
    static let formaDirecional = ${lit(COMPOSTOS.gatilho_forma_direcional(G))}
    /// QUANTIDADE: separa dinheiro DIRIGIDO de ação dirigida. Inclui moeda —
    /// era a única notação que faltava, e é a que toda linha real usa.
    static let quantidade = ${lit(G.quantidade)}
    /// A CABEÇA: do começo da oração até o núcleo. É PREFIXO — o que importa é
    /// o RESTO, e adjunto não é predicação. Ver \`_porque_cabeca\`.
    /// PRÉ-CONDIÇÃO da regra 3: há destino em qualquer lugar da oração? Era
    /// escrita à mão nos DOIS gêmeos, fora do gerador e fora de todo
    /// instrumento. Ver \`_porque_destino_em_qualquer_lugar\`.
    static let destinoEmQualquerLugar = ${lit(COMPOSTOS.destino_em_qualquer_lugar(G))}
    static let cabecaDeDestino = ${lit(COMPOSTOS.cabeca_de_destino(G))}
    /// A mesma cabeça, com a quantidade OBRIGATÓRIA: evidência forte de
    /// dinheiro dirigido. Ver \`_porque_dois_niveis\`.
    static let cabecaForte = ${lit(COMPOSTOS.cabeca_forte(G))}
    /// Negador CONTRASTIVO: \`não PRA casa\` retira o outro destino e afirma
    /// este; \`não TEM gorjeta nenhuma\` nega de verdade. Ver
    /// \`_porque_contrastiva\`.
    /// Destino colado atrás do negador: contraste. Ver \`_porque_alcance\`.
    static let contrasteColado = ${lit(COMPOSTOS.contraste_colado(G))}
    /// Núcleo REGIDO: complemento oblíquo, não sujeito. Ver \`_porque_alcance\`.
    static let regenciaDoNucleo = ${lit(COMPOSTOS.regencia_do_nucleo(G))}
    /// Sujeito NOMINAL: determinante + substantivo. Ver \`_porque_sujeito_nominal\`.
    static let sujeitoNominal = ${lit(COMPOSTOS.sujeito_nominal(G))}
    /// O mesmo sintagma, SEM a âncora do fim: o segmento tem sujeito próprio
    /// em qualquer lugar dele? Ver \`_porque_sintagma_nominal\`.
    static let sintagmaNominal = ${lit(COMPOSTOS.sintagma_nominal(G))}
    /// Como se chama o dinheiro quando o cliente acabou de perguntar dele.
    static let anaforaDeDinheiro = ${lit(COMPOSTOS.anafora_de_dinheiro(G))}
    /// Destinatário que também é LUGAR. Ver \`_porque_ambiguo\`.
    static let destinatarioAmbiguo = ${lit(G.destinatario_ambiguo)}
    /// O sujeito que o veto da regra 1b existe pra proteger. Polaridade do
    /// lado certo: palavra que a lista não conhece NÃO veta. Ver
    /// \`_porque_veto_por_contexto\`.
    static let substantivoNaoDinheiro = ${lit(G.substantivo_nao_dinheiro)}
    /// O cômodo POSSUÍDO, não visitado: \`fica com o salão\`, \`é da copa\`. Um
    /// cômodo pode ser destino de movimento e não pode ser dono de dinheiro:
    /// é a RELAÇÃO que desfaz a ambiguidade, não a palavra.
    static let ambiguoPossuido = ${lit(COMPOSTOS.ambiguo_possuido(G))}
    /// Só a família do CAMINHO licencia a cabeça não-direcional. Ver \`_porque_licenca\`.
    static let evasaoQueLicencia = ${lit(COMPOSTOS.evasao_que_licencia(G))}
    /// Burlar a FOLHA, sem os negadores nus: \`sem taxa\` não entra aqui.
    /// Ver \`_porque_evasao_de_folha\`.
    static let evasaoDeFolha = ${lit(G.evasao_de_folha)}
    /// Material FUNCIONAL entre o negador e o núcleo. Ver \`_porque_alcance_antes\`.
    static let palavraFuncional = ${lit(COMPOSTOS.palavra_funcional(G))}
    static let cabecaDirecional = ${lit(COMPOSTOS.cabeca_direcional(G))}
    /// A mesma cabeça do caminho fraco, com a preposição GENITIVA no lugar
    /// da direcional. \`A caixinha — DOS atendentes\` é a promessa sem verbo e
    /// sem direção, e ela escapava porque \`d[oa]s?\` não está no \`PREPDIR\`.
    /// A licença é a ESTRITA. Ver \`_porque_cabeca_genitiva\`.
    static let cabecaGenitiva = ${lit(COMPOSTOS.cabeca_genitiva(G))}
    /// Pronome SUJEITO — o que não é regido por preposição. Ver
    /// \`_porque_predicacao\`.
    static let pronomeSujeito = ${lit(G.pronome_sujeito)}
    static let preposicaoRegendoPronome = ${lit(COMPOSTOS.preposicao_regendo_pronome(G))}
    /// GENITIVO DESCRITIVO: \`remuneração da equipe\` diz de quem o dinheiro é,
    /// não pra onde vai — e é o texto que o AgentTool ensina ao modelo. Ver
    /// \`_porque_genitivo_descritivo\`.
    static let genitivoDescritivo = ${lit(COMPOSTOS.genitivo_descritivo(G))}
    /// Enumeração com a POLARIDADE do lado certo: verbo que a lista não
    /// conhece vira recusa, nunca escape. Ver \`_porque_predicacao\`.
    static let verboFinito = ${lit(G.verbo_finito)}
    /// Relativa, retirada antes do teste de predicação.
    static let relativaQualquer = ${lit(COMPOSTOS.relativa_qualquer(G))}
    static let marcadorDeLista = ${lit(G.marcador_de_lista)}
    static let separadorInterno = ${lit(G.separador_interno)}
    /// Ponto entre DÍGITOS não fecha oração: \`R\$ 1.250,00\` é um número.
    /// Ver \`_porque_separador_de_oracao\`.
    static let separadorDeOracao = ${lit(G.separador_de_oracao)}
    /// Separa ESCOPO de cláusula, e inclui a conjunção coordenativa.
    static let separadorDeClausula = ${lit(G.separador_de_clausula)}
    /// Abertura de cláusula ADVERSATIVA: ela QUALIFICA a oração anterior em
    /// vez de afirmar coisa nova. Com slot de advérbio, porque o fabricador
    /// derrubou as três variantes de \`— sempre mas não pela folha\`.
    static let adversativaInicial = ${lit(COMPOSTOS.adversativa_inicial(G))}
    /// Negador COLADO no destinatário. Sem o \`sem\`: ver \`_porque_negadores\`.
    static let negadorColado = ${lit(COMPOSTOS.negador_colado(G))}
    /// A frase que o produto diz. Não é uma variação.
    static let sancionada = ${lit(G.frase_sancionada)}
}
`;
}

const ALVO = path.join(RAIZ, 'ios', 'Racha', 'Agent', 'ClaimPatterns.swift');
module.exports = { gerar, ALVO, expandirDest, COMPOSTOS, PECAS, comDiminutivo };
if (require.main === module) {
  fs.writeFileSync(ALVO, gerar());
  console.log('gerado', path.relative(RAIZ, ALVO));
}
