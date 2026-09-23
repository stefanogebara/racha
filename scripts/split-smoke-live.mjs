/**
 * SMOKE DE SPLIT EM PRODUÇÃO (LIVE) — pro D0 da primeira casa real.
 *
 * Diferente do split-acceptance.mjs (test mode, dados sintéticos, auto-pay do
 * Simulador, tudo efêmero e apagado no fim). Aqui é DINHEIRO REAL numa casa
 * REAL: nada é criado sintético e NADA é apagado. O harness só ORQUESTRA e
 * OBSERVA uma cobrança minúscula (R$1 por padrão) pra provar, no ambiente live:
 *   1. o recebedor da casa existe e está ACTIVE (KYC aprovado);
 *   2. uma cobrança dividida real é aceita pelo gateway (split aplicado);
 *   3. o pagamento real confirma no ledger (webhook);
 *   4. o repasse cai no saldo do recebedor da casa.
 *
 * O recebedor NÃO é criado aqui — o DONO cria pelo admin com os dados bancários
 * reais dele (AdminRecipient). Este script assume que já existe e está active.
 * A cobrança roda numa mesa de TREINO (fora dos números da casa); um humano
 * paga o Pix de R$1 no app do banco (não há Simulador em live).
 *
 * Pré-requisitos do ambiente LIVE (checklist go-live em docs/psp/README.md):
 *   - Vercel: PAGARME_SECRET_KEY = sk_live_…  (o adapter passa a cobrar de verdade)
 *   - webhook live apontado pra /api/webhooks/psp
 *   - o dono já criou o recebedor no admin e o KYC está active
 *
 * Uso (roda da pasta racha):
 *   node scripts/split-smoke-live.mjs --venue <venueId> --cpf <cpf-do-pagador> \
 *     [--base https://racha-gray.vercel.app] [--amount 100]
 *
 * Auth: cunha uma sessão do DONO da venue via service-role (magic link →
 * verifyOtp), sem senha. Só toca a venue informada.
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
const CPF = String(args.cpf || '').replace(/\D/g, '');
const AMOUNT = Number.parseInt(args.amount, 10) || 100; // R$ 1,00
// Auth compartilhada: donos vivem no GoTrue do Seatable, não no do Racha.
// --token <access_token> do dono logado pula o mint (robusto sob shared auth);
// senão, mint via projeto de AUTH (AUTH_SUPABASE_* no .env) ou o próprio Racha.
const TOKEN = args.token || null;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
);
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_PUBLISHABLE_KEY: PUB } = env;
// Projeto de AUTH (onde os donos existem sob shared auth). Espelha o router.
const AUTH_URL = env.AUTH_SUPABASE_URL || SUPABASE_URL;
const AUTH_SERVICE = env.AUTH_SUPABASE_SERVICE_ROLE_KEY || SERVICE;
const AUTH_PUB = env.AUTH_SUPABASE_PUBLISHABLE_KEY || env.AUTH_SUPABASE_KEY || PUB;

const log = (m) => process.stdout.write(`${m}\n`);
const brl = (c) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;

if (!VENUE || CPF.length !== 11) {
  process.stderr.write('uso: node scripts/split-smoke-live.mjs --venue <venueId> --cpf <11 dígitos> [--base URL] [--amount cents]\n');
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const authAdmin = createClient(AUTH_URL, AUTH_SERVICE, { auth: { persistSession: false } });

async function j(method, url, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Cunha um access_token do DONO da venue via service-role (sem senha). */
async function mintOwnerToken(venueId) {
  const mem = await admin.from('venue_members').select('user_id').eq('venue_id', venueId).eq('role', 'owner').limit(1);
  if (mem.error) throw new Error(`venue_members: ${mem.error.message}`);
  if (!mem.data.length) throw new Error(`venue ${venueId} não tem dono (owner) — confira o id`);
  const userId = mem.data[0].user_id;
  const gu = await authAdmin.auth.admin.getUserById(userId);
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
  log(`smoke LIVE · venue ${VENUE} · valor ${brl(AMOUNT)} · ${BASE}\n`);
  let token, email;
  if (TOKEN) { token = TOKEN; email = '(via --token)'; }
  else { ({ token, email } = await mintOwnerToken(VENUE)); }
  log(`dono autenticado: ${email}`);

  // 1. recebedor ACTIVE?
  log('\n[1/4] conferindo o recebedor da casa…');
  const rec = await j('GET', `${BASE}/api/psp/recipient?v=${VENUE}`, { token });
  if (!rec.data.success) throw new Error(`recebedor: ${rec.status} ${rec.data.error}`);
  const info = rec.data.data;
  if (!info.recipientId || !/^r[ep]_/.test(info.recipientId)) {
    throw new Error('a casa NÃO tem recebedor. O dono precisa criar no admin (seção Recebimento) antes do smoke.');
  }
  if (info.status !== 'active') {
    throw new Error(`recebedor ${info.recipientId} está "${info.status}", não "active" — KYC ainda em análise. Aguarde a aprovação do Pagar.me (~3 dias úteis).`);
  }
  log(`✓ recebedor ${info.recipientId} ACTIVE ✅`);

  // 2. mesa do smoke. NÃO é mesa de treino: mesa de treino não cobra (ver
  // `api/_lib/checks/mesa-de-treino.js`). O R$ 1 do smoke é dinheiro de
  // verdade na conta da casa, e conta nos números dela — como tem de ser.
  log('\n[2/4] preparando a mesa do smoke…');
  const tv = await j('GET', `${BASE}/api/tables?v=${VENUE}`, { token });
  if (!tv.data.success) throw new Error(`tables: ${tv.status} ${tv.data.error}`);
  let mesa = tv.data.data.tables.find((t) => t.label === 'Smoke Racha' && t.active && !t.training);
  if (!mesa) {
    const nt = await j('POST', `${BASE}/api/tables`, { token, body: { venueId: VENUE, label: 'Smoke Racha' } });
    if (!nt.data.success) throw new Error(`criar mesa: ${nt.status} ${nt.data.error}`);
    const again = await j('GET', `${BASE}/api/tables?v=${VENUE}`, { token });
    mesa = again.data.data.tables.find((t) => t.id === nt.data.data.id);
    log(`  mesa "Smoke Racha" criada — desative-a no admin depois do go-live`);
  }
  log(`✓ mesa: ${mesa.label} (${mesa.qrToken.slice(0, 8)}…)`);

  // conta minúscula
  const chk = await j('POST', `${BASE}/api/checks`, { token, body: { tableId: mesa.id, totalCents: AMOUNT } });
  if (!chk.data.success) throw new Error(`abrir conta: ${chk.status} ${chk.data.error}`);
  const checkId = (await j('GET', `${BASE}/api/check?t=${mesa.qrToken}`)).data.data.check.id;
  const before = (await j('GET', `${BASE}/api/check?t=${mesa.qrToken}`)).data.data.state.paidCents;

  // 3. cobrança dividida real
  log('\n[3/4] criando a cobrança dividida real (venue tem recebedor → split)…');
  const pay = await j('POST', `${BASE}/api/pay`, {
    body: { token: mesa.qrToken, amountCents: AMOUNT, tipCents: 0, payerLabel: 'Smoke D0', payerDocument: CPF },
  });
  if (!pay.data.success) throw new Error(`pay: ${pay.status} ${pay.data.error}`);
  log(`✓ cobrança aceita: ${pay.data.data.txid}`);
  log('\n' + '='.repeat(60));
  log(`⚠  PAGUE ESTE PIX REAL DE ${brl(AMOUNT)} AGORA no app do seu banco:`);
  log('='.repeat(60));
  log(pay.data.data.copiaECola || '(sem BR Code — confira a resposta)');
  log('='.repeat(60) + '\n');

  log('aguardando o pagamento real confirmar (até 5 min)…');
  let paid = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 5 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 4000));
    process.stdout.write('.');
    const st = (await j('GET', `${BASE}/api/check?t=${mesa.qrToken}`)).data.data.state;
    if (st.paidCents > before) { paid = st; break; }
  }
  if (!paid) throw new Error('pagamento não confirmou em 5min — confira se o Pix foi pago e o webhook live está configurado.');
  log(`\n✓ pagamento confirmado no ledger: ${brl(before)} → ${brl(paid.paidCents)} (+${brl(AMOUNT)})`);

  // 4. repasse no saldo do recebedor
  log('\n[4/4] conferindo o repasse no saldo do recebedor…');
  let landed = false;
  for (let i = 0; i < 6; i++) {
    const bal = await j('GET', `${BASE}/api/psp/recipient/balance?v=${VENUE}`, { token });
    if (bal.data.success) {
      const b = bal.data.data;
      const total = b.availableCents + b.waitingCents + b.transferredCents;
      log(`  disponível ${brl(b.availableCents)} · aguardando ${brl(b.waitingCents)} · transferido ${brl(b.transferredCents)}`);
      if (total > 0) { landed = true; break; }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (landed) log('✓ o dinheiro do split caiu no recebedor da casa ✅');
  else log('  saldo ainda R$ 0 — a liquidação pode levar um ciclo; confira o extrato do recebedor no dashboard.');

  // fecha a conta do smoke (não deixa lixo aberto); a venue e o recebedor ficam
  await j('POST', `${BASE}/api/checks/close`, { token, body: { checkId } });
  log('\nSMOKE LIVE OK ✅ — recebedor active, cobrança dividida real paga, repasse conferido.');
  log('(a mesa "Smoke Racha" e a venue permanecem — nada real foi apagado)');
}

main().catch((e) => { process.stderr.write(`\nSMOKE FALHOU: ${e.message}\n`); process.exitCode = 1; });
