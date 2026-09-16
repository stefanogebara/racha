'use strict';

/**
 * AS PALAVRAS DA CASA — conferidas onde elas ENTRAM.
 *
 * O nome do restaurante, o rótulo da mesa e a cidade são as palavras do
 * restaurante: o CLAUDE.md diz que a gente nunca as traduz, e isso continua
 * valendo. O que NÃO vale é aceitar qualquer coisa — estes três campos saem,
 * sem autenticação nenhuma, no `/api/check` que todo cliente lê ao encostar o
 * telefone no QR.
 *
 * O esquema já limita o que o CLIENTE escreve: `payer_label` é
 * `char_length between 1 and 60` desde a 0001, e o nome da conta da casa também
 * (0005). Não limita o que o DONO escreve — `venues.name`, `venues.city` e
 * `venue_tables.label` nasceram `text` puro, e as rotas só conferiam se estava
 * vazio. O campo que o cliente manda tem trava; o campo que todo cliente LÊ,
 * não. A assimetria é o achado.
 *
 * O que se confere, e por quê:
 *
 * - **Tipo.** Só string. `String({})` é `'[object Object]'`, que é verdadeiro,
 *   passa no teste de vazio e vira o nome de uma casa.
 * - **Tamanho, em PONTOS DE CÓDIGO.** O `.length` do JS conta unidades UTF-16 e
 *   o `char_length` do Postgres conta pontos de código: contar diferente dos
 *   dois lados é como se ganha um limite que o banco recusa depois de o portão
 *   aprovar. Um nome de 1 MB cabia na coluna e saía em toda leitura pública.
 * - **Caracteres de controle e de DIREÇÃO.** C0/C1, zero-width e as marcas
 *   bidirecionais somem. Não é zelo tipográfico: um RLO (U+202E) no rótulo faz
 *   "Mesa 7" ser DESENHADO como outra coisa no telefone de quem senta, e um
 *   zero-width faz duas mesas com rótulos idênticos aos olhos passarem pela
 *   unicidade do banco — o cliente lê "Mesa 12" em duas mesas e paga a conta da
 *   outra. (Prova de que o risco é real e não teórico: a ferramenta de shell
 *   desta sessão recusou o próprio arquivo quando estes caracteres estavam
 *   literais, porque "ficariam escondidos no diálogo de aprovação".)
 * - **Espaço em branco colapsado e aparado.** "Mesa   7" e "Mesa 7" são a mesma
 *   mesa pra quem lê e duas pro `unique`.
 *
 * O que NÃO se mexe: acento, cedilha, ñ, apóstrofo, &, maiúscula. São as
 * palavras da casa — "Boteco do Zé", "Bar L'Escala", "Casa & Cia" têm que
 * atravessar inteiras. Um normalizador que "limpa" isso está reescrevendo a
 * placa do restaurante.
 */

/**
 * Controle, largura-zero, marcas de direcao e preenchedores — escritos por
 * ESCAPE de proposito: literais, eles somem no diff, na revisao e no editor de
 * quem vier depois, que e exatamente a propriedade que os torna perigosos no
 * rotulo.
 *
 * A primeira versao cobria so C0/C1, largura-zero, bidi e BOM. Faltavam U+00AD
 * e U+3164, que desenham NADA e derrotam o `unique (venue_id, label)` igual ao
 * largura-zero — e pesam mais no nome da conta da casa, que entra por rota
 * PUBLICA e sem autenticacao: um nome em branco na tela do balcao, sem o
 * `house_name_invalid` nunca disparar. Achado em 2026-09-16 (LOW-1).
 *
 * O QUE NAO ENTRA, e por que: os SELETORES DE VARIACAO (U+FE00–FE0F). A
 * revisao pediu, e a resposta e nao. Eles nao escondem conteudo — modificam o
 * desenho do caractere ANTERIOR, e tirar o U+FE0F de "Bar ❤️ do Ze" muda a
 * placa do restaurante, que e a unica coisa que este modulo promete nao fazer.
 * O caso que a revisao temia (um rotulo feito SO de seletores, que desenha em
 * branco) nao e pego por lista de recusa nenhuma de qualquer jeito: e pego
 * pelo `TEM_CONTEUDO` abaixo, que pergunta o contrario.
 *
 * Cada faixa e o que ela e:
 *   \u0000–\u001F  controle C0
 *   \u007F–\u009F  DEL e controle C1
 *   \u00AD         hifen suave — nao desenha nada
 *   \u061C         marca de letra arabe — marca de direcao
 *   \u115F–\u1160  preenchedores jamo — largura zero
 *   \u17B4–\u17B5  vogais khmer inerentes — nao renderizam
 *   \u180E         separador de vogal mongol
 *   \u200B–\u200F  largura zero e marcas LRM/RLM
 *   \u202A–\u202E  embutir e SOBREPOR direcao (RLO)
 *   \u2060–\u2064  juntor de palavra e operadores invisiveis
 *   \u2066–\u2069  isolar direcao
 *   \u3164         preenchedor hangul — o classico do nome em branco
 *   \uFEFF         BOM
 *   \uFFA0         preenchedor hangul de meia largura
 */
