import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tituloDaMesa, trilhoDoCartao, urlDaMesa, ORIGEM_DE_PRODUCAO } from '../src/cartao-qr.ts';
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
