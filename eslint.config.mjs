/**
 * O LINTER DO LADO DO DINHEIRO — e ele existe por um defeito concreto.
 *
 * Em 2026-09-21, `api/_app/router.js` chamava `tetoDaGorjeta` e nunca a
 * importava. Não era a gorjeta acima do total que quebrava: era
 * `ReferenceError` em TODA requisição a `/api/pay/stripe-intent`, ou seja o
 * trilho de cartão inteiro — e com ele o Bizum e a Espanha — respondendo 500
 * `internal`. Cada pessoa na mesa lia "algo deu errado, tente de novo".
 *
 * O que devia cobrir isso era um censo de TEXTO: uma regex procurando o
 * literal da chamada no código-fonte dos dois chamadores. Ela casava nos dois
 * arquivos, e a função não existia no escopo de um deles.
 *
 * As DUAS revisões obrigatórias leram aquele commit e passaram por cima — elas
 * leram o mesmo texto que a regex lia. O defeito só apareceu quando um teste
 * finalmente DIRIGIU a rota. Medido depois, sobre os dois commits:
 *
 *     5ba46e7  →  1378:23  error  'tetoDaGorjeta' is not defined  no-undef
 *     c5d37d1  →  (limpo)
 *
 * Segundos de linter contra duas revisões cuidadosas. Não é que as revisões
 * sejam ruins: é que ler um arquivo é péssimo jeito de conferir escopo, e
 * máquina é ótimo.
 *
 * ── O QUE ENTRA AQUI, E O QUE NÃO ────────────────────────────────────────
 *
 * Só regra de CORREÇÃO, e só regra com zero violações hoje. Um portão que
 * nasce com quarenta avisos ensina a equipe a ignorar vermelho, que é o
 * oposto do que o CI deste repositório existe pra fazer — o próprio workflow
 * já diz isso sobre o `npm audit`.
 *
 * Nada de estilo. Nada de "boa prática". Cada regra abaixo responde à
 * pergunta "isto pode estar quebrado agora?".
 *
 * O que ficou DE FORA está listado embaixo, com motivo e com o que falta —
 * porque uma lista de exclusões sem motivo é onde a próxima divergência mora.
 */

import js from '@eslint/js';
/**
 * `globals` É DEPENDÊNCIA DECLARADA, e isto custou uma descoberta.
 *
 * A primeira versão deste arquivo importava `globals` sem declará-lo: ele vinha
 * de carona como dependência transitiva do eslint 9, hoisted no
 * `node_modules`. Funcionava — até não funcionar. No eslint 10 ele deixa de ser
 * hoisted e o lint morre inteiro com `ERR_MODULE_NOT_FOUND`, ou seja o portão
 * do caminho do dinheiro desaparece num upgrade de ferramenta.
 *
 * É a mesma ressalva que a revisão de segurança escreveu sobre um censo
 * proposto com `@babel/parser`: "hoje são dependências transitivas do jest,
 * pinem ou o censo evapora num upgrade — guarda que morre calada". A ressalva
 * estava certa e eu a reproduzi no commit seguinte, em outro pacote.
 */
import globals from 'globals';

/**
 * As regras de correção que o `recommended` traz e que hoje passam limpas.
 *
 * Escritas POR NOME, e não como `...js.configs.recommended`, porque aquele
 * conjunto muda entre versões do eslint: um upgrade que acrescente regra
 * deixaria o portão vermelho por motivo de ferramenta, e um que remova
 * apagaria uma guarda sem ninguém ver. Aqui, mudar o conjunto é um commit.
 */
const CORRECAO = {
  // A CLASSE QUE MOTIVOU ISTO: símbolo usado e nunca ligado.
  'no-undef': 'error',

  // Coisa declarada duas vezes — a segunda ganha, calada.
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-class-members': 'error',
  'no-redeclare': 'error',

  // Código que não roda, ou que roda quando não devia.
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-constant-condition': 'error',

  // Comparação que mente. `x !== x`, `typeof x === 'strig'`, `-0`.
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-self-compare': 'error',
  'no-compare-neg-zero': 'error',

  // Atribuição onde se queria comparação, e atribuição que não faz nada.
  'no-cond-assign': 'error',
  'no-self-assign': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',

  // Chamar o que não é função; buraco em literal de array.
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'getter-return': 'error',

  // `await` dentro de executor de Promise — engole erro de verdade.
  'no-async-promise-executor': 'error',
};

