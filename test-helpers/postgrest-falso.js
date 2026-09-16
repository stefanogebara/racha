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
 * Este honra `eq`, `neq`, `gte`, `in`, `order` e `range`. Quem quiser um dublê
 * mais frouxo que escreva o dele e diga por quê NO CABEÇALHO.
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
 * · **A projeção.** `select('a, b')` devolve só `a` e `b`. Sem isto, tirar a
 *   coluna-chave de um `select` deixa a suíte inteira verde (medido: 2268
 *   passando com o razão lido por uma chave que não vinha).
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
      order(col) { f.ordem.push(col); return b; },
      eq(col, val) { f.eq[col] = val; return b; },
      neq(col, val) { f.neq[col] = val; return b; },
      gte(col, val) { f.gte[col] = val; return b; },
      lt(col, val) { f.lt[col] = val; return b; },
      in(col, vals) { f.in = { col, vals: new Set(vals) }; return b; },
      range(de, ate) { f.de = de; f.ate = ate; return b; },
      limit(n) { f.limite = n; return b; },
      not() { return b; },
      maybeSingle() { return resolver().then((r) => ({ data: r.data[0] ?? null, error: null })); },
      single() { return b.maybeSingle(); },
      then(ok, falha) { return resolver().then(ok, falha); },
    };

    const projeta = (linha) => {
      if (!projetar || !f.colunas) return linha;
      const pedidas = f.colunas.split(',').map((c) => c.trim()).filter(Boolean);
      if (pedidas.some((c) => c === '*' || c.includes('('))) return linha; // embutidas: passa inteiro
      return Object.fromEntries(pedidas.filter((c) => c in linha).map((c) => [c, linha[c]]));
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
        for (const col of f.ordem) {
          const a = x.r[col]; const c = y.r[col];
          if (a < c) return -1;
          if (a > c) return 1;
        }
        return x.sorte - y.sorte;   // EMPATE: o banco não promete nada
      });
      let linhas = comSorte.map((x) => x.r);
      if (f.limite !== null) linhas = linhas.slice(0, f.limite);
      const de = f.de ?? 0;
      const ate = f.ate ?? Infinity;
      const fatia = linhas.slice(de, Math.min(de + maxLinhas, ate + 1));
      return Promise.resolve({ data: fatia.map(projeta), error: null });
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
