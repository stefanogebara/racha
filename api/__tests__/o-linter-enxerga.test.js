'use strict';

/**
 * O LINTER ENXERGA — medido sobre fonte sintética.
 *
 * Um portão configurado não é um portão testado. Este repositório já achou a
 * forma "guarda que nasce inerte" cinco vezes: um `xgravar:` que nunca casava,
 * um teste que afirmava que uma LISTA existia, um outro que usava um token
 * interno e por isso batia em 404, um `aviso === null || aviso.escopo ===
 * 'casa'` que é verdade sempre, e um `eslint-disable` escrito para um linter
 * que não rodava. Uma configuração de lint com um erro de recorte —
 * `files` que não casa, `ignores` largo demais, uma regra escrita com nome
 * errado — sai VERDE e não protege nada.
 *
 * Então aqui a pergunta não é "a configuração existe?" e sim "ela fica
 * vermelha no defeito que ela promete pegar?". Cada caso abaixo é uma classe
 * que já custou caro ou que custaria.
 *
 * O primeiro é literal: é o defeito de 2026-09-21, em que `tetoDaGorjeta` era
 * chamada e nunca importada no `router.js`, e `/api/pay/stripe-intent`
 * respondia 500 a TODA requisição — o trilho de cartão inteiro fora do ar,
 * liberado pelas duas revisões obrigatórias, achado por um teste que dirigiu a
 * rota. É o defeito que motivou este linter existir.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');

/** Roda o eslint de verdade, com a configuração de verdade, sobre um arquivo. */
function lintar(conteudo) {
  // FORA de `api/`: meia dúzia de censos varrem aquele diretório arquivo a
  // arquivo, e `prologo-estrito` pegou uma destas provas no ar, em paralelo,
  // reprovando por falta de `'use strict';` numa fonte que existe pra estar
  // errada. O canteiro tem recorte próprio na configuração, com as MESMAS
  // regras; quem prova que o recorte de verdade cobre `api/` é o último teste
  // deste arquivo, que linta três arquivos reais do caminho do dinheiro.
  const canteiro = path.join(RAIZ, '.provas-do-linter');
  fs.mkdirSync(canteiro, { recursive: true });
  const alvo = path.join(canteiro, `p${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(alvo, conteudo);
  try {
    execFileSync('npx', ['eslint', '--format', 'json', alvo], { cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (e) {
    const saida = String(e.stdout || '');
    if (!saida.trim().startsWith('[')) throw new Error(`eslint não rodou: ${String(e.stderr || e.message).slice(0, 400)}`);
    return JSON.parse(saida).flatMap((f) => f.messages.map((m) => m.ruleId));
  } finally {
    fs.unlinkSync(alvo);
  }
}

// O eslint sobe um processo Node por chamada; sem isto o arquivo estoura o
// prazo padrão do jest em máquina fria.
jest.setTimeout(120_000);

describe('o portão de lint fica VERMELHO no que ele promete pegar', () => {
  test.each([
    // A CLASSE QUE MOTIVOU O PORTÃO. `router.js` chamava `tetoDaGorjeta` sem
    // importar: 500 em toda requisição ao trilho de cartão.
    ['símbolo usado e nunca ligado', 'module.exports = () => tetoDaGorjeta(1, 2);', 'no-undef'],
    // Chave repetida: a segunda ganha, calada. Numa regra de split ou num
    // corpo de cobrança, é dinheiro indo pro lugar errado sem erro nenhum.
    ['chave repetida em objeto', 'module.exports = { tipCents: 1, tipCents: 2 };', 'no-dupe-keys'],
    // Guarda escrita depois do `return` — a forma "nasce inerte", em sintaxe.
    ['código inalcançável', 'module.exports = () => { return 1; const x = 2; return x; };', 'no-unreachable'],
    // `typeof x === 'strig'` é sempre falso: o portão que nunca dispara.
    ['typeof comparado com lixo', "module.exports = (v) => typeof v === 'strig';", 'valid-typeof'],
    // `x !== x` e afins — comparação que não decide nada.
    ['comparação consigo mesmo', 'module.exports = (v) => v !== v;', 'no-self-compare'],
    // `case` sem `break` no redutor de eventos aplicaria dois eventos.
    ['fallthrough em switch', 'module.exports = (t) => { switch (t) { case 1: globalThis.x = 1; case 2: return 2; } return 0; };', 'no-fallthrough'],
    // Reatribuir uma constante de dinheiro é `TypeError` em tempo de execução.
    ['atribuição a const', 'const TETO = 1; TETO = 2; module.exports = TETO;', 'no-const-assign'],
  ])('%s → %s', (_nome, fonte, regra) => {
    expect(lintar(fonte)).toContain(regra);
  });

  test('e fica VERDE no que é legítimo — senão o portão vira ruído', () => {
    // Um portão que acusa o inocente morre igual a um que absolve o culpado:
    // a equipe aprende a ignorar vermelho. Este caso usa as formas que o
    // repositório de fato escreve.
    const legitimo = `'use strict';
const { reduce } = require('./api/_lib/checks/check-state');
const ESPERA = /[\\u0000-\\u001F]/;
async function cobrar(eventos, texto) {
  const estado = reduce(eventos);
  await new Promise((r) => setTimeout(r, 1));
  return estado && !ESPERA.test(texto) ? estado.totalCents : 0;
}
module.exports = { cobrar };
`;
    expect(lintar(legitimo)).toEqual([]);
  });
});

/**
 * E O RECORTE DE VERDADE COBRE O LADO DO DINHEIRO.
 *
 * As provas acima rodam num canteiro com recorte próprio. Elas mostram que as
 * REGRAS funcionam e não dizem nada sobre QUEM é lintado — um `files` que
 * tivesse deixado de casar com `api/` passaria todas elas.
 *
 * A primeira versão deste teste perguntava errado: lintava três arquivos do
 * caminho do dinheiro e conferia que eles apareciam na saída com zero
 * mensagens. Só que o eslint devolve entrada pra arquivo que não casa com
 * recorte NENHUM — com zero mensagens, porque zero regras se aplicam. Medido
 * contra mutante: com o recorte trocado por `scripts/**`, o teste continuava
 * VERDE. Guarda nascida inerte, pela sexta vez nesta série, dentro do arquivo
 * cujo título é "o linter enxerga".
 *
 * `--print-config` pergunta a coisa certa: qual configuração o eslint RESOLVE
 * pra este arquivo. Se `api/` sair do recorte, o mapa de regras vem vazio.
 */
describe('o recorte de verdade cobre o lado do dinheiro', () => {
  const DO_DINHEIRO = [
    'api/_lib/pay/create-charge.js',
    'api/_app/router.js',
    'api/_lib/markets.js',
    'api/_lib/pay/saude-do-adquirente.js',
    'api/_lib/checks/split-engine.js',
  ];

  test.each(DO_DINHEIRO)('%s é lintado com a regra que motivou o portão', (arquivo) => {
    const resolvida = JSON.parse(execFileSync('npx', ['eslint', '--print-config', arquivo],
      { cwd: RAIZ, encoding: 'utf8' }));
    // O `--print-config` normaliza a severidade pro número (2 = error), então
    // é o número que se confere — comparar com a string `'error'` deixava este
    // teste vermelho sempre, que é a outra metade de não medir nada.
    expect(resolvida.rules['no-undef']).toEqual([2, expect.anything()]);
    // E o conjunto inteiro chegou, não só uma regra solta.
    expect(Object.keys(resolvida.rules).length).toBeGreaterThan(15);
  });

  test('e eles passam hoje — o portão nasce verde', () => {
    // A condição pra um portão ser levado a sério quando ficar vermelho.
    const saida = JSON.parse(execFileSync('npx',
      ['eslint', '--format', 'json', ...DO_DINHEIRO], { cwd: RAIZ, encoding: 'utf8' }));
    expect(saida.flatMap((f) => f.messages)).toEqual([]);
  });
});
