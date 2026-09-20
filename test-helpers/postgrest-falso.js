'use strict';

/**
 * UM POSTGREST FALSO, NUM LUGAR SÓ.
 *
 * Três arquivos de teste já tinham escrito o seu, e eles divergiam justamente
 * nos filtros: o do `idas-por-lote` faz `gte`/`neq`/`not` virarem no-op (ele
 * mede CONTAGEM DE IDAS, e pra isso não precisa filtrar), e usado pra afirmar
 * uma janela de datas ele absolveria um filtro que não rodou. É a mesma forma
 * que já rendeu três cópias divergentes do predicado de estorno neste
 * repositório — só que em dublê, onde ela é mais difícil de ver, porque um
 * dublê permissivo não quebra nada: ele só faz o teste dizer sim.
 *
 * Este honra `eq`, `neq`, `gte`, `lt`, `in`, `order` (com direção), `limit` e
 * `range`. Quem quiser um dublê mais frouxo que escreva o dele e diga por quê
 * NO CABEÇALHO.
 *
 * O que ele NÃO modela, ele RECUSA em vez de fingir: `.not()` lança. Um no-op
 * silencioso é a permissividade que este arquivo existe pra acabar.
 *
 * ── O QUE ELE IMITA DO SERVIDOR DE VERDADE ──────────────────────────────────
 * · **O corte.** O PostgREST devolve no máximo `db-max-rows` linhas e não
 *   avisa. É ele que torna a paginação obrigatória; sem imitá-lo, um teste de
 *   paginação não mede nada.
 * · **O empate sem promessa.** O Postgres não promete ordem entre linhas
 *   empatadas, nem a MESMA ordem em duas consultas. O desempate aqui é
 *   sorteado a cada ida: com ordem total não há empate e o resultado é
 *   determinístico; sem ela, a paginação perde e duplica linha — que é o que
 *   acontece lá.
 * · **A projeção, e o ERRO dela.** `select('a, b')` devolve só `a` e `b` — sem
 *   isso, tirar a coluna-chave de um `select` deixa a suíte inteira verde
 *   (medido: 2268 passando com o razão lido por uma chave que não vinha). E uma
 *   coluna pedida que a tabela não tem vira **`42703`**, como no servidor, em
 *   vez de sumir: é o SQLSTATE do incidente que dá nome ao inegociável #7, e
 *   engoli-lo deixaria uma coluna renomeada numa migração passar verde aqui e
 *   500 em produção.
 * · **`single()` não é `maybeSingle()`.** Zero ou muitas linhas dão `PGRST116`.
 *   Aliasar os dois tornava o ramo de duplicata do `createTable` inexercitável.
 */

/**
 * @param {Record<string, object[]>} tabelas  nome da tabela → linhas.
 * @param {object} [opts]
 * @param {number} [opts.maxLinhas]  o corte do servidor (`db-max-rows`).
 * @param {boolean} [opts.projetar]  aplicar o `select` (padrão: true).
 */
