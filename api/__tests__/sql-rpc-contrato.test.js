'use strict';

/**
 * TODA chamada `client.rpc(...)` bate com a assinatura VIVA da função, e toda
 * função `security definer` fixa o `search_path` (segurança, PR #21, MÉDIA).
 *
 * Até aqui só a `open_check` e a `adjust_check` tinham o contrato conferido. Um
 * parâmetro renomeado de um lado só é `PGRST202` em produção — a rota cai no
 * catch-all com 500, e o teste do store (com um cliente falso) segue verde,
 * porque o falso aceita qualquer nome. E um `security definer` sem
 * `search_path` resolve nomes pelo caminho de quem chama: o sequestro clássico
 * de função privilegiada.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const SQL = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(DIR, f), 'utf8'))
  .join('\n')
  .replace(/--[^\n]*/g, '');   // comentário não é assinatura (a 0037 tem '(0001)' dentro de uma)

/** A lista de parâmetros com parênteses balanceados (`numeric(10,2)` não corta). */
function paramsDe(texto, inicio) {
  let prof = 0; let i = inicio;
  for (; i < texto.length; i += 1) {
    if (texto[i] === '(') prof += 1;
    else if (texto[i] === ')') { prof -= 1; if (prof === 0) break; }
  }
  return texto.slice(inicio + 1, i);
}

/** Por nome, a ÚLTIMA definição: parâmetros (nome, tem default) e o corpo do cabeçalho. */
function funcoesVivas() {
  const vivas = new Map();
  const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi;
  for (const m of SQL.matchAll(re)) {
    const abre = m.index + m[0].length - 1;
    const lista = paramsDe(SQL, abre);
    const params = lista.split(/,(?![^(]*\))/).map((p) => p.trim()).filter(Boolean).map((p) => ({
      nome: p.split(/\s+/)[0],
      opcional: /\bdefault\b/i.test(p),
    }));
    // O cabeçalho: do fim da lista até o `as $$` — onde moram `security definer` e `set`.
    const resto = SQL.slice(abre + lista.length + 2, abre + lista.length + 2 + 600);
    const cabecalho = resto.slice(0, resto.search(/\bas\s+\$/i) + 1);
    vivas.set(m[1], { params, cabecalho });
  }
  return vivas;
}

/** Todas as chamadas `client.rpc('nome', { p_x: ..., ... })` do código de produção. */
function chamadas() {
  const arquivos = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') andar(p); }
      else if (e.name.endsWith('.js')) arquivos.push(p);
    }
  };
  andar(path.join(RAIZ, 'api'));
  const out = [];
  for (const f of arquivos) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.rpc\(\s*'(\w+)'\s*(,\s*\{)?/g)) {
      let chaves = [];
      if (m[2]) {
        const abre = m.index + m[0].length - 1;
        let prof = 0; let i = abre;
        for (; i < src.length; i += 1) {
          if (src[i] === '{') prof += 1;
          else if (src[i] === '}') { prof -= 1; if (prof === 0) break; }
        }
        chaves = [...src.slice(abre + 1, i).matchAll(/(?:^|[,{\s])(p_\w+)\s*:/g)].map((k) => k[1]);
      }
      out.push({ arquivo: path.relative(RAIZ, f), nome: m[1], chaves });
    }
  }
  return out;
}

const VIVAS = funcoesVivas();
const CHAMADAS = chamadas();

test('o censo enxerga: acha as funções e as chamadas de verdade (regex quebrado não passa calado)', () => {
  expect(VIVAS.size).toBeGreaterThan(15);
  expect(CHAMADAS.length).toBeGreaterThanOrEqual(18);
  expect(VIVAS.get('adjust_check').params.map((p) => p.nome)).toEqual(['p_check_id', 'p_expected_seq', 'p_total_cents', 'p_items']);
  expect(CHAMADAS.find((c) => c.nome === 'adjust_check').chaves).toEqual(['p_check_id', 'p_expected_seq', 'p_total_cents', 'p_items']);
});

test('toda chamada rpc bate com a assinatura viva: função existe, nenhum nome desconhecido, nenhum obrigatório faltando', () => {
  const problemas = [];
  for (const c of CHAMADAS) {
    const f = VIVAS.get(c.nome);
    if (!f) { problemas.push(`${c.arquivo}: rpc '${c.nome}' — função não existe em migração nenhuma`); continue; }
    const nomes = f.params.map((p) => p.nome);
    const desconhecidos = c.chaves.filter((k) => !nomes.includes(k));
    const faltando = f.params.filter((p) => !p.opcional && !c.chaves.includes(p.nome)).map((p) => p.nome);
    if (desconhecidos.length) problemas.push(`${c.arquivo}: rpc '${c.nome}' passa ${desconhecidos.join(', ')} que a função não tem`);
    if (faltando.length) problemas.push(`${c.arquivo}: rpc '${c.nome}' não passa ${faltando.join(', ')} (obrigatório)`);
  }
  expect(problemas).toEqual([]);
});

test('toda função security definer (na definição VIVA) fixa o search_path', () => {
  const soltas = [...VIVAS.entries()]
    .filter(([, f]) => /security\s+definer/i.test(f.cabecalho) && !/set\s+search_path/i.test(f.cabecalho))
    .map(([nome]) => nome);
  expect(soltas).toEqual([]);
});
