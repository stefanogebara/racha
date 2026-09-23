import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TODA `var(--x)` TEM UM `--x`, E TODO `--x` TEM QUEM O LEIA.
 *
 * O CSS degrada em silêncio: `color: var(--red)` sem `--red` definido não é erro
 * — a propriedade é descartada e o elemento herda a cor do pai. Foi assim que o
 * canário de divergência do painel (o número mais alto do inegociável #8) passou
 * a sair num bordô órfão fora da paleta, e que uma frase de aviso passou a sair
 * em caixa-alta espaçada porque herdou o versalete do rótulo acima.
 *
 * Os dois foram achados por uma revisão de UI lendo arquivo por arquivo. Este
 * teste é o que faz o build achar o terceiro.
 *
 * O outro lado também é censo: um token declarado e NUNCA lido é a camada
 * semântica que o código passa por baixo. `--ok-bg`, `--erro-bg` e `--emcurso-bg`
 * nasceram neste redesenho para nomear significado, e nasceram mortos — as telas
 * chamavam `--azul-suave` e `--coral-suave` direto.
 */
const RAIZ = join(import.meta.dirname, '..', 'src');
const fontes = () => readdirSync(RAIZ).filter((f) => /\.(tsx?|css)$/.test(f))
  .map((f) => semComentario(readFileSync(join(RAIZ, f), 'utf8')));

/**
 * SEM COMENTÁRIO. Um censo que lê comentário acusa a prosa que documenta o
 * próprio conserto — aconteceu três vezes neste repositório, e aconteceu aqui:
 * o parágrafo que explica por que `--w` foi apagado contém `--w:`, e o censo
 * passou a exigir um leitor pra um token que não existe mais.
 */
const semComentario = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const css = semComentario(readFileSync(join(RAIZ, 'styles.css'), 'utf8'));
/**
 * As DECLARAÇÕES, em qualquer escopo e em qualquer posição da linha.
 *
 * A primeira versão casava `/^\s{2}(--x):/m` — só a primeira declaração de cada
 * linha com dois espaços de recuo. O bloco da landing declara várias por linha
 * (`--n: …; --cr: …;`), então `--cr`, `--cr3` e `--cr4` ficavam de fora e o
 * censo acusava tokens que existem. Um censo que acusa o inocente morre igual a
 * um que absolve o culpado — é a terceira vez que isto aparece nesta série.
 *
 * O `replace` tira os USOS antes de procurar as declarações: sem ele, o `--x` de
 * um `var(--x)` seguido de `:` (num seletor, por exemplo) entraria como
 * declaração e absolveria o órfão.
 */
const declarados = new Set(
  [...css.replace(/var\(\s*--[a-z0-9-]+/g, 'var(').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);
const usados = new Map<string, number>();
for (const src of fontes()) {
  for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) {
    usados.set(m[1], (usados.get(m[1]) || 0) + 1);
  }
}

test('nenhuma `var(--x)` aponta pra token que não existe', () => {
  // `--escala` é a razão entre a moldura do produto na landing e a largura pra
  // qual o produto é desenhado: quem a declara é o `style` inline do
  // componente, porque só um `ResizeObserver` sabe a largura real — e o CSS lê
  // com um padrão no próprio `var()`. Fica de fora, nomeada.
  //
  // (`--h` estava aqui até a landing em papel. A altura do embed deixou de ser
  // medida — o painel virou uma janela que rola —, e uma dispensa pra um token
  // que ninguém mais usa é uma guarda pra nada.)
  const DISPENSADOS = new Set(['--escala']);
  const orfas = [...usados.keys()].filter((t) => !declarados.has(t) && !DISPENSADOS.has(t)).sort();
  assert.deepEqual(orfas, [],
    `\n${orfas.join('\n')}\nO CSS descarta a propriedade em silêncio: o elemento herda a cor do pai `
    + 'e ninguém vê. Defina o token ou use um que exista.\n');
});

/**
 * E TODO TOKEN DECLARADO TEM QUEM O LEIA.
 *
 * O outro lado do censo, e o que pegou a camada de apelidos: trinta tokens
 * declarados, vinte e cinco sem um único leitor — inclusive três (`--ok-bg`,
 * `--erro-bg`, `--emcurso-bg`) criados por este redesenho pra nomear
 * significado, enquanto o código chamava `--musgo-suave` e `--coral-suave`
 * direto. Camada semântica que ninguém atravessa é decoração, e decoração num
 * arquivo de tokens é onde a próxima divergência nasce.
 *
 * As DISPENSAS são declaradas, com motivo — não por silêncio.
 */
test('nenhum token declarado fica sem leitor', () => {
  // Vazia de propósito. Moravam aqui `--n`, `--u` e `--escala`, tokens de
  // escopo da landing escura; a landing em papel usa os tokens da raiz, e os
  // três deixaram de existir. Uma dispensa que nomeia um token inexistente não
  // dispensa nada — só ensina que a lista pode ter sobra.
  const DISPENSADOS = new Map<string, string>([]);
  const semLeitor = [...declarados]
    .filter((t) => !usados.has(t) && !DISPENSADOS.has(t))
    .sort();
  assert.deepEqual(semLeitor, [],
    `\n${semLeitor.join('\n')}\nToken sem leitor: ou alguém devia estar usando, ou ele é `
    + 'sobra de uma migração. Apague, ou use, ou declare a dispensa com motivo.\n');
});

test('o censo ENXERGA — medido sobre fonte sintética', () => {
  // Sem isto, um erro de recorte na regex (o `^\s{2}` das declarações, por
  // exemplo) absolveria o arquivo inteiro em silêncio.
  // E o corte de comentário não pode engolir código: um `var()` de verdade
  // depois de um comentário na mesma linha continua sendo visto.
  assert.equal(semComentario('/* --sumido: 1; */ color: var(--ink);').includes('var(--ink)'), true);
  assert.equal(semComentario('/* --sumido: 1; */').includes('--sumido'), false);
  const falso = 'color: var(--nao-existe-mesmo);';
  const achadas = [...falso.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
    .filter((t) => !declarados.has(t));
  assert.deepEqual(achadas, ['--nao-existe-mesmo']);
  // E o conjunto de declarados não pode ter vindo vazio.
  assert.ok(declarados.size > 30, `só ${declarados.size} tokens declarados — a varredura quebrou`);
  // E ENXERGA declarações VÁRIAS POR LINHA — a forma que a primeira versão
  // desta varredura não via. Esta prova usava tokens reais (`--cr`, `--cr3`,
  // `--cr4`), e eles sumiram com a landing escura: prova que depende de um
  // token específico existir morre quando ele morre. Agora é fonte sintética,
  // pela MESMA expressão que monta `declarados`.
  const variasPorLinha = '.x { --um: 1px; --dois: 2px; --tres: 3px; }';
  const vistos = new Set([...variasPorLinha.replace(/var\(\s*--[a-z0-9-]+/g, 'var(')
    .matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  assert.deepEqual([...vistos].sort(), ['--dois', '--tres', '--um']);
  assert.ok(declarados.has('--col'), '--col é declarado no bloco `.landing` e a varredura não viu');
});
