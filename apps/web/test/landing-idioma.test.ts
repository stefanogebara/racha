import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Auditoria da landing, ALTA L2 (e metade da L1): um dono que lia a landing em
// português pelo `?lang=pt` de um link caía no login do painel em INGLÊS — o
// `?lang` não é gravado, só a escolha pelo seletor. Todo link que sai da
// landing pro produto leva o idioma em que ela está.
const home = readFileSync(new URL('../src/Home.tsx', import.meta.url), 'utf8');

test('nenhum link da landing pro painel ou pra demo sai sem o idioma', () => {
  assert.doesNotMatch(home, /href="\/admin"/);
  assert.doesNotMatch(home, /href=\{DEMO\}/);
  const admin = home.match(/href=\{`\/admin\?lang=\$\{lang\}`\}/g) || [];
  assert.ok(admin.length >= 4, `só ${admin.length} links pro /admin com idioma`);
});

test('o `?lang=` fora do iframe é gravado — o painel troca a query e perderia o idioma', () => {
  const lang = readFileSync(new URL('../src/lang.tsx', import.meta.url), 'utf8');
  assert.match(lang, /if \(params\.get\('embed'\) !== '1'\) \{\s*try \{ localStorage\.setItem\(STORAGE_KEY, url\); \}/);
});
