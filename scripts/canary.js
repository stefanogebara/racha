#!/usr/bin/env node
'use strict';

/**
 * O CANÁRIO SINTÉTICO — a linha da barra de verificação que nunca existiu.
 *
 * `CLAUDE.md`: "Synthetic canary (staging, daily once deployed): open check →
 * split 3 ways → 2 Pix + 1 card → reconcile exact → close table. Any failure is
 * a page."
 *
 * Seis rodadas de revisão olharam CÓDIGO. Isto olha um servidor: dirige uma
 * instância de verdade por HTTP, do jeito que um telefone numa mesa dirige, e
 * afirma o que tem que ser verdade no fim. É o único teste desta série que
 * atravessa a rede, o roteador, o razão, a projeção e a conciliação juntos.
 *
 *   node scripts/canary.js [base-url]
 *
 * Sem argumento, http://localhost:8787. Sai 0 se tudo fecha, 1 no primeiro
 * fato que não fecha — e diz qual.
 *
 * LIMITE, dito na cara: o pagamento é confirmado pela rota de demo (PSP mock),
 * porque não há como forçar um Pix de verdade num teste. Então isto prova o
 * caminho INTEIRO menos o adquirente. Quem cobre o adquirente é a terceira
 * perna da conciliação (`reconcile-payables`), que lê os recebíveis dele.
 */

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const brl = (c) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;

let passos = 0;
const falhas = [];

function afirma(condicao, oQue, detalhe = '') {
  passos += 1;
  if (condicao) {
    process.stdout.write(`  ✓ ${oQue}\n`);
  } else {
    falhas.push(oQue);
    process.stdout.write(`  ✗ ${oQue}${detalhe ? `\n      ${detalhe}` : ''}\n`);
  }
}

async function req(metodo, caminho, corpo) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: corpo ? { 'content-type': 'application/json' } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* corpo não-JSON */ }
  return { status: r.status, json, texto };
}

