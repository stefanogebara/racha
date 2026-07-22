/**
 * PREFLIGHT LIVE (read-only) — checa se o smoke de D0 vai passar, SEM cobrar nada.
 *
 * Roda os passos read-only do split-smoke-live.mjs (mint de sessão do dono via
 * service-role + status do recebedor + saldo + mesas), mas PARA antes de abrir
 * conta ou criar cobrança. Zero dinheiro, zero efeito. Serve pra saber, antes de
 * pedir o R$1 real, se o recebedor existe e está `active` (KYC aprovado) e se o
 * app está falando com o Pagar.me live.
 *
 * Uso (da pasta racha):
 *   node scripts/preflight-live.mjs --venue <venueId> [--base https://racha-gray.vercel.app]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const BASE = args.base || 'https://racha-gray.vercel.app';
const VENUE = args.venue;
// Auth compartilhada: os donos vivem no GoTrue do Seatable, não no do Racha.
// --token <access_token> do dono logado pula o mint (jeito robusto sob shared
// auth). Sem ele, mint via projeto de AUTH (AUTH_SUPABASE_* ou o próprio Racha).
const TOKEN = args.token || null;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
);
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_PUBLISHABLE_KEY: PUB } = env;
// Projeto de AUTH (onde os donos realmente existem). Espelha o router:
// AUTH_SUPABASE_* → Seatable; ausente → cai no próprio Racha (auth antiga).
const AUTH_URL = env.AUTH_SUPABASE_URL || SUPABASE_URL;
const AUTH_SERVICE = env.AUTH_SUPABASE_SERVICE_ROLE_KEY || SERVICE;
const AUTH_PUB = env.AUTH_SUPABASE_PUBLISHABLE_KEY || env.AUTH_SUPABASE_KEY || PUB;

const log = (m) => process.stdout.write(`${m}\n`);
const brl = (c) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;

if (!VENUE) {
  process.stderr.write('uso: node scripts/preflight-live.mjs --venue <venueId> [--base URL]\n');
  process.exit(2);
}

// Racha DB: quem é o dono (venue_members). Projeto de AUTH: gerar a sessão.
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const authAdmin = createClient(AUTH_URL, AUTH_SERVICE, { auth: { persistSession: false } });

async function j(method, url, { token } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function mintOwnerToken(venueId) {
  const mem = await admin.from('venue_members').select('user_id').eq('venue_id', venueId).eq('role', 'owner').limit(1);
  if (mem.error) throw new Error(`venue_members: ${mem.error.message}`);
  if (!mem.data.length) throw new Error(`venue ${venueId} não tem dono (owner) — confira o id`);
  const gu = await authAdmin.auth.admin.getUserById(mem.data[0].user_id);
  if (gu.error || !gu.data.user?.email) throw new Error('dono não encontrado no projeto de AUTH — configure AUTH_SUPABASE_* no .env, ou passe --token');
  const email = gu.data.user.email;
  const link = await authAdmin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error) throw new Error(`generateLink: ${link.error.message}`);
  const anon = createClient(AUTH_URL, AUTH_PUB, { auth: { persistSession: false } });
  const v = await anon.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'email' });
  const token = v.data?.session?.access_token;
  if (!token) throw new Error(`verifyOtp não devolveu sessão: ${v.error?.message || '?'}`);
  return { token, email };
}

async function main() {
  log(`preflight LIVE (read-only) · venue ${VENUE} · ${BASE}\n`);
  let token, email;
  if (TOKEN) { token = TOKEN; email = '(via --token)'; }
  else { ({ token, email } = await mintOwnerToken(VENUE)); }
  log(`✓ dono autenticado: ${email}`);

  // Recebedor
  const rec = await j('GET', `${BASE}/api/psp/recipient?v=${VENUE}`, { token });
  if (!rec.data.success) throw new Error(`recebedor: ${rec.status} ${rec.data.error}`);
  const info = rec.data.data;
  const hasReal = info.recipientId && /^r[ep]_/.test(info.recipientId);
  const active = info.status === 'active';
  log(`\nRECEBEDOR: ${info.recipientId || '(nenhum)'}  status=${info.status || '—'}`);
  if (!hasReal) log('  ✗ a casa ainda NÃO tem recebedor real — crie no admin (seção Recebimento).');
  else if (!active) log(`  ⏳ em KYC ("${info.status}") — o smoke exige "active". Aguarde a aprovação do Pagar.me (~3 dias úteis).`);
  else log('  ✅ ACTIVE — pronto pro smoke.');

  // Saldo (prova indireta de que o app fala com o Pagar.me live)
  if (hasReal) {
    const bal = await j('GET', `${BASE}/api/psp/recipient/balance?v=${VENUE}`, { token });
    if (bal.data.success && bal.data.data) {
      const b = bal.data.data;
      log(`SALDO: disponível ${brl(b.availableCents || 0)} · a caminho ${brl(b.waitingCents || 0)} · já repassado ${brl(b.transferredCents || 0)}`);
    } else {
      log(`SALDO: indisponível (${bal.status} ${bal.data.error || ''}) — normal se o recebedor é novíssimo.`);
    }
  }

  // Mesa de treino (o smoke usa/cria uma)
  const tv = await j('GET', `${BASE}/api/tables?v=${VENUE}`, { token });
  const tables = tv.data?.data?.tables || [];
  const treino = tables.filter((t) => t.training && t.active).length;
  log(`\nMESAS: ${tables.length} no total · ${treino} de treino ativa(s) ${treino ? '✓' : '(o smoke cria uma "Smoke Racha")'}`);

  log('\n──────────────────────────────────────────');
  if (hasReal && active) {
    log('VEREDITO: ✅ tudo pronto — pode rodar o smoke:');
    log(`  node scripts/split-smoke-live.mjs --venue ${VENUE} --cpf <seu-cpf> --amount 100`);
  } else if (hasReal && !active) {
    log('VEREDITO: ⏳ recebedor em KYC — rode o preflight de novo quando aprovar, aí o smoke.');
  } else {
    log('VEREDITO: ✗ falta criar o recebedor no admin (seção Recebimento) — depois rode o preflight.');
  }
}

main().catch((e) => { process.stderr.write(`\n✗ preflight falhou: ${e.message}\n`); process.exit(1); });
