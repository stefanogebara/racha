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
  [...fonte.matchAll(/const \[(\w+), set\w+\] = useState<string(?:\s*\|\s*null)?>/g)].map((m) => m[1]);

/**
 * Onde o tradutor MORA. Dispensa por NOME, com motivo — não por silêncio: um
 * arquivo que some do censo por não ter estado reconhecível é o censo perdendo
 * uma tela, e foi assim que as duas telas de pagamento ficaram de fora.
 */
const ONDE_O_TRADUTOR_MORA = ['i18n.ts', 'lang.tsx'];

/** Quem chama o tradutor de erro — é nessas telas que o censo TEM de valer. */
export const chamaTradutorDeErro = (fonte: string): boolean => /\bt(?:Err|rErr|Error)\(/.test(fonte);

/**
 * A VARREDURA, UMA SÓ — usada na árvore de verdade e nas fontes SINTÉTICAS do
 * teste. Enquanto a regra vivia dentro do teste que a confere, mutar a de
 * verdade não deixava nada vermelho: a cópia continuava provando o comportamento
 * antigo. Devolve os dois tipos de buraco: quem traduz duas vezes, e quem some
 * do censo por não declarar estado reconhecível.
 */
export function varrer(arquivos: Array<[string, string]>) {
  const culpados: string[] = [];
  const semEstado: string[] = [];
  for (const [nome, cru] of arquivos) {
    const fonte = semComentario(cru);
    const estados = estadosDeErro(fonte);
    if (!estados.length) {
      if (chamaTradutorDeErro(fonte) && !ONDE_O_TRADUTOR_MORA.includes(nome)) semEstado.push(nome);
      continue;
    }
    const alvo = new RegExp(`\\bt(?:Err|rErr|Error)\\(\\s*(?:lang\\s*,\\s*)?(${estados.join('|')})\\b`, 'g');
    for (const m of fonte.matchAll(alvo)) culpados.push(`${nome}: ${m[0]}`);
  }
  return { culpados, semEstado };
}

function fontes(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir, { withFileTypes: true })) {
    const cheio = join(dir, nome.name);
    if (nome.isDirectory()) fontes(cheio, saida);
    else if (/\.(ts|tsx)$/.test(nome.name)) saida.push(cheio);
  }
  return saida;
}

test('ninguém aplica tErr/tError a um estado de erro já traduzido', () => {
  const pares = fontes(SRC).map((f) => [f.slice(SRC.length + 1), readFileSync(f, 'utf8')] as [string, string]);
  const { culpados, semEstado } = varrer(pares);
  assert.deepEqual(culpados, []);
  // E nenhum arquivo que traduz erro fica FORA do censo por não ter estado
  // reconhecível — silêncio aqui é o censo perdendo uma tela inteira.
  assert.deepEqual(semEstado, []);

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

test('o censo pega os dois buracos — medido sobre fontes sintéticas', () => {
  /**
   * Os dois defeitos que ele existe pra pegar, plantados: traduzir o que já é
   * frase (o parágrafo vermelho VAZIO do painel) e a tela que some do censo por
   * declarar `useState<string>` em vez de `useState<string | null>` — que era o
   * caso das DUAS telas de pagamento (segurança HIGH-2 de d7f2683 e LOW-3 de
   * 089e8a2).
   */
  const traduzDuasVezes = `const [error, setError] = useState<string | null>(null);
    return <p>{tErr(error)}</p>;`;
  const semEstadoReconhecivel = 'return <p>{tErr(qualquerCoisa)}</p>;';
  const estadoSemBarraNull = `const [error, setError] = useState<string>('');
    return <p>{tErr(error)}</p>;`;
  const limpo = `const [error, setError] = useState<string | null>(null);
    catch (e) { setError(tErr(e)); }
    return <p>{error}</p>;`;

  assert.deepEqual(varrer([['Tela.tsx', traduzDuasVezes]]).culpados, ['Tela.tsx: tErr(error']);
  assert.deepEqual(varrer([['Tela.tsx', semEstadoReconhecivel]]).semEstado, ['Tela.tsx']);
  assert.deepEqual(varrer([['Pagar.tsx', estadoSemBarraNull]]).culpados, ['Pagar.tsx: tErr(error']);
  assert.deepEqual(varrer([['Limpa.tsx', limpo]]), { culpados: [], semEstado: [] });
  // E o arquivo onde o tradutor MORA é dispensado por nome, não por silêncio.
  assert.deepEqual(varrer([['i18n.ts', semEstadoReconhecivel]]).semEstado, []);
});
