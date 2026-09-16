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
 * Controle C0/C1, zero-width, marcas bidi e BOM — escritos por ESCAPE de
 * propósito: literais, eles somem no diff, na revisão e no editor de quem vier
 * depois, que é exatamente a propriedade que os torna perigosos no rótulo.
 */
const INVISIVEIS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

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
  if (limpo === '') return opcional ? { ok: true, valor: null } : nao;
  // Pontos de código, como o `char_length` do Postgres conta.
  if ([...limpo].length > max) return nao;
  return { ok: true, valor: limpo };
}

const nomeDaCasa = (b) => normalizarTextoDaCasa(b, { max: LIMITES.nomeDaCasa, code: 'venue_name_invalid' });
const rotuloDaMesa = (b) => normalizarTextoDaCasa(b, { max: LIMITES.rotuloDaMesa, code: 'table_label_invalid' });
const cidadeDaCasa = (b) => normalizarTextoDaCasa(b, { max: LIMITES.cidade, code: 'venue_city_invalid', opcional: true });

module.exports = { normalizarTextoDaCasa, nomeDaCasa, rotuloDaMesa, cidadeDaCasa, LIMITES, INVISIVEIS };
