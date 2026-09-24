import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Visto no painel de produção em 2026-09-24: a rede caiu no meio do teste e a
// tela mostrou "Failed to fetch" — o TypeError do navegador, cru, em inglês.
// Todo fetch passa por `buscar`, que troca a rejeição por código traduzido.
const SRC = new URL('../src/', import.meta.url);
const ler = (f: string) => readFileSync(new URL(f, SRC), 'utf8');

test('só o `buscar` chama fetch — nenhum outro caminho deixa o TypeError cru passar', () => {
  const chamadas: string[] = [];
  for (const f of readdirSync(SRC)) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const n = (ler(f).match(/\bawait fetch\(/g) || []).length;
    if (n) chamadas.push(`${f}:${n}`);
  }
  assert.deepEqual(chamadas, ['api.ts:1']);
  assert.match(ler('api.ts'), /catch \{\n\s*throw new ApiError\('network_error', undefined, 'network_error'\);/);
});

test('o código da falha de rede tem tradução nas três línguas', async () => {
  const { DICT } = await import('../src/i18n.ts');
  const e = (DICT as Record<string, Record<string, string>>)['err.network_error'];
  for (const l of ['en', 'pt', 'es']) assert.ok(e?.[l], `err.network_error sem ${l}`);
});
