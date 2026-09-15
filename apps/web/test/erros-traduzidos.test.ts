import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * QUEM TRADUZ É A ORIGEM, e ninguém traduz duas vezes.
 *
 * `tErr` recebe um ERRO e lê `.code`/`.message`. Aplicado a uma string — que é
 * o que um estado `error: string | null` guarda — ele devolve '' e apaga a
 * mensagem. Foi o que aconteceu no `Admin.tsx` (segurança HIGH-2 de d7f2683):
 * um conserto de uma linha destruiu seis mensagens do painel do dono e deixou
 * parágrafos vermelhos VAZIOS em fechar conta, desativar mesa e criar mesa.
 *
 * O TypeScript não pega: `tErr(e: unknown)` aceita string de bom grado. Então o
 * contrato vira teste: nenhum arquivo aplica `tErr` a uma variável de estado de
 * erro. `tErr` é pra `catch`, e o que está em `error` já é frase.
 */
const SRC = join(import.meta.dirname, '..', 'src');

/**
 * SEM COMENTÁRIO. Um teste que lê fonte é sensível à prosa que documenta o
 * próprio conserto: a primeira versão deste censo acusou os DOIS comentários
 * que explicam por que o código cru saiu daqui. É a terceira vez que isso morde
 * este repositório — ver a âncora sequestrada em `teto-aviso`.
 */
const semComentario = (fonte: string) => fonte
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * OS NOMES DOS ESTADOS DE ERRO, DERIVADOS DO ARQUIVO — uma definição só.
 *
 * A primeira versão do censo enumerava quatro (`error|erro|payError|
 * confirmError`) e a árvore tem mais: `loadError`, `submitError`. Quem
 * "consertasse" o `AdminRecipient` com `{tErr(loadError)}` reproduzia o
 * parágrafo vermelho VAZIO do painel com o censo verde (segurança LOW-2 de
 * 41b188a). Fica aqui, e não dentro do teste, porque uma cópia da regra dentro
 * do teste que a confere prova a cópia, não a regra.
 */
export const estadosDeErro = (fonte: string): string[] =>
  [...fonte.matchAll(/const \[(\w+), set\w+\] = useState<string \| null>/g)].map((m) => m[1]);

function fontes(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir, { withFileTypes: true })) {
    const cheio = join(dir, nome.name);
    if (nome.isDirectory()) fontes(cheio, saida);
    else if (/\.(ts|tsx)$/.test(nome.name)) saida.push(cheio);
  }
  return saida;
}

test('ninguém aplica tErr/tError a um estado de erro já traduzido', () => {
  const culpados: string[] = [];
  for (const f of fontes(SRC)) {
    const fonte = semComentario(readFileSync(f, 'utf8'));
    /**
     * OS NOMES SAEM DO ARQUIVO, não de uma lista minha.
     *
     * A primeira versão enumerava quatro (`error|erro|payError|confirmError`) e
     * a árvore tem mais: `loadError`, `submitError`, `err`. Quem "consertasse" o
     * `AdminRecipient` com `{tErr(loadError)}` reproduzia o parágrafo vermelho
     * VAZIO do painel com o censo verde (segurança LOW-2 de 41b188a). Agora todo
     * `useState<string | null>` do próprio arquivo entra na busca.
     */
    const estados = estadosDeErro(fonte);
    if (!estados.length) continue;
    const alvo = new RegExp(`\\bt(?:Err|rErr|Error)\\(\\s*(?:lang\\s*,\\s*)?(${estados.join('|')})\\b`, 'g');
    for (const m of fonte.matchAll(alvo)) culpados.push(`${f.slice(SRC.length + 1)}: ${m[0]}`);
  }
  assert.deepEqual(culpados, []);
});

test('o único código cru do hook do painel virou frase na ORIGEM', () => {
  const hook = semComentario(readFileSync(join(SRC, 'useVenueAdmin.ts'), 'utf8'));
  // Nada de `setError('<codigo>')`: quem escreve em `error` escreve frase.
  const crus = [...hook.matchAll(/setError\(\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(crus, []);
  assert.match(readFileSync(join(SRC, 'useVenueAdmin.ts'), 'utf8'),
    /setError\(trErr\(\{ code: 'check_not_found' \}\)\)/);
});

/**
 * A MARCA DA COBRANÇA ATUAL, e só dela.
 *
 * A tela sai de `pagar` pra `pago` quando encontra `ownRef` entre os pagamentos
 * da conta. Se `ownRef` sobrevivesse a uma cobrança nova — o caminho "pagar mais
 * uma parte" — a marca da PRIMEIRA parte, que segue na projeção pública, faria a
 * SEGUNDA tela dizer "pago" na hora, com comprovante, valor e CNPJ, por uma
 * cobrança que ninguém pagou (CDC art. 6º III e art. 42 § único).
 *
 * Uma revisão de compliance apontou isso em d7f2683 como CRÍTICO; medindo, a
 * limpeza JÁ existe — `setOwnRef(null)` abre o `try` do handler, antes do
 * `await` que cria a cobrança, então quando `step` vira `pagar` a marca velha já
 * saiu. O achado era falso. Este teste existe porque ele PODERIA não ser: a
 * linha é uma só, some sem quebrar nada, e o sintoma é um comprovante falso.
 */
test('a marca do pagamento é limpa ANTES de cada cobrança nova', () => {
  const app = semComentario(readFileSync(join(SRC, 'App.tsx'), 'utf8'));
  const inicio = app.indexOf('setOwnRef(null)');
  const criacao = app.indexOf('const result = await api.pay(');
  const marcaNova = app.indexOf('refDoPagamento(result.txid)');
  const vaiPraPagar = app.indexOf("setStep('pagar')");
  assert.ok(inicio > -1, 'a limpeza da marca sumiu');
  assert.ok(inicio < criacao, 'a marca velha tem que sair ANTES de a cobrança nova existir');
  assert.ok(criacao < marcaNova && marcaNova < vaiPraPagar, 'a marca nova vem antes da tela de pagar');
});

test('os nomes dos estados de erro saem do ARQUIVO, não de uma lista minha', () => {
  /**
   * A primeira versão enumerava quatro nomes, e a árvore tem mais — quem
   * "consertasse" o `AdminRecipient` com `{tErr(loadError)}` reproduzia o
   * parágrafo vermelho VAZIO com o censo verde (segurança LOW-2 de 41b188a).
   * Aqui a derivação é medida num arquivo que tem estados que a lista antiga não
   * conhecia.
   */
  const fonte = semComentario(readFileSync(join(SRC, 'AdminRecipient.tsx'), 'utf8'));
  const estados = estadosDeErro(fonte);
  assert.ok(estados.includes('loadError'), 'a derivação perdeu loadError');
  assert.ok(estados.includes('submitError'), 'a derivação perdeu submitError');
});
