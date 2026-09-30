import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { destinoDoLinkDoEmail as destino } from '../src/link-do-email.ts';

const AUTH = 'https://worttfotxasxqjaqwpjf.supabase.co';
const HASH = 'a'.repeat(56);

test('o botão do e-mail repassa pro verify do projeto, com o redirect FIXO desta origem', () => {
  for (const tipo of ['signup', 'recovery', 'email_change']) {
    for (const token of [HASH, `pkce_${HASH}`]) {
      const d = destino(`https://useracha.app/admin?token_hash=${token}&type=${tipo}`, AUTH);
      assert.ok(d, `${tipo} ${token.slice(0, 5)}`);
      const u = new URL(d!);
      assert.equal(u.origin, AUTH);
      assert.equal(u.pathname, '/auth/v1/verify');
      assert.equal(u.searchParams.get('token'), token);
      assert.equal(u.searchParams.get('type'), tipo);
      assert.equal(u.searchParams.get('redirect_to'), 'https://useracha.app/admin');
    }
  }
});

test('o redirect_to NUNCA vem da URL — nem de um parâmetro plantado', () => {
  const d = destino(`https://useracha.app/admin?token_hash=${HASH}&type=signup&redirect_to=https://mal.example`, AUTH)!;
  assert.deepEqual(new URL(d).searchParams.getAll('redirect_to'), ['https://useracha.app/admin']);
});

test('sem token válido ou com tipo fora da lista, a página fica onde está', () => {
  for (const q of [
    '', '?code=abc', `?token_hash=${HASH}`, '?type=signup',
    `?token_hash=${HASH}&type=magiclink`, `?token_hash=${HASH}&type=invite`,
    '?token_hash=curto&type=signup', `?token_hash=${HASH}%26type%3Dx&type=signup`,
    `?token_hash=${HASH.toUpperCase()}Z&type=signup`,
  ]) assert.equal(destino(`https://useracha.app/admin${q}`, AUTH), null, q);
  assert.equal(destino('não é url', AUTH), null);
});

// Os modelos que o Supabase envia: nenhum aponta pro endereço do projeto.
test('os três e-mails do auth apontam pro useracha.app, com o tipo que a página aceita', () => {
  const DIR = new URL('../../../supabase/templates/', import.meta.url);
  const esperado: Record<string, string> = { 'confirmation.html': 'signup', 'recovery.html': 'recovery', 'email_change.html': 'email_change' };
  const html = readdirSync(DIR).filter((f) => f.endsWith('.html'));
  assert.deepEqual(html.sort(), Object.keys(esperado).sort());
  for (const f of html) {
    const s = readFileSync(new URL(f, DIR), 'utf8');
    assert.doesNotMatch(s, /ConfirmationURL|supabase\.co/, `${f} voltou a mandar o endereço do Supabase`);
    assert.ok(s.includes(`href="https://useracha.app/admin?token_hash={{ .TokenHash }}&amp;type=${esperado[f]}"`), f);
  }
});

test('o auth repassa ANTES de olhar o ?code=, e continua sem abrir sessão de token da URL', () => {
  const auth = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
  assert.match(auth, /const destino = destinoDoLinkDoEmail\(window\.location\.href, AUTH_URL\);\s*if \(destino\) \{ window\.location\.replace\(destino\);/);
  assert.ok(auth.indexOf('destinoDoLinkDoEmail(window') < auth.indexOf("searchParams.get('code')"));
  assert.doesNotMatch(auth, /verifyOtp|setSession\(/);
});
