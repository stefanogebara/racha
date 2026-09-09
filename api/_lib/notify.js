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
    if (!res.ok && !heartbeat) {
      process.stderr.write(`RECONCILE ALERT (ponte ${res.status}):\n${mensagem}\n`);
    }
    return { ok: res.ok, status: res.status, data };
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
async function notifyFounderMoneyEvent({ kind, txid, checkId = null, amountCents = 0, detail = null }) {
  const linha = `${kind} txid=${txid} check=${checkId || '?'} valor=${amountCents} ${detail || ''}`.trim();
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
    if (!res.ok) process.stderr.write(`MONEY EVENT ALERT (ponte ${res.status}):\n${linha}\n`);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    process.stderr.write(`MONEY EVENT ALERT (ponte falhou: ${String(e.message).slice(0, 120)}):\n${linha}\n`);
    return { ok: false, error: e.message };
  }
}

module.exports = { notifyOwnerRecipientStatus, notifyFounderActivationRadar, notifyPreviaBeacon, notifyFounderReconcile, notifyFounderMoneyEvent };