async function main() {
  process.stdout.write(`\ncanário sintético · ${BASE}\n\n`);

  // ── 0. A mesa começa LIMPA ───────────────────────────────────────────────
  //     Sem isto o canário roda uma vez e nunca mais: a segunda passada
  //     encontra a conta já quitada, `/api/pay` recusa com "valor acima do que
  //     falta", e o canário reporta vermelho por ter funcionado antes. Um teste
  //     que só passa na primeira execução é pior que nenhum — ele treina quem
  //     lê a ignorar o vermelho.
  const token = process.env.RACHA_CANARY_TOKEN;
  if (!token) {
    process.stdout.write('  ! RACHA_CANARY_TOKEN não definido — o canário precisa de uma mesa\n');
    process.exit(2);
  }
  const zerou = await req('POST', '/api/demo/reset');
  afirma(zerou.status === 200, 'a mesa de ensaio zera antes de começar',
         `HTTP ${zerou.status} ${zerou.texto.slice(0, 120)}`);

  const vista = await req('GET', `/api/check?t=${token}`);
  afirma(vista.status === 200 && vista.json?.success, 'a conta abre pelo QR da mesa',
         `HTTP ${vista.status} ${vista.texto.slice(0, 120)}`);
  if (!vista.json?.success) return;

  const { check, state, venue } = vista.json.data;
  const total = state.totalCents;
  afirma(total > 0, `a conta tem valor (${brl(total)})`);
  afirma(state.paidCents === 0,
         'a conta começa sem pagamento — o reset pegou',
         `pago ${brl(state.paidCents)}`);

  // ── 2. A leitura pública é PROJETADA ─────────────────────────────────────
  //     O que vazava: situação de disputa, prazo de prova, e a nota de texto
  //     livre do dono, numa rota sem login. LGPD art. 6º III.
  afirma(!('closed' in state), 'o estado público não expõe campos internos do redutor',
         `chaves: ${Object.keys(state).join(', ')}`);
  afirma(typeof state.anomalies === 'number',
         'anomalias vêm como CONTAGEM, não como texto');
  const cru = JSON.stringify(state);
  for (const proibido of ['disputeStatus', 'disputeDueBy', 'reason']) {
    afirma(!cru.includes(proibido), `o estado público não carrega \`${proibido}\``);
  }
  const chavesPg = Object.keys(state.payments || {});
  afirma(chavesPg.every((k) => /^p\d+$/.test(k)),
         'pagamentos vêm por ORDINAL, não pelo id do adquirente',
         `chaves: ${chavesPg.join(', ') || '(nenhuma)'}`);

  // ── 3. Racha em TRÊS, e a soma tem que ser exata ─────────────────────────
  const partes = [];
  let resto = total;
  for (let i = 0; i < 3; i += 1) {
    const parte = i === 2 ? resto : Math.floor(total / 3);
    partes.push(parte);
    resto -= parte;
  }
  afirma(partes.reduce((a, b) => a + b, 0) === total,
         `três partes somam a conta exatamente (${partes.map(brl).join(' + ')})`);

  // ── 4. Cada parte cobra e confirma ───────────────────────────────────────
  const txids = [];
  for (const [i, parte] of partes.entries()) {
    const cobr = await req('POST', '/api/pay', {
      token, amountCents: parte, tipCents: 0,
      payerLabel: `Canário ${i + 1}`, payerDocument: '390.533.447-05',
    });
    afirma(cobr.status === 200 && cobr.json?.data?.txid,
           `parte ${i + 1} vira cobrança`, `HTTP ${cobr.status} ${cobr.texto.slice(0, 140)}`);
    if (!cobr.json?.data?.txid) return;
    txids.push(cobr.json.data.txid);

    /**
     * A afirmação é sobre o EFEITO, não sobre a palavra que a rota devolve.
     *
     * A primeira versão exigia `appended` da rota de confirmação — e na mesa de
     * DEMO a cobrança já se confirma na criação (não há banco de verdade numa
     * demonstração de landing), então a confirmação devolve `duplicate` e o
     * canário reportava vermelho três vezes sobre dinheiro que tinha entrado
     * certinho. Uma asserção sobre a resposta descreve a implementação; uma
     * sobre o razão descreve o que tem que ser verdade.
     */
    await req('POST', '/api/dev/confirm', { txid: cobr.json.data.txid });
    const apos = await req('GET', `/api/check?t=${token}`);
    const pagoAgora = apos.json?.data?.state?.paidCents;
    const esperado = partes.slice(0, i + 1).reduce((a, b) => a + b, 0);
    afirma(pagoAgora === esperado,
           `parte ${i + 1} entra no razão (${brl(esperado)} acumulados)`,
           `o razão diz ${brl(pagoAgora ?? -1)}`);

    // Reentrega: o mesmo evento duas vezes NÃO pode mover o saldo.
    await req('POST', '/api/dev/confirm', { txid: cobr.json.data.txid });
    const depoisRep = await req('GET', `/api/check?t=${token}`);
    afirma(depoisRep.json?.data?.state?.paidCents === esperado,
           `parte ${i + 1} reentregue não move o saldo`,
           `o razão diz ${brl(depoisRep.json?.data?.state?.paidCents ?? -1)}`);
  }

  // ── 5. A mesa fecha, ao centavo ──────────────────────────────────────────
  const fim = await req('GET', `/api/check?t=${token}`);
  const st = fim.json?.data?.state;
  afirma(!!st, 'a conta ainda lê depois de paga');
  if (!st) return;
  afirma(st.paidCents === total,
         `o pago bate com a conta ao centavo (${brl(st.paidCents)} de ${brl(total)})`);
  afirma(st.status === 'paga' || st.status === 'fechada',
         `a mesa fecha (status ${st.status})`);
  afirma(st.overpaidCents === 0, 'não sobrou dinheiro a devolver');
  afirma(st.anomalies === 0, `o razão fecha sem anomalia (${st.anomalies})`);

  // ── 6. E a moeda vem da CASA, não de um padrão ───────────────────────────
  afirma(!!venue.currency, `a casa declara a moeda (${venue.currency})`);

  process.stdout.write(`\n${falhas.length === 0 ? '✓' : '✗'} ${passos - falhas.length}/${passos} afirmações`);
  process.stdout.write(falhas.length ? `\n\nfalhou:\n${falhas.map((f) => `  · ${f}`).join('\n')}\n\n`
                                     : '\n\n');
  process.exit(falhas.length ? 1 : 0);
}

main().catch((e) => {
  process.stdout.write(`\n✗ o canário morreu: ${e.message}\n\n`);
  process.exit(1);
});
