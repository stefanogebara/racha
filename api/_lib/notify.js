'use strict';

/**
 * Disparo de aviso ao dono via Olímpia (restaurant-ai-mcp).
 *
 * O Racha não tem infra de e-mail/WhatsApp — a Olímpia (Seatable) tem, e já é
 * quem falou com o dono. Então o Racha só DISPARA: manda o payload pro endpoint
 * `/api/racha-notify` da Olímpia, autenticado por secret compartilhado, e ela
 * entrega (WhatsApp na máquina dela — janela de 24h/template — + e-mail Resend).
 *
 * Best-effort e nunca lança: um aviso que falha não pode derrubar o cron (o
 * status já foi persistido antes; o próximo tick não reenvia porque a transição
 * já não existe). Sem RACHA_NOTIFY_SECRET, no-op silencioso (log só).
 */

const NOTIFY_URL = process.env.RACHA_NOTIFY_URL || 'https://seatable.one';

async function notifyOwnerRecipientStatus({ venue, status, previousStatus = null, reason = null }) {
  const secret = process.env.RACHA_NOTIFY_SECRET;
  if (!secret) {
    process.stderr.write('[notify] RACHA_NOTIFY_SECRET ausente — aviso de recebedor não enviado\n');
    return { skipped: true, reason: 'no_secret' };
  }
  const body = {
    event: 'recipient_status',
    venueName: venue.name,
    ownerEmail: venue.notifyEmail || null,
    ownerPhone: venue.notifyWhatsapp || null,
    status,                 // 'active' | 'refused' | 'suspended' | ...
    previousStatus,
    reason,
    recipientId: venue.pspRecipientId || null,
  };
  try {
    const res = await fetch(`${NOTIFY_URL}/api/racha-notify`, {
      // PRAZO. Sem ele, uma ponte que aceita a conexão e pendura consome o
      // resto do `maxDuration`, a plataforma mata a função, e o `catch` que
      // escreve `RECONCILE ALERT` no stderr TAMBÉM não roda. O alerta se perde
      // e a rede de segurança que existe pra que um alerta de dinheiro não
      // possa sumir se perde junto — inegociável #8 alcançado por omissão, não
      // por um desvio. O `notifyPreviaBeacon` já tinha o seu.
      // Achado pela revisão de segurança de 2026-09-09 (MEDIUM-2).
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) process.stderr.write(`[notify] racha-notify ${res.status}: ${JSON.stringify(data).slice(0, 160)}\n`);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    process.stderr.write(`[notify] racha-notify falhou: ${String(e.message).slice(0, 160)}\n`);
    return { ok: false, error: e.message };
  }
}

/**
 * Radar de ativação → FUNDADOR (não o dono do restaurante).
 *
 * Mesma ponte, destinatário diferente: aqui quem precisa agir é quem vende, não
 * quem opera. O lado da Olímpia resolve o endereço (PROSPECTING_FOUNDER_*), por
 * isso este payload não carrega telefone nem e-mail — o Racha não guarda o
 * contato do fundador.
 *
 * Best-effort e nunca lança, igual ao aviso de recebedor: um digest que falha
 * não pode derrubar o cron.
 */
async function notifyFounderActivationRadar({ mensagem, alertas = 0, total = 0, ativos = 0 }) {
  const secret = process.env.RACHA_NOTIFY_SECRET;
  if (!secret) {
    process.stderr.write('[notify] RACHA_NOTIFY_SECRET ausente — radar não enviado\n');
    return { skipped: true, reason: 'no_secret' };
  }
  try {
    const res = await fetch(`${NOTIFY_URL}/api/racha-notify`, {
      // PRAZO. Sem ele, uma ponte que aceita a conexão e pendura consome o
      // resto do `maxDuration`, a plataforma mata a função, e o `catch` que
      // escreve `RECONCILE ALERT` no stderr TAMBÉM não roda. O alerta se perde
      // e a rede de segurança que existe pra que um alerta de dinheiro não
      // possa sumir se perde junto — inegociável #8 alcançado por omissão, não
      // por um desvio. O `notifyPreviaBeacon` já tinha o seu.
      // Achado pela revisão de segurança de 2026-09-09 (MEDIUM-2).
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ event: 'activation_radar', mensagem, alertas, total, ativos }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) process.stderr.write(`[notify] radar ${res.status}: ${JSON.stringify(data).slice(0, 160)}\n`);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    process.stderr.write(`[notify] radar falhou: ${String(e.message).slice(0, 160)}\n`);
    return { ok: false, error: e.message };
  }
}

/**
 * Beacon da prévia de prospecção → timeline da Olímpia.
 *
 * Quando a Olímpia manda o link do demo, ele carrega `pl` — um token HMAC que
 * ELA cunhou e só ela verifica (identifica o lead; não autoriza nada). O front
 * repassa o valor pra cá e daqui vai server-side pro `/api/previa-event`, que
 * é público de propósito (mesma postura do beacon da prévia por-restaurante):
 * por isso, diferente dos avisos acima, NÃO leva RACHA_NOTIFY_SECRET.
 * Server-side porque o CORS do endpoint dela não abre pro browser do diner.
 *
 * Best-effort e nunca lança: telemetria jamais pode quebrar o demo.
 */
async function notifyPreviaBeacon({ pl, event }) {
  try {
    const res = await fetch(`${NOTIFY_URL}/api/previa-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: pl, event }),
      signal: AbortSignal.timeout(4000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    process.stderr.write(`[notify] previa-beacon falhou: ${String(e.message).slice(0, 160)}\n`);
    return { ok: false, error: e.message };
  }
}

/**
 * Conciliação vermelha → FUNDADOR.
 *
 * A regra #8 do CLAUDE.md diz "canário vermelho PAGINA; nunca só loga". Um
 * stderr num cron da Vercel é exatamente "só logar": ninguém acorda com isso.
 * Então drift vai pela mesma ponte da Olímpia que já entrega WhatsApp e e-mail.
 *
 * Best-effort e nunca lança — mas, diferente dos outros avisos, se a ponte
 * falhar isto ESCREVE o relatório inteiro no stderr antes de desistir: um
 * alerta de dinheiro que não sai não pode também sumir.
 */
async function notifyFounderReconcile({ mensagem, venuesRed = 0, venuesChecked = 0,
                                        driftCents = 0, worstSeverity = 'ok', heartbeat = false,
                                        rowsRepaired = 0, rowsRepairAckLost = 0,
                                        rowsRepairRaced = 0, rowsRepairRejected = 0,
                                        infoCodes = [] }) {
  const secret = process.env.RACHA_NOTIFY_SECRET;
  if (!secret) {
    // Batimento sem ponte não merece um bloco de stderr por noite; alerta sim.
    if (!heartbeat) process.stderr.write(`RECONCILE ALERT (sem RACHA_NOTIFY_SECRET):\n${mensagem}\n`);
    return { skipped: true, reason: 'no_secret' };
  }
  try {
    const res = await fetch(`${NOTIFY_URL}/api/racha-notify`, {
      // PRAZO. Sem ele, uma ponte que aceita a conexão e pendura consome o
      // resto do `maxDuration`, a plataforma mata a função, e o `catch` que
      // escreve `RECONCILE ALERT` no stderr TAMBÉM não roda. O alerta se perde
      // e a rede de segurança que existe pra que um alerta de dinheiro não
      // possa sumir se perde junto — inegociável #8 alcançado por omissão, não
      // por um desvio. O `notifyPreviaBeacon` já tinha o seu.
      // Achado pela revisão de segurança de 2026-09-09 (MEDIUM-2).
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        // Verde manda 'reconcile_heartbeat': do outro lado, a AUSÊNCIA da batida
        // noturna é o alarme. Um canário que só fala quando está ruim é
        // indistinguível de um canário morto (#8).
        event: heartbeat ? 'reconcile_heartbeat' : 'reconcile_drift',
        mensagem, venuesRed, venuesChecked, driftCents, worstSeverity,
        // QUANTAS LINHAS a varredura reescreveu. Sem isto uma batida verde que
        // reprojetou quatro linhas de `payments` é indistinguível de uma noite
        // em que nada foi tocado — e o batimento é justamente o que se olha
        // quando nada está vermelho (HIGH-3, revisão de 2026-09-09).
        rowsRepaired, rowsRepairAckLost, rowsRepairRaced, rowsRepairRejected,
        // O TIER `info` CHEGA NA BATIDA. É o que se olha quando nada está
        // vermelho — e sem ele um mundo em que TODO reparo vira corrida perdida
        // (uma migração muda o retorno da RPC e `data === true` deixa de valer)
        // manda batimento verde enquanto o conserto parou de funcionar por
        // inteiro. Achado pela revisão de segurança de 2026-09-09.
        infoCodes,
      }),
    });
    const data = await res.json().catch(() => ({}));
    // A BATIDA REJEITADA TAMBÉM GRITA.
    //
    // Era `!res.ok && !heartbeat`, então uma batida recusada não escrevia nada
    // — e a batida é justamente o sinal cujo contrato é "a ausência é o
    // alarme". Uma ponte que recusa 100% das batidas satisfaz esse contrato de
    // forma vazia: a ausência nunca foi lida como alarme porque a batida nunca
    // chegou uma vez sequer. Achado da revisão de segurança de 2026-09-12, que
    // leu o RECEPTOR — as revisões anteriores endureceram o transporte deste
    // lado e nenhuma conferiu se o outro lado aceita o corpo.
    // Mesmo raciocínio do evento de dinheiro: 200 com nada entregue é pior que
    // 400. A batida é rotina e vai só por e-mail, então pra ela `entregue`
    // também se satisfaz com e-mail.
    const entregue = Boolean(data && data.data
      && (data.data.email === 'sent' || data.data.whatsapp === 'sent'));
    if (!res.ok || !entregue) {
      process.stderr.write(
        `${heartbeat ? 'RECONCILE HEARTBEAT' : 'RECONCILE ALERT'} `
        + `(ponte ${res.status}${entregue ? '' : ', nada entregue'}):\n${mensagem}\n`,
      );
    }
    return { ok: res.ok && entregue, status: res.status, data };
  } catch (e) {
    if (!heartbeat) {
      process.stderr.write(`RECONCILE ALERT (ponte falhou: ${String(e.message).slice(0, 120)}):\n${mensagem}\n`);
    }
    return { ok: false, error: e.message };
  }
}

/**
 * Disputa aberta, ou reembolso que falhou.
 *
 * Duas coisas que ninguém descobre sozinho. Uma disputa retém dinheiro do saldo
 * e tem prazo de prova (40 dias no Bizum) — perder o prazo é perder o dinheiro
 * por inação. Um reembolso que falha devolve o valor pro saldo do restaurante e
 * deixa o cliente sem nada, silenciosamente, porque do ponto de vista do
 * sistema "o reembolso foi pedido" já aconteceu.
 *
 * Mesma regra do canário de conciliação: se a ponte não está configurada, o
 * relatório inteiro vai pro stderr. Trocar um alerta por um silêncio é o modo
 * de falha #7.
 */
/**
 * OS EVENTOS DE FUNDADOR — a lista é daqui, e é ela que a ponte espelha.
 *
 * A primeira versão desta lista vivia só do outro lado e foi preenchida a olho,
 * a partir do que o censo achava no `router.js`. O censo procurava
 * `notifyFounderMoneyEvent({ kind: '<literal>'` — primeira chave, literal — e
 * três dos seis call sites passam `kind: parsed.kind`, o evento normalizado
 * pelo adaptador do PSP. Então a lista ganhou cinco nomes que NÃO são eventos
 * (`overpaid_pending_restitution`, `money_event_unrecorded`,
 * `dispute_close_unrecorded`, `dispute_evidence_due`, `dispute_evidence_overdue`
 * são códigos de achado da conciliação e de erro HTTP, que só PARECEM nomes de
 * evento) e perdeu os SETE que a produção realmente emite — todos de disputa e
 * de estorno.
 *
 * Resultado: um `charge.dispute.created` da Stripe continuava voltando 400 e
 * virando linha de log, com o relógio de 40 dias de prova correndo em silêncio.
 * Dois censos, um mesmo ponto cego, concordando um com o outro.
 *
 * Por isso a lista mudou de lado. Aqui ela é a FONTE: `notifyFounderMoneyEvent`
 * ESTOURA num `kind` que não esteja nela, então um adaptador que invente um
 * evento novo falha no remetente, alto, em vez de sumir num 400. E o censo
 * virou comparação de conjuntos, que regex nenhuma dribla.
 *
 * Achado da revisão de segurança de 2026-09-12.
 */
const KINDS_DE_FUNDADOR = Object.freeze(new Set([
  // Disputa e estorno — normalizados pelos adaptadores, passados como
  // `parsed.kind`. São exatamente os que estavam faltando.
  'dispute_opened', 'dispute_updated', 'dispute_funds', 'dispute_lost',
  'account_alert', 'unusable_money_event', 'refund_failed',
  // Retenção — literais, do cron.
  'retention_ok', 'retention_blocked', 'retention_late',
]));

async function notifyFounderMoneyEvent({ kind, txid, checkId = null, amountCents = 0, detail = null }) {
  // ESTOURA em vez de mandar o que a ponte recusa. Um evento novo tem que
  // passar por uma decisão humana sobre como é entregue — e falhar aqui é
  // barulhento, enquanto falhar na ponte era um 400 dentro de um log.
  if (!KINDS_DE_FUNDADOR.has(kind)) {
    throw new Error(`notifyFounderMoneyEvent: kind desconhecido '${kind}' — acrescente em KINDS_DE_FUNDADOR e na ponte`);
  }
  // Campos ausentes SOMEM em vez de virar "txid=undefined". Alertas que não são
  // de uma cobrança (batida da retenção, por exemplo) passam por aqui, e uma
  // linha com `undefined` treina quem lê a ignorar.
  const linha = [
    kind,
    txid ? `txid=${txid}` : null,
    checkId ? `check=${checkId}` : null,
    amountCents ? `valor=${amountCents}` : null,
    detail || null,
  ].filter(Boolean).join(' ');
  const secret = process.env.RACHA_NOTIFY_SECRET;
  if (!secret) {
    process.stderr.write(`MONEY EVENT ALERT (sem RACHA_NOTIFY_SECRET):\n${linha}\n`);
    return { skipped: true, reason: 'no_secret' };
  }
  try {
    const res = await fetch(`${NOTIFY_URL}/api/racha-notify`, {
      // PRAZO. Sem ele, uma ponte que aceita a conexão e pendura consome o
      // resto do `maxDuration`, a plataforma mata a função, e o `catch` que
      // escreve `RECONCILE ALERT` no stderr TAMBÉM não roda. O alerta se perde
      // e a rede de segurança que existe pra que um alerta de dinheiro não
      // possa sumir se perde junto — inegociável #8 alcançado por omissão, não
      // por um desvio. O `notifyPreviaBeacon` já tinha o seu.
      // Achado pela revisão de segurança de 2026-09-09 (MEDIUM-2).
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ event: kind, mensagem: linha, txid, checkId, amountCents, detail }),
    });
    const data = await res.json().catch(() => ({}));
    // 200 NÃO QUER DIZER ENTREGUE.
    //
    // A ponte captura toda falha de canal num campo de string e devolve 200 de
    // qualquer jeito: sem `RESEND_API_KEY`, com o Resend recusando, sem número
    // do fundador — tudo vira `{email:'skipped', whatsapp:'skipped:...'}` com
    // status 200. Ler só `res.ok` trocava "400 toda noite, pelo menos alto no
    // log" por "200 toda noite, calado", que é estritamente o pior dos dois
    // pela ordem do próprio CLAUDE.md: sucesso silencioso é o inimigo.
    const entregue = Boolean(data && data.data
      && (data.data.email === 'sent' || data.data.whatsapp === 'sent'));
    if (!res.ok || !entregue) {
      process.stderr.write(
        `MONEY EVENT ALERT (ponte ${res.status}${entregue ? '' : ', nada entregue'}):\n${linha}\n`,
      );
    }
    return { ok: res.ok && entregue, status: res.status, entregue };
  } catch (e) {
    process.stderr.write(`MONEY EVENT ALERT (ponte falhou: ${String(e.message).slice(0, 120)}):\n${linha}\n`);
    return { ok: false, error: e.message };
  }
}

module.exports = { notifyOwnerRecipientStatus, notifyFounderActivationRadar, notifyPreviaBeacon,
  notifyFounderReconcile, notifyFounderMoneyEvent, KINDS_DE_FUNDADOR };
