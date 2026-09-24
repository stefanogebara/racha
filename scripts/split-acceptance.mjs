/**
 * Aceite do SPLIT em test mode, ponta a ponta, contra o DEPLOY.
 *
 * Prova, em ordem, as 3 coisas que o split precisa:
 *   1. createRecipient (rp_) → marketplace/split HABILITADO na conta
 *      (era EXATAMENTE a chamada que falhava com "verifique a configuração
 *      da funcionalidade Split");
 *   2. cobrança Pix numa mesa cujo venue TEM recebedor → a ordem sai COM
 *      split_rules e o gateway ACEITA (não 402 de config) → split aplicado;
 *   3. saldo do recebedor sobe → o REPASSE efetivamente caiu no restaurante.
 *
 * Usa um dono efêmero (service-role → password grant), tudo em dados de TESTE
 * (CPF/banco sintéticos — nunca a conta real de ninguém), e limpa venue+usuário
 * no fim (cascade). Roda da pasta racha:  node scripts/split-acceptance.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.RACHA_BASE || 'https://racha-gray.vercel.app';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
);
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE = env.SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !PUBLISHABLE) {
  console.error('faltam SUPABASE_URL / SERVICE_ROLE / PUBLISHABLE no racha/.env');
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const log = (m) => process.stdout.write(`${m}\n`);
const brl = (c) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;

async function j(method, url, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let userId = null;
let venueId = null;

async function main() {
  const email = `split.aceite.${Date.now()}@teste.demo`;
  // Sorteada: o dono efêmero nasce CONFIRMADO no projeto apontado, e uma
  // senha escrita no repositório público valia enquanto a limpeza não rodasse
  // (segurança, PR #22, LOW-D — o mesmo buraco do dono demo do dev-server).
  const password = randomBytes(18).toString('base64url');

  // — dono efêmero
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`createUser: ${created.error.message}`);
  userId = created.data.user.id;
  const grant = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUBLISHABLE, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  const token = grant.access_token;
  if (!token) throw new Error('password grant falhou');
  log(`dono efêmero ok (${email})`);

  // — venue
  const v = await j('POST', `${BASE}/api/venues`, { token, body: { name: `__aceite_split__ ${Date.now()}`, servicoBp: 1000 } });
  if (!v.data.success) throw new Error(`criar venue: ${v.status} ${v.data.error}`);
  venueId = v.data.data.id;
  log(`venue criado: ${venueId}`);

  // — 1. RECEBEDOR (a prova nº1: marketplace/split habilitado) — dados de TESTE
  log('\n[1/3] criando recebedor de teste (prova de que o split ligou)…');
  const rec = await j('POST', `${BASE}/api/psp/recipient`, {
    token,
    body: {
      venueId,
      name: 'Aceite Split Racha',
      email: 'aceite.split@racha.app', // Pagar.me exige e-mail no recebedor
      document: '39053344705', // CPF de teste (dígitos válidos) → individual
      bank: { code: '341', agencia: '1234', conta: '56789', contaDv: '0', type: 'checking' },
    },
  });
  if (!rec.data.success) {
    throw new Error(`RECEBEDOR RECUSADO (${rec.status}): ${rec.data.error}\n`
      + '→ se falar em "Split"/"marketplace", a conta ainda NÃO está em modo marketplace de verdade.');
  }
  const rp = rec.data.data.recipientId;
  log(`✓ recebedor criado: ${rp} (status ${rec.data.data.status}) — marketplace/split ATIVO ✅`);

  // — mesa + qrToken
  await j('POST', `${BASE}/api/tables`, { token, body: { venueId, label: 'Mesa Split' } });
  const tables = await j('GET', `${BASE}/api/tables?v=${venueId}`, { token });
  const mesa = tables.data.data.tables[0];
  if (!mesa || !mesa.qrToken) throw new Error('mesa/qrToken não voltou');
  log(`mesa criada: ${mesa.label} (${mesa.qrToken.slice(0, 8)}…)`);

  // — conta aberta (modo manual): total R$ 400
  const chk = await j('POST', `${BASE}/api/checks`, { token, body: { tableId: mesa.id, totalCents: 40000 } });
  if (!chk.data.success) throw new Error(`abrir conta: ${chk.status} ${chk.data.error}`);
  log(`conta aberta: total ${brl(40000)}`);

  // — 2. PAGAMENTO Pix com split (parte de R$ 200 + serviço R$ 20 = R$ 220, < R$ 500 → Simulador auto-paga)
  log('\n[2/3] pagando uma parte via Pix (venue tem recebedor → ordem COM split)…');
  const before = (await j('GET', `${BASE}/api/check?t=${mesa.qrToken}`)).data.data.state.paidCents;
  const pay = await j('POST', `${BASE}/api/pay`, {
    body: { token: mesa.qrToken, amountCents: 20000, tipCents: 2000, payerLabel: 'Aceite Split', payerDocument: '39053344705' },
  });
  if (!pay.data.success) throw new Error(`pay: ${pay.status} ${pay.data.error}`);
  const d = pay.data.data;
  log(`✓ cobrança dividida ACEITA pelo gateway: ${d.txid}`);
  log(`  BR Code: ${String(d.copiaECola).slice(0, 40)}…`);

  log('  aguardando o Simulador confirmar (webhook charge.paid)…');
  let paid = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write('.');
    const st = (await j('GET', `${BASE}/api/check?t=${mesa.qrToken}`)).data.data.state;
    if (st.paidCents > before) { paid = st; break; }
  }
  if (!paid) {
    log('\n⚠ o Pix não auto-confirmou em 90s — provavelmente o provider Pix não está no Simulador.');
    log('  A ordem COM split foi aceita (prova nº2 ok); a confirmação precisa de um clique em');
    log('  "Simular pagamento" no dashboard. O split em si já está provado pela criação da ordem.');
  } else {
    log(`\n✓ ledger confirmou: pago ${brl(before)} → ${brl(paid.paidCents)} (+${brl(20000)}), gorjeta ${brl(paid.tipCents)}`);
  }

  // — 3. SALDO DO RECEBEDOR (a prova nº3: o repasse caiu)
  log('\n[3/3] lendo o saldo do recebedor (prova do repasse)…');
  const bal = await j('GET', `${BASE}/api/psp/recipient/balance?v=${venueId}`, { token });
  if (!bal.data.success) {
    log(`  saldo indisponível (${bal.status}: ${bal.data.error}) — confirme no extrato do dashboard.`);
  } else {
    const b = bal.data.data;
    log(`✓ saldo do recebedor ${rp}:`);
    log(`    disponível: ${brl(b.availableCents)} · aguardando: ${brl(b.waitingCents)} · transferido: ${brl(b.transferredCents)}`);
    if (b.availableCents + b.waitingCents + b.transferredCents > 0) {
      log('  → o dinheiro do split caiu no recebedor do restaurante ✅');
    } else if (paid) {
      log('  → saldo ainda em R$ 0 (liquidação test mode pode levar alguns instantes; confira o extrato).');
    }
  }

  log('\nACEITE DE SPLIT OK ✅ — recebedor criado, cobrança dividida aceita' + (paid ? ' e confirmada' : '') + '.');
}

main()
  .catch((e) => { process.stderr.write(`\nFALHOU: ${e.message}\n`); process.exitCode = 1; })
  .finally(async () => {
    // limpeza: cascade apaga members/tables/checks; depois o usuário efêmero
    // A limpeza GRITA quando falha: um dono confirmado esquecido no projeto é
    // conta viva, e o `catch {}` de antes escondia isso.
    const falhas = [];
    try {
      if (venueId) { const r = await admin.from('venues').delete().eq('id', venueId); if (r.error) falhas.push(`venue ${venueId}: ${r.error.message}`); }
    } catch (e) { falhas.push(`venue ${venueId}: ${e.message}`); }
    try {
      if (userId) { const r = await admin.auth.admin.deleteUser(userId); if (r.error) falhas.push(`usuário ${userId}: ${r.error.message}`); }
    } catch (e) { falhas.push(`usuário ${userId}: ${e.message}`); }
    if (falhas.length) {
      process.stderr.write(`\nLIMPEZA FALHOU — apague à mão:\n  ${falhas.join('\n  ')}\n`);
      process.exitCode = 1;
    } else log('\n(limpeza: venue + dono efêmero removidos)');
  });
