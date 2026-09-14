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
  DESTRUNTIME: G.substantivo_destinatario_runtime,
  PRONOME: G.pronome_sujeito.replace(/^\(\?:\^\|\[\^0-9A-Za-zÀ-ÿ\]\)\(/, '').replace(/\)\(\?=\[\^0-9A-Za-zÀ-ÿ\]\|\$\)$/, ''),
  MODLONGO: G.modificador_longo,
  MOD: G.modificador_de_destino,
  DEST: G.substantivo_destinatario_runtime,
  NEGCOLADO: G.negador_colado,
  VERBOS: G.verbo_finito.replace(/^\(\?:\^\|\[\^0-9A-Za-zÀ-ÿ\]\)\(/, '').replace(/\)\(\?=\[\^0-9A-Za-zÀ-ÿ\]\|\$\)$/, ''),
  ENFASE: G.enfase_markdown,
  ADVERBIO: G.adverbio,
  PREPPRON: G.preposicao_antes_de_pronome,
  NUCLEO: G.nucleo_de_atribuicao,
  GEN: G.genitivo_de_destino_simples,
  RELPRON: G.relativo_pronome,
  RELCLIT: G.relativo_clitico,
});
/** Substitui TODOS os marcadores, do mais longo pro mais curto — senão `PREP`
 *  comeria o começo de `PREPDEST` e o padrão sairia calado e errado. */
const compor = (G, re) => Object.entries(PECAS(G))
  .sort((a, b) => b[0].length - a[0].length)
  .reduce((acc, [nome, valor]) => acc.split(nome).join(valor), re);
const COMPOSTOS = {
  substantivo_gorjeta: (G) => compor(G, G.substantivo_gorjeta),
  gatilho_forma_direcional: (G) => compor(G, expandirDest(G.gatilho_forma_direcional, G.substantivo_destinatario_runtime)),
  cabeca_de_destino: (G) => compor(G, G.cabeca_de_destino),
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
  relativa_qualquer: (G) => compor(G, G.relativa_qualquer),
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
    static let substantivoGorjeta = ${lit(COMPOSTOS.substantivo_gorjeta(G))}
    /// Mais curta: sem os pronomes que, na mesa, querem dizer os CLIENTES.
    /// Ver \`_porque_lista_runtime\` no claims.json.
    static let destinatarioRuntime = ${lit(G.substantivo_destinatario_runtime)}
    static let distribuidorComSujeito = ${lit(G.distribuidor_com_sujeito)}
    static let revogaDispensa = ${lit(COMPOSTOS.revoga_dispensa(G))}
    /// Só os negadores de verdade — a evasão preposicional fica na dispensa.
    static let negadores = ${lit(G.negadores)}
    /// Alta precisão, baixa cobertura. Oráculo de teste: ver claims.json.
    static let formaDirecional = ${lit(COMPOSTOS.gatilho_forma_direcional(G))}
    /// QUANTIDADE: separa dinheiro DIRIGIDO de ação dirigida. Inclui moeda —
    /// era a única notação que faltava, e é a que toda linha real usa.
    static let quantidade = ${lit(G.quantidade)}
    /// Preposição de destino, nas três línguas do produto.
    static let preposicaoDeDestino = ${lit(G.preposicao_de_destino)}
    static let artigoDeDestino = ${lit(G.artigo_de_destino)}
    /// Até dois modificadores entre o artigo e o núcleo: \`the FLOOR staff\`.
    /// Ver \`_porque_modificador\`.
    static let modificadorDeDestino = ${lit(G.modificador_de_destino)}
    /// A CABEÇA: do começo da oração até o núcleo. É PREFIXO — o que importa é
    /// o RESTO, e adjunto não é predicação. Ver \`_porque_cabeca\`.
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
    /// Como se chama o dinheiro quando o cliente acabou de perguntar dele.
    static let anaforaDeDinheiro = ${lit(G.anafora_de_dinheiro)}
    /// Destinatário que também é LUGAR. Ver \`_porque_ambiguo\`.
    static let destinatarioAmbiguo = ${lit(G.destinatario_ambiguo)}
    /// Só a família do CAMINHO licencia a cabeça não-direcional. Ver \`_porque_licenca\`.
    static let evasaoQueLicencia = ${lit(COMPOSTOS.evasao_que_licencia(G))}
    /// Material FUNCIONAL entre o negador e o núcleo. Ver \`_porque_alcance_antes\`.
    static let palavraFuncional = ${lit(COMPOSTOS.palavra_funcional(G))}
    static let cabecaDirecional = ${lit(COMPOSTOS.cabeca_direcional(G))}
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
    /// Separa ESCOPO de cláusula, e inclui a conjunção coordenativa.
    static let separadorDeClausula = ${lit(G.separador_de_clausula)}
    /// Negador COLADO no destinatário. Sem o \`sem\`: ver \`_porque_negadores\`.
    static let negadorColado = ${lit(COMPOSTOS.negador_colado(G))}
    /// A frase que o produto diz. Não é uma variação.
    static let sancionada = ${lit(G.frase_sancionada)}
}
`;
}

const ALVO = path.join(RAIZ, 'ios', 'Racha', 'Agent', 'ClaimPatterns.swift');
module.exports = { gerar, ALVO, expandirDest, COMPOSTOS, PECAS };
if (require.main === module) {
  fs.writeFileSync(ALVO, gerar());
  console.log('gerado', path.relative(RAIZ, ALVO));
}
