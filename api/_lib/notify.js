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

module.exports = { notifyOwnerRecipientStatus, notifyFounderActivationRadar };