function postgrestFalso(tabelas, { maxLinhas = 1000, projetar = true } = {}) {
  /** Toda ida, na ordem — pra quem quiser CONTAR round trips. */
  const idas = [];

  const from = (tabela) => {
    const f = {
      tabela, eq: {}, neq: {}, gte: {}, lt: {}, in: null,
      de: undefined, ate: undefined, ordem: [], colunas: null, limite: null,
    };
    const b = {
      select(cols) { f.colunas = typeof cols === 'string' ? cols : null; return b; },
      order(col, opts) {
        // A DIREÇÃO importa: modelar um DESC como ASC faz uma leitura de
        // "os mais recentes" devolver os mais ANTIGOS, e com `.limit()` junto
        // o teste afirma a fatia errada com cara de certa.
        f.ordem.push({ col, asc: !opts || opts.ascending !== false });
        return b;
      },
      eq(col, val) { f.eq[col] = val; return b; },
      neq(col, val) { f.neq[col] = val; return b; },
      gte(col, val) { f.gte[col] = val; return b; },
      lt(col, val) { f.lt[col] = val; return b; },
      in(col, vals) { f.in = { col, vals: new Set(vals) }; return b; },
      range(de, ate) { f.de = de; f.ate = ate; return b; },
      limit(n) { f.limite = n; return b; },
      not() {
        // NÃO MODELADO, e dizendo isso em voz alta. Um no-op silencioso aqui é
        // exatamente a permissividade que este arquivo existe pra acabar: o
        // `listPendingCharges` exclui `house_account` por `.not()`, e com um
        // no-op o teste passaria a afirmar uma lista que inclui o que a
        // produção exclui.
        throw new Error('postgrest-falso: `.not()` não é modelado — implemente antes de usar');
      },
      maybeSingle() { return resolver().then((r) => ({ data: (r.data || [])[0] ?? null, error: r.error ?? null })); },
      /**
       * `single()` NÃO é `maybeSingle()`. O PostgREST erra com `PGRST116`
       * quando o resultado não tem exatamente uma linha, e é esse erro que o
       * ramo de duplicata do `createTable` depende. Aliasado, esse ramo não
       * podia ser exercitado por dublê nenhum.
       */
      single() {
        return resolver().then((r) => {
          if (r.error) return { data: null, error: r.error };
          const n = (r.data || []).length;
          if (n === 1) return { data: r.data[0], error: null };
          return { data: null, error: { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned (${n})` } };
        });
      },
      then(ok, falha) { return resolver().then(ok, falha); },
    };

    /**
     * A COLUNA QUE NÃO EXISTE É UM ERRO, não um campo que some.
     *
     * Isto fazia `.filter((c) => c in linha)`: uma coluna pedida e inexistente
     * sumia em silêncio. O PostgREST devolve **400 / `42703` "column … does not
     * exist"** — que é o SQLSTATE do incidente que dá nome ao inegociável #7.
     * Com o descarte silencioso, renomear uma coluna numa migração deixava as
     * três suítes que usam este dublê verdes e a rota 500 em produção.
     *
     * A checagem é contra as colunas que a TABELA tem (a união das chaves de
     * todas as linhas), e não contra a linha corrente — senão uma linha que por
     * acaso não tem um campo opcional acusaria falso.
     */
    const colunasDaTabela = () => {
      const todas = new Set();
      for (const l of tabelas[tabela] || []) for (const k of Object.keys(l)) todas.add(k);
      return todas;
    };
    const projeta = (linha) => {
      if (!projetar || !f.colunas) return linha;
      const pedidas = f.colunas.split(',').map((c) => c.trim()).filter(Boolean);
      // Embutidas (`venue_tables(label)`) não são projetadas — o dublê não sabe
      // montar junção. As SIMPLES do mesmo select continuam sendo conferidas,
      // que é a metade que pega coluna renomeada.
      const simples = pedidas.filter((c) => c !== '*' && !c.includes('('));
      if (pedidas.includes('*')) return linha;
      const existentes = colunasDaTabela();
      const faltando = simples.filter((c) => !existentes.has(c));
      if (faltando.length > 0 && existentes.size > 0) {
        const e = new Error(`column ${tabela}.${faltando[0]} does not exist`);
        e.__pg = '42703';
        throw e;
      }
      if (pedidas.length !== simples.length) return linha;  // tem embutida: passa inteiro
      return Object.fromEntries(simples.filter((c) => c in linha).map((c) => [c, linha[c]]));
    };

    function resolver() {
      idas.push(f);
      const casam = (r) => {
        for (const [c, v] of Object.entries(f.eq)) if (r[c] !== v) return false;
        for (const [c, v] of Object.entries(f.neq)) if (r[c] === v) return false;
        for (const [c, v] of Object.entries(f.gte)) if (!(String(r[c]) >= String(v))) return false;
        for (const [c, v] of Object.entries(f.lt)) if (!(String(r[c]) < String(v))) return false;
        if (f.in && !f.in.vals.has(r[f.in.col])) return false;
        return true;
      };
      const comSorte = (tabelas[tabela] || []).filter(casam).map((r) => ({ r, sorte: Math.random() }));
      comSorte.sort((x, y) => {
        for (const { col, asc } of f.ordem) {
          const a = x.r[col]; const c = y.r[col];
          if (a < c) return asc ? -1 : 1;
          if (a > c) return asc ? 1 : -1;
        }
        return x.sorte - y.sorte;   // EMPATE: o banco não promete nada
      });
      let linhas = comSorte.map((x) => x.r);
      if (f.limite !== null) linhas = linhas.slice(0, f.limite);
      const de = f.de ?? 0;
      const ate = f.ate ?? Infinity;
      const fatia = linhas.slice(de, Math.min(de + maxLinhas, ate + 1));
      try {
        return Promise.resolve({ data: fatia.map(projeta), error: null });
      } catch (e) {
        if (e.__pg) return Promise.resolve({ data: null, error: { code: e.__pg, message: e.message } });
        throw e;
      }
    }
    return b;
  };

  return { client: { from, rpc: async () => ({ data: null, error: null }) }, idas };
}

/** Quantas idas a cada tabela — o atalho que quase todo teste de lote quer. */
function idasPorTabela(idas) {
  const por = {};
  for (const i of idas) por[i.tabela] = (por[i.tabela] || 0) + 1;
  return por;
}

/** O tamanho de página que o store pediu, lido da primeira ida com `range`. */
function paginaObservada(idas) {
  const comRange = idas.find((i) => i.ate !== undefined && i.ate !== Infinity);
  return comRange ? comRange.ate - comRange.de + 1 : null;
}

module.exports = { postgrestFalso, idasPorTabela, paginaObservada };
