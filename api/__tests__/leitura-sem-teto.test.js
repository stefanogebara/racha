'use strict';

/**
 * NENHUMA LEITURA DO STORE VOLTA SEM TETO.
 *
 * Três rodadas seguidas acharam o MESMO defeito em lugares diferentes, e as
 * duas primeiras foram consertadas uma de cada vez:
 *
 *   1. `listTables` lia o razão de cada conta em série (`mesas-por-lote`).
 *   2. O lote consertou os FILHOS (razão, pagamentos) e deixou os PAIS — a
 *      lista de contas e a de contas-da-casa — com um `select` seco.
 *   3. Sobravam ainda a janela de pagamentos do painel (de onde sai o número
 *      da GORJETA que o dono leva pra folha, Lei 13.419), as três leituras do
 *      funil de adoção, os dois razões singulares, a lista de contas-da-casa
 *      (teto 5000 POR DESENHO), as mesas de treino e mais três.
 *
 * Dezoito leituras sem teto, das quais uma revisão viu seis. O conserto pontual
 * não alcança isto: o que alcança é PERGUNTAR A TODAS.
 *
 * O PostgREST corta em `db-max-rows` e devolve 200 — sem erro, sem aviso. Numa
 * leitura de dinheiro isso não é lentidão, é número errado com cara de certo:
 * a conciliação compara metade da casa e diz que bate.
 *
 * ── LIMITE DECLARADO ────────────────────────────────────────────────────────
 * Este é um censo de FONTE. Ele lê a cadeia de chamadas de cada `.from()` e
 * classifica; ele não roda nada. Um `.range()` com aritmética errada passa por
 * aqui — quem mede isso é o `idas-por-lote.test.js`, com um falso que corta
 * como o servidor corta. Os dois juntos cobrem "tem teto" e "o teto funciona";
 * nenhum dos dois sozinho.
 */

const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', '_lib', 'store', 'supabase.js');

/**
 * As leituras que NÃO precisam de paginação, por nome e com o motivo.
 *
 * Dispensa por NOME e com razão — não por silêncio. Uma dispensa muda de
 * significado quando o código ao lado muda, e a única forma de alguém perceber
 * isso é ter que ler a frase pra apagá-la.
 */
const DISPENSADAS = {
  idsDeContasFechadas:
    'O `.in()` é de no máximo IDS_POR_LOTE (200) ids e o filtro é `type=CLOSED`, '
    + 'que existe no máximo uma vez por conta: o resultado não passa de 200 linhas, '
    + 'muito abaixo de qualquer `db-max-rows`. É a ÚNICA leitura em lote cujo teto '
    + 'vem da forma do dado, e não de um `range`.',
  lerPorLote:
    'É o próprio ajudante de lote — ele chama o `lerPaginado`, que é quem tem o `range`.',
};

