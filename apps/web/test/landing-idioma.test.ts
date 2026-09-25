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

test('HousePay gira a chave de idempotência depois de uma recusa definitiva (PR #35)', () => {
  const src = readFileSync(new URL('../src/HousePay.tsx', import.meta.url), 'utf8');
  // Sem isto, todo toque seguinte reusa a chave de um débito estornado e o
  // servidor recusa pra sempre (RH006) — o cliente fica preso.
  assert.match(src, /if \(code === 'house_raced' \|\| code === 'house_redeem_reversed'\) idemKey\.current = crypto\.randomUUID\(\);/);
  // E NÃO gira em erro de rede/5xx: aí o retry TEM de ser o mesmo débito.
  const bloco = src.slice(src.indexOf('} catch (e) {'), src.indexOf('} finally {'));
  assert.equal((bloco.match(/crypto\.randomUUID\(\)/g) || []).length, 1);
});

test('a empresa da Racha sai de UM lugar, com nome, CNPJ e endereço físico juntos (Decreto 7.962 art. 2º)', () => {
  const empresa = readFileSync(new URL('../src/empresa.ts', import.meta.url), 'utf8');
  assert.match(empresa, /razaoSocial: '65\.087\.663 Stefano Chap Chap Gebara'/);
  assert.match(empresa, /const CNPJ_DA_RACHA = '65087663000130';/);
  assert.match(empresa, /cnpj: formatTaxId\(CNPJ_DA_RACHA\)/);
  const h = readFileSync(new URL('../src/Home.tsx', import.meta.url), 'utf8');
  assert.match(h, /\{EMPRESA\.razaoSocial\} · CNPJ \{EMPRESA\.cnpj\} · \{EMPRESA\.endereco\}/);
  // Endereço FÍSICO (art. 2º II): rua, número e CEP — a cidade sozinha não basta.
  assert.match(empresa, /endereco: 'Rua Professor Artur Ramos, 339 — Jardim Paulistano, São Paulo\/SP, CEP 01454-010'/);
  assert.doesNotMatch(h, /'65087663000130'/, 'o CNPJ voltou a ser escrito à mão na landing');
  const p = readFileSync(new URL('../src/PrivacyNotice.tsx', import.meta.url), 'utf8');
  assert.match(p, /t\('priv\.operator', \{ name: EMPRESA\.razaoSocial/);
});

test('o canal de contato é o de empresa.ts, no rodapé e no aviso — não uma variável solta', () => {
  const empresa = readFileSync(new URL('../src/empresa.ts', import.meta.url), 'utf8');
  assert.match(empresa, /contato: 'contato@useracha\.app'/);
  const h = readFileSync(new URL('../src/Home.tsx', import.meta.url), 'utf8');
  assert.match(h, /href=\{`mailto:\$\{EMPRESA\.contato\}`\}>\{EMPRESA\.contato\}</);
  const p = readFileSync(new URL('../src/PrivacyNotice.tsx', import.meta.url), 'utf8');
  assert.match(p, /const CONTATO = EMPRESA\.contato\.trim\(\);/);
  assert.doesNotMatch(p, /import\.meta\.env\.VITE_PRIVACY_CONTACT/);
});

test('a carteira diz quem emite o saldo e que a Racha não guarda o dinheiro (C3)', () => {
  const w = readFileSync(new URL('../src/Wallet.tsx', import.meta.url), 'utf8');
  assert.equal((w.match(/t\('wallet\.issuer'/g) || []).length, 2);
});
