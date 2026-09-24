import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Visto no painel de produção em 2026-09-24: a rede caiu no meio do teste e a
// tela mostrou "Failed to fetch" — o TypeError do navegador, cru, em inglês.
// Todo fetch passa por `buscar`, que troca a rejeição por código traduzido.
const SRC = new URL('../src/', import.meta.url);
const ler = (f: string) => readFileSync(new URL(f, SRC), 'utf8');

// Os beacons do App.tsx chamam fetch direto, de propósito: disparo sem
// resposta, com `.catch(() => {})` — a falha nunca chega à tela.
const DISPENSADOS: Record<string, number> = { 'App.tsx': 2 };

function arquivos(dir: URL, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? arquivos(new URL(`${d.name}/`, dir), `${base}${d.name}/`)
      : /\.(ts|tsx)$/.test(d.name) ? [`${base}${d.name}`] : []);
}

test('só o `buscar` chama fetch — nenhum outro caminho deixa o TypeError cru passar', () => {
  const chamadas: Record<string, number> = {};
  for (const f of arquivos(SRC)) {
    const semComentario = ler(f).split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
    const n = (semComentario.match(/\bfetch\(/g) || []).length;
    if (n) chamadas[f] = n;
  }
  assert.deepEqual(chamadas, { 'api.ts': 1, ...DISPENSADOS });
  for (const [f] of Object.entries(DISPENSADOS)) {
    for (const m of ler(f).matchAll(/\bfetch\([\s\S]{0,400}?\)\s*\.catch\(\(\) => \{\}\)/g)) assert.ok(m);
  }
  const api = ler('api.ts');
  assert.match(api, /throw new ApiError\('network_error', undefined, 'network_error'\);/);
  assert.match(api, /e\.name === 'AbortError'\) throw e;/);
});

test('o código da falha de rede tem tradução nas três línguas', async () => {
  const { DICT } = await import('../src/i18n.ts');
  const e = (DICT as Record<string, Record<string, string>>)['err.network_error'];
  for (const l of ['en', 'pt', 'es']) assert.ok(e?.[l], `err.network_error sem ${l}`);
});