/**
 * O QUE FICOU DE FORA, com motivo. Nenhuma destas é "não importa".
 *
 *  · `no-unused-vars` — 25 ocorrências hoje, TODAS em `api/__tests__`. Algumas
 *    são sobra inocente; outras são sinal de verdade (um teste que desestrutura
 *    algo e nunca afirma sobre ele é um teste que não testa). Entra quando
 *    alguém olhar as 25 uma a uma — ligá-la junto com este commit seria
 *    esconder 25 perguntas dentro de uma mudança de ferramenta.
 *
 *  · `no-control-regex` — 3 ocorrências, as três DELIBERADAS: são exatamente
 *    as expressões que existem pra tirar caractere de controle da entrada
 *    (`create-charge.js`, `texto-da-casa.js`, e o censo que as confere). A
 *    regra acusaria o conserto pelo nome do defeito.
 *
 *  · `no-misleading-character-class` — 1 ocorrência, em `INVISIVEIS`
 *    (`texto-da-casa.js`), a lista de codepoints invisíveis que segura nome de
 *    casa em branco. O conserto da regra é acrescentar a flag `u`, que muda o
 *    comportamento de um regex de segurança — mudança de mérito próprio, com
 *    teste próprio, não carona numa configuração.
 *
 *  · `no-useless-escape`, `no-regex-spaces` — estilo de regex, não correção.
 *
 *  · `no-promise-executor-return` — 18 ocorrências, e as 18 são
 *    `new Promise((r) => setTimeout(r, ms))`: a arrow devolve o id do timer,
 *    que ninguém lê. Reescrever 18 sítios pra agradar uma regra cujo alvo de
 *    verdade é outro (`new Promise((res) => res(x))`) é o "portão que nasce
 *    com quarenta avisos" contra o qual este arquivo argumenta acima.
 *
 * E as DIRETIVAS ÓRFÃS: `reportUnusedDisableDirectives` fica ligado. Este
 * repositório tinha dois `eslint-disable-next-line` escritos para um linter
 * que nunca rodou (`global-require`, `no-await-in-loop`) — comentários que
 * pareciam proteção e não protegiam nada, que é a forma "guarda que nasce
 * inerte" numa versão de papel. Eles saíram; a opção impede os próximos.
 */
export default [
  {
    // O lado do dinheiro, os utilitários e o servidor de desenvolvimento.
    // `apps/web` tem o eslint dele, com regras de React — não se misturam.
    files: ['api/**/*.js', 'scripts/**/*.js', 'test-helpers/**/*.js', 'dev-server.js', 'tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: CORRECAO,
  },
  {
    // `render-deck.js` monta uma página e roda callbacks DENTRO do navegador,
    // via `page.evaluate`. `document` ali não é símbolo solto: é o documento
    // do outro lado. Dar os globais do navegador a este arquivo é mais honesto
    // que desligar a regra que o resto do repositório usa.
    files: ['scripts/render-deck.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Os arquivos `.mjs` das ferramentas são módulos de verdade.
    files: ['tools/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    /**
     * O CANTEIRO DAS PROVAS DO PRÓPRIO PORTÃO.
     *
     * `o-linter-enxerga.test.js` escreve fonte deliberadamente quebrada e
     * exige que o lint fique vermelho nela. Esses arquivos NÃO podem nascer
     * dentro de `api/`: meia dúzia de censos varrem aquele diretório arquivo a
     * arquivo — `prologo-estrito` pegou um deles no ar, em paralelo, e
     * reprovou por falta de `'use strict';` numa fonte que existe justamente
     * pra estar errada.
     *
     * Então as provas moram aqui, e QUEM prova que o recorte de verdade cobre
     * `api/` é outro teste do mesmo arquivo, que linta três arquivos reais do
     * caminho do dinheiro. Duas perguntas, dois lugares.
     */
    files: ['.provas-do-linter/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: CORRECAO,
  },
  { ignores: ['node_modules/**', 'apps/**', 'ios/**', 'supabase/**'] },
];

// `js` é importado pra travar a versão do pacote junto com as regras acima:
// elas vieram do `recommended` dele, e a nota no topo do `CORRECAO` explica
// por que são copiadas por nome em vez de espalhadas.
void js;
