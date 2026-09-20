'use strict';

/**
 * `'use strict';` TEM QUE SER A PRIMEIRA COISA DO ARQUIVO.
 *
 * Ela só é DIRETIVA quando é a primeira instrução. Um `require` acima dela a
 * transforma numa expressão-string inútil, e o arquivo inteiro passa a rodar em
 * modo solto — em silêncio, com a linha ainda lá pra quem ler o topo acreditar
 * que está ligada.
 *
 * Foi o que aconteceu com `_lib/house/house-service.js`: um `require` novo
 * entrou acima da diretiva e desligou o modo estrito nas 592 linhas do serviço
 * de SALDO ARMAZENADO — `createLoad`, `redeem`, `confirmLoadFromWebhook`. Em
 * modo solto, um `const` esquecido num refactor futuro não lança
 * `ReferenceError`: escreve em `globalThis`. Numa lambda quente da Vercel essa
 * propriedade sobrevive à requisição, então um `account` ou um `accountId` que
 * deveria ser por-requisição vira estado entre requisições e entre CASAS — e o
 * sintoma é saldo errado, não exceção. Sucesso silencioso, que é o inimigo
 * nomeado no CLAUDE.md.
 *
 * Achado pela sétima revisão de segurança (2026-09-19, HIGH-1). Latente quando
 * foi achado — nenhuma atribuição solta existia no corpo — e é exatamente por
 * isso que precisa de censo: uma rede de segurança removida em silêncio não dá
 * sinal até o dia em que alguém precisa dela.
 */

const fs = require('node:fs');
const path = require('node:path');

const API = path.join(__dirname, '..');

function arquivosJs(dir, fora = []) {
  for (const nome of fs.readdirSync(dir)) {
    const cheio = path.join(dir, nome);
    if (fs.statSync(cheio).isDirectory()) {
      if (nome !== 'node_modules') arquivosJs(cheio, fora);
    } else if (nome.endsWith('.js')) {
      fora.push(cheio);
    }
  }
  return fora;
}

/** A primeira linha que não é vazia nem comentário. */
function primeiraInstrucao(fonte) {
  const semBloco = fonte.replace(/^\s*\/\*[\s\S]*?\*\//, '');
  for (const linha of semBloco.split('\n')) {
    const t = linha.trim();
    if (!t || t.startsWith('//')) continue;
    return t;
  }
  return '';
}

test('todo arquivo de `api/` abre com a diretiva, e ela é a PRIMEIRA instrução', () => {
  const soltos = arquivosJs(API)
    .filter((f) => primeiraInstrucao(fs.readFileSync(f, 'utf8')) !== "'use strict';")
    .map((f) => path.relative(API, f));
  expect(soltos).toEqual([]);
});

test('o censo ENXERGA — medido sobre fonte sintética', () => {
  // Sem isto, um censo que nunca acusa ninguém é indistinguível de um censo
  // quebrado. A prova planta as duas formas do defeito.
  expect(primeiraInstrucao("const x = require('y');\n'use strict';\n")).not.toBe("'use strict';");
  expect(primeiraInstrucao('/** doc */\n\n// nota\n\nconst x = 1;\n')).toBe('const x = 1;');
  // E absolve o arranjo correto, inclusive com docblock e comentário na frente.
  expect(primeiraInstrucao("/** doc */\n\n'use strict';\n")).toBe("'use strict';");
  expect(primeiraInstrucao("'use strict';\nconst x = 1;\n")).toBe("'use strict';");
});
