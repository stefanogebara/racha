'use strict';

/**
 * Evento de DINHEIRO que não vira lançamento — o tratamento, num lugar só.
 *
 * `NON_LEDGER_KINDS` é a espécie "mexeu em dinheiro e o razão não sabe
 * traduzir": cancelamento parcial (saiu dinheiro e não sabemos quanto),
 * disputa aberta, estorno que falhou, alerta de conta. O portão do webhook
 * devolve cada um como status e diz, em comentário, que quem trata é o
 * CHAMADOR.
 *
 * Havia três chamadores e só dois tratavam. `/api/webhooks/psp` — a rota do
 * trilho que está em produção de verdade — devolvia 200 sem gravar nada e sem
 * avisar ninguém: a linha seguia `confirmado` pelo valor cheio, o razão
 * também, e a conciliação diária compara os DOIS ENTRE SI, concorda, e reporta
 * VERDE por cima de dinheiro que saiu da conta. O inegociável #8 derrotado na
 * forma exata que ele foi escrito pra proibir. Achado pela revisão de
 * segurança de 2026-09-08.
 *
 * Este módulo existe separado da rota porque a rota não era testável: o defeito
 * era um `if` que faltava num arquivo de 1500 linhas que nenhum teste carrega.
 *
 * Duas coisas acontecem aqui, e a primeira é a que faltava em todo lugar:
 *
 *  1. ANOMALIA NO RAZÃO. Um alerta degrada — sem `RACHA_NOTIFY_SECRET` ele
 *     vira uma linha de stderr que ninguém lê. A anomalia é durável: entra no
 *     log, o redutor a projeta, e a conciliação passa a ficar VERMELHA naquela
 *     conta até alguém resolver. É o canário que pageia em vez de logar.
 *  2. O aviso ao fundador, pra alguém saber hoje e não no fechamento do mês.
 */

const { appendValidated } = require('../checks/append-validated');
const { maskPixPayload } = require('./mask');

/**
 * `refund_progress` fica de fora dos dois lados: é estado intermediário de um
 * estorno que ainda vai terminar em `succeeded` ou `failed`, e os dois têm
 * tratamento próprio. Marcar aqui deixaria a conta vermelha por um estorno que
 * deu certo.
 */
const SEM_ALARDE = new Set(['refund_progress']);

function createNonLedgerHandler({ store, notify, append = appendValidated }) {
  if (!store || typeof notify !== 'function') {
    throw new Error('createNonLedgerHandler: missing dependencies');
  }
  /**
   * @param {{status: string, type?: string|null, txid?: string|null, raw?: object}} result
   * @returns {Promise<{persisted: boolean, notified: boolean}>}
   */
  /**
   * @param {object} result o que o portão devolveu
   * @param {{alert?: boolean}} [opts] `alert:false` só grava a marca — pra
   *   quem já manda o próprio alerta com detalhe que só ele tem (a rota da
   *   Stripe carrega a conta conectada no aviso). Dois alertas pelo mesmo
   *   evento treinam quem lê a ignorar os dois.
   */
  return async function handleNonLedgerMoneyEvent(result, opts = {}) {
    const kind = result.status;
    const txid = result.txid || null;
    const quieto = SEM_ALARDE.has(kind);
    let found = null;
    if (txid) {
      try { found = await store.findCheckByTxid(txid); }
      catch { /* sem check ligado: o alerta ainda sai */ }
    }
    let persisted = false;
    if (found && !quieto) {
      try {
        await append(store, found.id, 'PAYMENT_ANOMALY', {
          txid,
          reason: `${kind}${result.type ? ` (${result.type})` : ''}: evento de dinheiro que o razão não sabe lançar`,
          severity: 'critical',
        }, (result.raw && result.raw.eventId) || null);
        persisted = true;
      } catch (e) {
        process.stderr.write(`[webhook] anomalia não gravada: ${String(e.message).slice(0, 120)}\n`);
      }
    }
    /**
     * SEM conta pra pendurar a marca, o evento ainda tem que sobrar em algum
     * lugar durável.
     *
     * Um txid que não resolve pra conta nenhuma (cobrança de outro ambiente,
     * linha apagada) não tem razão onde entrar — e a rota respondia 503 "pra o
     * PSP reenviar" sobre um estado que NUNCA vai mudar. Sem
     * `RACHA_NOTIFY_SECRET`, isso era 503 em laço até o endpoint ser
     * desabilitado, o que derruba toda confirmação de Pix. Agora vai pra
     * `orphan_money_events` (migração 0024) e a rota pode responder 200 com o
     * evento guardado. Achado pela revisão de segurança de 2026-09-08.
     */
    if (!found && !quieto && typeof store.recordOrphanMoneyEvent === 'function') {
      try {
        await store.recordOrphanMoneyEvent({
          kind, txid, eventType: result.type || null,
          pspEventId: (result.raw && result.raw.eventId) || null,
          amountCents: (result.raw && result.raw.amountCents) ?? null,
          // MASCARADO: o corpo cru do PSP traz documento do pagador.
          payload: maskPixPayload(result.raw && result.raw.raw ? result.raw.raw : result.raw),
        });
        persisted = true;
      } catch (e) {
        process.stderr.write(`[webhook] evento órfão não gravado: ${String(e.message).slice(0, 120)}\n`);
      }
    }
    let notified = false;
    if (!quieto && opts.alert !== false) {
      const r = await notify({
        kind, txid: txid || '?', checkId: found ? found.id : null,
        amountCents: (result.raw && result.raw.amountCents) || 0,
        detail: [result.type || null, result.raw && result.raw.status ? `status=${result.raw.status}` : null]
          .filter(Boolean).join(' ') || null,
      });
      notified = Boolean(r && r.ok);
    }
    // `found` sai junto porque a ROTA precisa dele pra decidir o 503: só quem
    // TINHA onde gravar e não gravou é que precisa de reentrega.
    return { persisted, notified, quieto, found: Boolean(found) };
  };
}

module.exports = { createNonLedgerHandler, SEM_ALARDE };
