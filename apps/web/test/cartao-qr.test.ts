import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tituloDaMesa, trilhoDoCartao, urlDaMesa, ORIGEM_DE_PRODUCAO, textoDoCartao, idiomaDoCartao, casaRecebe } from '../src/cartao-qr.ts';
import { DICT } from '../src/i18n.ts';

const prefixo = (l: string) => `Mesa ${l}`;

test('o rótulo da casa sai como ela escreveu; só número puro ganha o prefixo', () => {
  assert.equal(tituloDaMesa('Varanda 1', prefixo), 'Varanda 1');   // era "Mesa Varanda 1" (R3)
  assert.equal(tituloDaMesa('Balcão', prefixo), 'Balcão');
  assert.equal(tituloDaMesa('Mesa 12', prefixo), 'Mesa 12');
  assert.equal(tituloDaMesa('  12 ', prefixo), 'Mesa 12');
  assert.equal(tituloDaMesa('12A', prefixo), '12A');
});

test('o trilho do cartão é o do MERCADO — Pix no Brasil, Bizum na Espanha', () => {
  assert.equal(trilhoDoCartao('br'), 'Pix');
  assert.equal(trilhoDoCartao('es'), 'Bizum');
  assert.equal(trilhoDoCartao(undefined), 'Pix'); // servidor sem `market`: o padrão brasileiro
});

test('o QR aponta pra produção, qualquer que seja a aba do dono', () => {
  assert.equal(urlDaMesa('abc'), `${ORIGEM_DE_PRODUCAO}/?t=abc`);
  assert.match(ORIGEM_DE_PRODUCAO, /^https:\/\//);
});

test('o texto do cartão nomeia o trilho, nos três idiomas — e nenhum outro trilho', () => {
  const k = DICT['qr.scanToPay'] as Record<string, string>;
  for (const l of ['en', 'pt', 'es']) {
    assert.match(k[l], /\{rail\}/, `${l}: o cartão precisa nomear o trilho do mercado`);
    assert.doesNotMatch(k[l], /Pix|Bizum|Google|Apple/, `${l}: trilho fixo no texto do cartão`);
  }
});

test('o censo: nenhum cartão impresso promete carteira, cartão ou saldo da casa', () => {
  // A promessa impressa vincula a casa (CDC art. 30) e dura meses. Ela estava
  // na folha sem condição nenhuma (auditoria da configuração, R1).
  for (const f of ['Qrs.tsx', 'Admin.tsx']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /qr\.perks|admin\.point/, `${f}: a promessa voltou`);
  }
  const qrs = readFileSync(new URL('../src/Qrs.tsx', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../src/Admin.tsx', import.meta.url), 'utf8');
  for (const [nome, src] of [['Qrs', qrs], ['Admin', admin]]) {
    assert.match(src, /urlDaMesa\(/, `${nome}: o QR não passa pela origem de produção`);
    assert.match(src, /tituloDaMesa\(/, `${nome}: o título não passa pela regra do rótulo`);
    assert.doesNotMatch(src, /window\.location\.origin/, `${nome}: o cartão voltou a depender da aba`);
  }
});

test('o CARTÃO fala o idioma do mercado, nunca o da aba (CDC art. 31)', () => {
  // A interface é inglês por padrão; o cartão de uma casa brasileira sai em
  // português de qualquer jeito (compliance, PR #20, HIGH-1).
  assert.equal(idiomaDoCartao('br'), 'pt');
  assert.equal(idiomaDoCartao(undefined), 'pt');
  assert.equal(idiomaDoCartao('es'), 'es');
  assert.equal(textoDoCartao(DICT['qr.scanToPay'], 'br', { rail: 'Pix' }), 'Escaneie para ver a conta, dividir e pagar no Pix');
  assert.equal(textoDoCartao(DICT['qrs.tableTitle'], 'br', { label: '12' }), 'Mesa 12');
  assert.match(textoDoCartao(DICT['qr.scanToPay'], 'es', { rail: 'Bizum' }), /pagar con Bizum$/);
  assert.match(textoDoCartao(DICT['admin.trainingStamp'], 'br'), /não aceita pagamento; pague no caixa/);
});

test('a casa recebe? — recebedor no Brasil, conta Stripe na Espanha', () => {
  assert.equal(casaRecebe({ market: 'br', pspRecipientId: 're_abc' }), true);
  assert.equal(casaRecebe({ market: 'br', pspRecipientId: 'rp_mock1' }), true);
  assert.equal(casaRecebe({ market: 'br', pspRecipientId: null }), false);
  assert.equal(casaRecebe({ market: 'br', pspRecipientId: 'rcpt_demo' }), false);
  assert.equal(casaRecebe({ market: 'es', pspRecipientId: 're_abc', stripeAccountId: null }), false);
  assert.equal(casaRecebe({ market: 'es', stripeAccountId: 'acct_123' }), true);
  assert.equal(casaRecebe(null), false);
});

test('os cartões usam `textoDoCartao` (o idioma do mercado), não o `t()` da interface, e só imprimem se a casa recebe', () => {
  const qrs = readFileSync(new URL('../src/Qrs.tsx', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../src/Admin.tsx', import.meta.url), 'utf8');
  const card = qrs.slice(qrs.indexOf('function QrCard('));
  const printCard = admin.slice(admin.indexOf('function PrintCard('));
  for (const [nome, src] of [['QrCard', card], ['PrintCard', printCard]]) {
    assert.doesNotMatch(src, /\bt\('qr\.scanToPay'|\bt\('qrs\.tableTitle'|\bt\('admin\.trainingStamp'/, `${nome}: texto do cartão no idioma da aba`);
    assert.match(src, /textoDoCartao\(DICT\['qr\.scanToPay'\]/, `${nome}: sem o texto do cartão pelo mercado`);
  }
  assert.match(qrs, /disabled=\{printable\.length === 0 \|\| !casaRecebe\(data\.venue\)\}/, 'a folha imprime sem a casa receber');
  assert.match(printCard, /disabled=\{!table\.training && !casaRecebe\(venue\)\}/, 'o avulso imprime sem a casa receber');
  assert.match(printCard, /\{!table\.training && <p className="muted small">\{textoDoCartao\(DICT\['qr\.scanToPay'\]/, 'o cartão de treino promete pagar');
});
