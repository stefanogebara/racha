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

test('a landing fala com quem está na mesa e deixa o teclado pular a demo (L8, L9)', () => {
  assert.match(home, /<p className="namesa">\{t\('land\.dinerHint'\)\}<\/p>/);
  const pular = home.indexOf('<a className="pular" href="#passos">');
  const iframe = home.indexOf('<iframe');
  assert.ok(pular > -1 && pular < iframe, 'o "pular a demo" tem de vir ANTES do iframe');
  assert.match(home, /id="passos" tabIndex=\{-1\}/);
});

test('a coluna "Como" some pela classe, e o rodapé não a conta (L6)', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.razao t[hd]:nth-child\(3\)/);
  assert.doesNotMatch(home, /className="quem" colSpan=\{3\}/);
});

test('o extrato da carteira traduz pelo tipo e não mostra frase do servidor (PR #31, M-3)', () => {
  const w = readFileSync(new URL('../src/Wallet.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(w, /entry\.label/);
  assert.match(w, /redeem_reversed: 'ledger\.redeemReversed'/);
  assert.match(w, /t\(key \|\| 'ledger\.other'\)/);
});

test('a carteira adota o idioma da casa quando ninguém escolheu (ALTA C1)', () => {
  const w = readFileSync(new URL('../src/Wallet.tsx', import.meta.url), 'utf8');
  assert.match(w, /adotarPadraoDaCasa\(v\.venue\.defaultLang\)/);
});