/** A cadeia de chamadas que começa num `.from(`, até o `;` que a fecha. */
function cadeiasDeLeitura(fonte) {
  const linhas = fonte.split('\n');
  const achadas = [];
  for (let i = 0; i < linhas.length; i++) {
    if (!/\.from\(/.test(linhas[i])) continue;
    let cadeia = '';
    // Até 40 linhas: os `select` deste arquivo carregam comentários longos, e
    // uma janela curta faz o censo ABSOLVER (foi o que aconteceu com o
    // `getPayment`, cujo `.maybeSingle()` ficava fora de uma janela de 14).
    for (let j = i; j < Math.min(i + 40, linhas.length); j++) {
      cadeia += `${linhas[j]}\n`;
      if (/;\s*$/.test(linhas[j])) break;
    }
    achadas.push({ linha: i + 1, cadeia, dono: donoDe(linhas, i) });
  }
  return achadas;
}

/** O nome da função/método em que a linha `i` está. */
function donoDe(linhas, i) {
  for (let j = i; j >= 0; j--) {
    const m = linhas[j].match(/^\s*(?:async\s+)?(?:function\s+)?([a-zA-Z_]\w*)\s*\(/);
    if (m && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) return m[1];
  }
  return '(desconhecido)';
}

function classificar({ cadeia }) {
  if (/\.(insert|update|upsert|delete)\(/.test(cadeia)) return 'escrita';
  if (/\.(maybeSingle|single)\(/.test(cadeia)) return 'uma linha';
  if (/head:\s*true/.test(cadeia)) return 'contagem';
  if (/\.limit\(/.test(cadeia)) return 'limit';
  if (/\.range\(/.test(cadeia)) return 'paginada';
  return 'SEM TETO';
}

describe('nenhuma leitura do store volta sem teto', () => {
  const fonte = fs.readFileSync(ARQUIVO, 'utf8');
  const leituras = cadeiasDeLeitura(fonte);

  test('o censo ENXERGA — sobre a fonte de verdade, não sobre nada', () => {
    // Um regex quebrado (ou um arquivo renomeado) daria zero leituras e o teste
    // abaixo passaria sobre o vazio. É a forma de falha desta classe de teste.
    expect(leituras.length).toBeGreaterThan(50);
    const tipos = new Set(leituras.map(classificar));
    // Tem que haver exemplo de cada classe, senão o classificador está cego
    // num ramo e ninguém sabe qual.
    for (const t of ['uma linha', 'paginada', 'escrita']) expect([...tipos]).toContain(t);
  });

  test('toda leitura de muitas linhas pagina — ou está dispensada por escrito', () => {
    const semTeto = leituras
      .filter((l) => classificar(l) === 'SEM TETO')
      .filter((l) => !DISPENSADAS[l.dono])
      .map((l) => `L${l.linha} em \`${l.dono}\``);
    expect(semTeto).toEqual([]);
  });

  test('toda dispensa é usada — uma dispensa órfã é uma regra que ninguém lê', () => {
    const donosSemTeto = new Set(
      leituras.filter((l) => classificar(l) === 'SEM TETO').map((l) => l.dono),
    );
    const orfas = Object.keys(DISPENSADAS).filter((d) => !donosSemTeto.has(d));
    expect(orfas).toEqual([]);
  });

  /**
   * O censo tem que ACUSAR, e isto é medido sobre fonte sintética em vez de
   * plantada no arquivo real — plantar no real e esquecer de tirar é como se
   * desliga um guarda sem querer.
   */
  test('o censo acusa uma leitura nova sem teto — medido', () => {
    const sintetico = [
      'async function leituraNova(venueId) {',
      "  const { data, error } = await client.from('payments').select('txid').eq('venue_id', venueId);",
      "  throwOn(error, 'leituraNova');",
      '}',
    ].join('\n');
    const achadas = cadeiasDeLeitura(sintetico);
    expect(achadas).toHaveLength(1);
    expect(classificar(achadas[0])).toBe('SEM TETO');
    expect(achadas[0].dono).toBe('leituraNova');
  });

  test('e ABSOLVE as três formas legítimas de ter teto', () => {
    const casos = [
      ["const a = await client.from('x').select('id').eq('a', b).maybeSingle();", 'uma linha'],
      ["const a = await client.from('x').select('id').eq('a', b).limit(10);", 'limit'],
      ["const a = await client.from('x').select('id').eq('a', b).range(0, 99);", 'paginada'],
      ["const a = await client.from('x').insert({ a: 1 });", 'escrita'],
    ];
    for (const [fonteCaso, esperado] of casos) {
      const [achada] = cadeiasDeLeitura(`async function f() {\n  ${fonteCaso}\n}`);
      expect({ fonteCaso, tipo: classificar(achada) }).toEqual({ fonteCaso, tipo: esperado });
    }
  });
});

describe('o que pagina, pagina com ordem TOTAL', () => {
  /**
   * `range` sem ordem total é pior que não paginar: duas páginas podem repetir
   * uma linha e omitir outra, e num razão de dinheiro isso é um pagamento que
   * some. O Postgres não promete ordem entre linhas empatadas, nem a mesma
   * ordem em duas consultas.
   *
   * Aqui só se confere que existe `.order(` na cadeia — se a ordem é TOTAL é
   * questão de esquema, e quem prova isso é o `idas-por-lote`, com um falso que
   * desempata ao acaso.
   */
  test('toda leitura paginada diz por que ordem', () => {
    const fonte = fs.readFileSync(ARQUIVO, 'utf8');
    const semOrdem = cadeiasDeLeitura(fonte)
      .filter((l) => classificar(l) === 'paginada')
      .filter((l) => !/\.order\(/.test(l.cadeia))
      .map((l) => `L${l.linha} em \`${l.dono}\``);
    expect(semOrdem).toEqual([]);
  });
});
