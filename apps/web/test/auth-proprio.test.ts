import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// O auth é do PRÓPRIO Racha (decidido pelo dono em 2026-09-24): o login do
// Seatable fazia do dono de restaurante um usuário do Seatable sem avisar
// (CLAUDE.md, inegociável #10) e mostrava o endereço do projeto dele no Google.
const SRC = new URL('../src/', import.meta.url);
const ler = (f: string) => readFileSync(new URL(f, SRC), 'utf8');

test('o auth aponta pro projeto do Racha, e nada no web cita o projeto do Seatable', () => {
  assert.match(ler('auth.ts'), /export const AUTH_URL = 'https:\/\/worttfotxasxqjaqwpjf\.supabase\.co'/);
  for (const f of readdirSync(SRC)) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    assert.doesNotMatch(ler(f), /ckforlwdhewexyqljsaf/, `${f} ainda aponta pro Supabase do Seatable`);
  }
});

test('o portão é um <form> — o Enter passa pela mesma régua do botão', () => {
  const gate = ler('Gate.tsx');
  assert.match(gate, /<form className="card"[^>]*onSubmit=/);
  assert.doesNotMatch(gate, /onKeyDown=\{\(e\) => e\.key === 'Enter' && submit\(\)\}/, 'o Enter voltou a enviar sem conferir');
  assert.match(gate, /if \(!podeEnviar\) return;/);
});

test('o Google só aparece com o cliente OAuth do próprio Racha ligado', () => {
  assert.match(ler('Gate.tsx'), /\{GOOGLE_LIGADO && \(/);
  assert.match(ler('auth.ts'), /export const GOOGLE_LIGADO = false;/);
});

test('o link de "esqueci a senha" leva a trocar a senha — pela troca de código, não por um parâmetro na URL', () => {
  const auth = ler('auth.ts');
  assert.match(auth, /\.redirectType === 'recovery'\) marcarRecuperacao\(true\)/);
  assert.match(auth, /evento === 'PASSWORD_RECOVERY'/);
  assert.doesNotMatch(auth, /p\.get\('type'\) === 'recovery'/, 'a marca voltou a vir de um parâmetro que qualquer um põe na URL');
  assert.match(auth, /supabase\.auth\.updateUser\(\{ password \}\)/);
  const gate = ler('Gate.tsx');
  assert.match(gate, /if \(authed && recuperando\) return <SenhaNova/);
  assert.match(gate, /t\('gate\.resetFor'/, 'a tela de senha nova não diz DE QUEM é a conta');
});

test('PKCE, não implícito: token no hash da URL NUNCA vira sessão (segurança, PR #22, HIGH-1)', () => {
  const auth = ler('auth.ts');
  assert.match(auth, /flowType: 'pkce'/);
  assert.doesNotMatch(auth, /flowType: 'implicit'/);
  assert.doesNotMatch(auth, /setSession\(/, 'um par de tokens vindo da URL voltou a abrir sessão');
  assert.match(auth, /exchangeCodeForSession\(code\)/);
});

test('erro do auth sai como código traduzido — nunca a frase em inglês do GoTrue', () => {
  const auth = ler('auth.ts');
  assert.doesNotMatch(auth, /new Error\(error\.message\)/);
  const dict = ler('i18n.ts');
  for (const c of ['invalid_credentials', 'email_not_confirmed', 'user_already_exists', 'weak_password', 'over_email_send_rate_limit']) {
    assert.match(dict, new RegExp(`'err\\.auth_${c}':`), `sem tradução pra auth_${c}`);
  }
});