const INVISIVEIS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u115F-\u1160\u17B4-\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/g;

/**
 * E O CONTRARIO DA LISTA DE CIMA, que e o que de fato segura.
 *
 * Toda lista de RECUSA de invisivel tem buraco — esta ja teve um, e o Unicode
 * ganha caractere novo todo ano. Entao, depois da limpeza, pergunta-se o
 * oposto: sobrou alguma coisa que DESENHA? Letra, numero ou simbolo. Um rotulo
 * feito so de marcas, seletores e espaco nao passa — nem os que esta casa ainda
 * nao conhece. Lista de permissao sobre o RESTO, que e a forma que nao
 * envelhece.
 *
 * Pontuacao de proposito NAO conta: um rotulo "..." desenha, mas nao nomeia
 * uma mesa, e "—" sozinho e o mesmo problema com outra cara.
 */
const TEM_CONTEUDO = /[\p{L}\p{N}\p{S}]/u;

/**
 * Os limites — lidos de um JSON que o CLIENTE também lê.
 *
 * O mesmo número vive em três lugares: aqui, no `maxLength` do formulário do
 * dono e no CHECK da 0035. Os dois runtimes não compartilham módulo (CommonJS
 * × TS/ESM), e foi assim que o campo do nome já nasceu com `maxLength={60}`
 * contra um servidor que aceitava outro número. Um arquivo, três leitores.
 */
const LIMITES = (() => {
  const { nomeDaCasa, rotuloDaMesa, cidade } = require('./limites-da-casa.json');
  return { nomeDaCasa, rotuloDaMesa, cidade };
})();

/**
 * @param {unknown} bruto
 * @param {object} opts
 * @param {number} opts.max          tamanho máximo em pontos de código.
 * @param {string} opts.code         código devolvido na recusa (o cliente traduz).
 * @param {boolean} [opts.opcional]  vazio/ausente vira `null` em vez de recusa.
 * @returns {{ok: true, valor: string|null} | {ok: false, code: string}}
 */
function normalizarTextoDaCasa(bruto, { max, code, opcional = false }) {
  // A recusa carrega o NÚMERO. Sem ele a tela diria "tem que caber em
  // {maxChars} caracteres" com o marcador literal — a regressão que o `i18n.ts`
  // já registra duas vezes. O cliente formata; o servidor manda o cru.
  const nao = { ok: false, code, vars: { maxChars: max } };
  if (bruto == null || bruto === '') {
    return opcional ? { ok: true, valor: null } : nao;
  }
  if (typeof bruto !== 'string') return nao;
  // Cortado ANTES das regex: uma string de 1 MB não precisa ser percorrida
  // quatro vezes pra se saber que é grande demais. Mesma ordem do
  // `normalizarDocumentoDaCasa`. O corte é generoso (4× o limite mais uma
  // folga) porque o texto ainda encolhe no colapso de espaço — recusar aqui o
  // que o colapso salvaria seria recusar um nome legítimo mal digitado.
  if (bruto.length > max * 4 + 64) return nao;
  const limpo = bruto
    .normalize('NFC')
    .replace(INVISIVEIS, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Vazio, ou sem nada que desenhe: as duas coisas sao "a pessoa nao escreveu
  // um nome", e a segunda e a que a lista de recusa sozinha deixaria passar.
  if (limpo === '' || !TEM_CONTEUDO.test(limpo)) return opcional ? { ok: true, valor: null } : nao;
  // Pontos de código, como o `char_length` do Postgres conta.
  if ([...limpo].length > max) return nao;
  return { ok: true, valor: limpo };
}

const nomeDaCasa = (b) => normalizarTextoDaCasa(b, { max: LIMITES.nomeDaCasa, code: 'venue_name_invalid' });
const rotuloDaMesa = (b) => normalizarTextoDaCasa(b, { max: LIMITES.rotuloDaMesa, code: 'table_label_invalid' });
const cidadeDaCasa = (b) => normalizarTextoDaCasa(b, { max: LIMITES.cidade, code: 'venue_city_invalid', opcional: true });

module.exports = { normalizarTextoDaCasa, nomeDaCasa, rotuloDaMesa, cidadeDaCasa, LIMITES, INVISIVEIS };
