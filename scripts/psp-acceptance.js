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
 * Cartões de teste Pagar.me (Simulador de Cartão de Crédito, conferido
 * 2026-09-19): `4000000000000010` APROVA e `4000000000000028` RECUSA — aquela
 * página decide pelo NÚMERO e não menciona CVV. A regra do CVV começando em 6
 * existe noutra página (Simulador PSP). Como as duas estão no ar, a perna de
 * recusa usa o número que recusa E o CVV que recusa: assim ela é recusa nos
 * dois simuladores, em vez de depender de qual deles a conta usa.
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
  if (!r.data.success) throw new Error(`check indisponível: ${r.data.code || r.data.error}`);
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

/**
 * Tokeniza um cartão de TESTE no endpoint público (só pk — browser-safe).
 * Simulador do Pagar.me decide o resultado pelo CVV: começar com 6 = recusa
 * pelo emissor; qualquer outro aprova (docs: Simulador de Cartão de Crédito).
 */
async function tokenizeTestCard(number, cvv = '123') {
  const r = await j('POST', `https://api.pagar.me/core/v5/tokens?appId=${PK}`, {
    type: 'card',
    card: {
      number,
      holder_name: 'Aceite Racha',
      exp_month: 12,
      exp_year: 2030,
      cvv,
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
    payerDocument: '39053344705', // CPF de teste com dígitos válidos (docs)
  });
  if (!pay.data.success) throw new Error(`pay falhou: ${pay.status} ${pay.data.code || pay.data.error}`);
  process.stdout.write(`charge criada: ${pay.data.data.txid} (method=${pay.data.data.method})\naguardando webhook charge.paid`);
  const st = await pollPaidDelta(before);
  if (!st) throw new Error('webhook não confirmou em 90s — confira o endpoint no dashboard');
  process.stdout.write(`\n✓ ledger confirmou: paid ${before} → ${st.paidCents} (+500), tips agora ${st.tipCents}\n`);
}

async function legDecline() {
  process.stdout.write('\n== CARD (recusado) ==\n');
  const before = (await checkState()).paidCents;
  // NÚMERO que recusa + CVV que recusa: a perna não depende de qual simulador
  // a conta usa. Antes era `…0010`, que é o cartão de SUCESSO da tabela — numa
  // conta no simulador por número isto CAPTURAVA R$ 3,00 em vez de recusar
  // (nona revisão de compliance, 2026-09-19).
  const tok = await tokenizeTestCard('4000000000000028', '600');
  const pay = await j('POST', `${BASE}/api/pay`, {
    token: MESA, amountCents: 300, tipCents: 0,
    payerLabel: 'Aceite Decline', wallet: 'google_pay', paymentToken: tok,
    payerDocument: '39053344705',
  });
  /**
   * A RECUSA TEM QUE SER IDENTIFICADA POSITIVAMENTE — não "qualquer falha".
   *
   * Duas versões erradas antes desta, e as duas pela mesma razão: eu descrevia
   * o que NÃO conta, e a lista sempre tinha buraco.
   *
   *  1ª: `pay.status !== 402 && pay.data.success !== false`. Qualquer falha
   *      nossa passava — e foi o que aconteceu quando o interruptor da carteira
   *      passou a valer: um 400 `rail_unsupported` tem `success: false`, então
   *      esta perna ficava verde sem nunca falar com a Pagar.me.
   *  2ª: uma lista de códigos NOSSOS pra recusar. Também tinha buraco, e o
   *      buraco era o pior possível: `charge_maybe_captured` é um 502 que quer
   *      dizer **o cartão FOI capturado e a linha não foi escrita**. Ele não
   *      estava na lista, o ledger de fato não se mexe (não há linha), e o
   *      script imprimia "✓ recusado como esperado" e seguia pro `ACEITE OK`.
   *      Um aceite relatando cartão capturado como recusa limpa.
   *
   *  3ª: `status === 402` sozinho. Também errado, e por um motivo que eu tinha
   *      escrito no comentário como se fosse verdade: o adaptador mapeia TODO
   *      4xx do gateway pra 402, então uma `sk_` rotacionada, um recebedor
   *      desativado ou uma recusa de esquema imprimiam "recusado como
   *      esperado" — e o `after === before` passava trivialmente, porque
   *      cobrança nenhuma chegou a existir. A outra frase do comentário,
   *      "nada nosso responde 402", também era falsa: a nossa pré-checagem de
   *      formato de token responde.
   *
   * A prova positiva de verdade é o CÓDIGO: `card_declined` só é posto onde um
   * emissor de fato negou. O caminho genérico do gateway ganhou `psp_rejected`
   * na mesma rodada, justamente pra que esta linha pudesse distinguir os dois.
   * Oitava revisão de compliance, 2026-09-19 (HIGH-2) — terceira forma do mesmo
   * buraco, na mesma linha.
   */
  if (pay.data.code === 'charge_maybe_captured') {
    throw new Error(
      'PARE. `charge_maybe_captured`: o cartão foi CAPTURADO e a linha não foi gravada. '
      + 'o txid NÃO vem no corpo (o `errorBody` só deixa `error` e `code` passarem num 5xx) — '
      + 'procure `LINHA NAO GRAVADA` no stderr da função. Siga '
      + 'docs/runbooks/dinheiro-sem-conta.md antes de rodar o aceite de novo.',
    );
  }
  if (pay.status !== 402 || pay.data.code !== 'card_declined') {
    throw new Error(
      `a recusa não veio do EMISSOR: ${pay.status} ${pay.data.code || JSON.stringify(pay.data).slice(0, 160)}. `
      + 'Se for `psp_rejected`, o gateway recusou o pedido (chave rotacionada, recebedor '
      + 'desativado, esquema) e nenhum emissor viu cartão nenhum. Se for `rail_unsupported`, '
      + 'ponha o id da casa-piloto em RACHA_WALLET_VENUES e REDEPLOYE — na Vercel a env é '
      + 'ligada ao deploy, mexer no painel não alcança o que está no ar.',
    );
  }
  const after = (await checkState()).paidCents;
  if (after !== before) throw new Error(`recusa moveu dinheiro?! ${before} → ${after}`);
  process.stdout.write(`✓ recusado como esperado (${pay.status}: ${pay.data.code || pay.data.error}) e ledger intacto\n`);
}

async function legPix() {
  process.stdout.write('\n== PIX ==\n');
  const before = (await checkState()).paidCents;
  const pay = await j('POST', `${BASE}/api/pay`, {
    token: MESA, amountCents: 700, tipCents: 70, payerLabel: 'Aceite Pix',
    payerDocument: '39053344705',
  });
  if (!pay.data.success) throw new Error(`pix falhou: ${pay.status} ${pay.data.code || pay.data.error}`);
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
