'use strict';

/**
 * Aceite do Pagar.me em TEST MODE, rodando contra o DEPLOY (o sk_ vive só na
 * Vercel; este script usa apenas a chave PUBLICÁVEL + as rotas públicas do
 * app — nenhum segredo aqui).
 *
 *   node scripts/psp-acceptance.js \
 *     --base https://racha-gray.vercel.app \
 *     --mesa <qrToken da mesa com conta aberta> \
 *     --pk pk_test_... \
 *     [--leg pix|card|decline|all]
 *
 * Pernas:
 *  card    → tokeniza cartão de teste APROVADO no endpoint público /tokens,
 *            paga via POST /api/pay (wallet google_pay), espera o webhook
 *            charge.paid confirmar no ledger (poll /api/check).
 *  decline → cartão de teste RECUSADO → espera 402 e ledger intacto.
 *  pix     → cria a cobrança, imprime o BR Code + txid e fica pollando:
 *            o "Simular pagamento" é um clique no dashboard (test mode não
 *            tem API pública pra isso) — o script detecta o webhook chegar.
 *
 * Cartões de teste Pagar.me: final 0010 aprova, 0002 recusa (docs).
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const BASE = args.base || 'https://racha-gray.vercel.app';
const MESA = args.mesa;
const PK = args.pk;
const LEG = args.leg || 'all';

if (!MESA || !PK) {
  process.stderr.write('uso: node scripts/psp-acceptance.js --base URL --mesa QRTOKEN --pk pk_test_...\n');
  process.exit(2);
}

async function j(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function checkState() {
  const r = await j('GET', `${BASE}/api/check?t=${MESA}`);
  if (!r.data.success) throw new Error(`check indisponível: ${r.data.error}`);
  return r.data.data.state;
}

async function pollPaidDelta(beforePaid, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await checkState();
    if (st.paidCents > beforePaid) return st;
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write('.');
  }
  return null;
}

/** Tokeniza um cartão de TESTE no endpoint público (só pk — browser-safe). */
async function tokenizeTestCard(number) {
  const r = await j('POST', `https://api.pagar.me/core/v5/tokens?appId=${PK}`, {
    type: 'card',
    card: {
      number,
      holder_name: 'Aceite Racha',
      exp_month: 12,
      exp_year: 2030,
      cvv: '123',
    },
  });
  if (!r.data.id) throw new Error(`tokenização falhou: ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data.id; // token_...
}

async function legCard() {
  process.stdout.write('\n== CARD (aprovado) ==\n');
  const before = (await checkState()).paidCents;
  const tok = await tokenizeTestCard('4000000000000010');
  const pay = await j('POST', `${BASE}/api/pay`, {
    token: MESA, amountCents: 500, tipCents: 100,
    payerLabel: 'Aceite Card', wallet: 'google_pay', paymentToken: tok,
  });
  if (!pay.data.success) throw new Error(`pay falhou: ${pay.status} ${pay.data.error}`);
  process.stdout.write(`charge criada: ${pay.data.data.txid} (method=${pay.data.data.method})\naguardando webhook charge.paid`);
  const st = await pollPaidDelta(before);
  if (!st) throw new Error('webhook não confirmou em 90s — confira o endpoint no dashboard');
  process.stdout.write(`\n✓ ledger confirmou: paid ${before} → ${st.paidCents} (+500), tips agora ${st.tipCents}\n`);
}

async function legDecline() {
  process.stdout.write('\n== CARD (recusado) ==\n');
  const before = (await checkState()).paidCents;
  const tok = await tokenizeTestCard('4000000000000002');
  const pay = await j('POST', `${BASE}/api/pay`, {
    token: MESA, amountCents: 300, tipCents: 0,
    payerLabel: 'Aceite Decline', wallet: 'google_pay', paymentToken: tok,
  });
  if (pay.status !== 402 && pay.data.success !== false) {
    throw new Error(`esperava recusa, veio: ${pay.status} ${JSON.stringify(pay.data).slice(0, 160)}`);
  }
  const after = (await checkState()).paidCents;
  if (after !== before) throw new Error(`recusa moveu dinheiro?! ${before} → ${after}`);
  process.stdout.write(`✓ recusado como esperado (${pay.status}: ${pay.data.error}) e ledger intacto\n`);
}

async function legPix() {
  process.stdout.write('\n== PIX ==\n');
  const before = (await checkState()).paidCents;
  const pay = await j('POST', `${BASE}/api/pay`, {
    token: MESA, amountCents: 700, tipCents: 70, payerLabel: 'Aceite Pix',
  });
  if (!pay.data.success) throw new Error(`pix falhou: ${pay.status} ${pay.data.error}`);
  const d = pay.data.data;
  process.stdout.write(`txid: ${d.txid}\nBR Code (real, começa com 000201): ${String(d.copiaECola).slice(0, 44)}…\n`);
  if (!String(d.copiaECola).startsWith('000201')) {
    process.stdout.write('⚠ BR Code não parece EMV — conferir resposta do adapter\n');
  }
  process.stdout.write('→ AGORA: dashboard (test mode) → Pedidos → essa cobrança → "Simular pagamento".\naguardando webhook');
  const st = await pollPaidDelta(before, 5 * 60 * 1000);
  if (!st) throw new Error('webhook não chegou em 5min');
  process.stdout.write(`\n✓ Pix confirmou no ledger: paid ${before} → ${st.paidCents} (+700)\n`);
}

(async () => {
  const st = await checkState();
  process.stdout.write(`conta: total ${st.totalCents} · pago ${st.paidCents} · status ${st.status}\n`);
  if (LEG === 'card' || LEG === 'all') await legCard();
  if (LEG === 'decline' || LEG === 'all') await legDecline();
  if (LEG === 'pix' || LEG === 'all') await legPix();
  process.stdout.write('\nACEITE OK\n');
})().catch((e) => { process.stderr.write(`\nFALHOU: ${e.message}\n`); process.exit(1); });
