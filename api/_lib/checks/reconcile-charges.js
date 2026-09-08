'use strict';

/**
 * Active charge reconciliation — the safety net for missed webhooks.
 *
 * Webhooks are best-effort: they can be dropped, mis-delivered, or rejected by
 * a config mismatch (a live/test endpoint gap, a Basic Auth typo). A money
 * system must NEVER depend solely on a webhook arriving. This reconciler is
 * the guaranteed path: it re-asks the PSP "was this charge paid?" for charges
 * still pending in our ledger, and confirms the ones the gateway reports paid.
 *
 * The confirmation itself goes through the SAME `confirm` function the webhook
 * uses (applyConfirmedPayment), so a poll-confirmed payment is byte-identical
 * to a webhook-confirmed one — same idempotency (a duplicate is a clean
 * no-op), same event-sourcing. One code path for money.
 *
 * Trigger points (both call this):
 *  - confirm-on-read: the diner's /api/check poll heals its own check;
 *  - a low-frequency cron: the backstop for checks nobody is watching.
 *
 * TOTAL over a sweep: a single charge failing (transient PSP 5xx, a DB hiccup)
 * is recorded and skipped — it never aborts the batch or throws.
 */

const { appendValidated } = require('./append-validated');

/**
 * Status terminais em que o DINHEIRO ANDOU: entrou e voltou. São diferentes de
 * "nunca foi paga" e por isso não podem sair só como um contador — ver
 * `MONEY_MOVED` no laço abaixo.
 */
const TERMINAL_COM_DINHEIRO = new Set(['refunded', 'chargedback']);

const DEFAULT_GRACE_MS = 20_000;                   // give the webhook first crack
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;     // a paid-but-unconfirmed charge stays healable for a day
const DEFAULT_LIMIT = 50;

// Gateway states that mean "this charge will never be paid" — distinct from a
// Pix still waiting for the diner. Surfaced separately so they don't hide in
// the "stillPending" bucket and vanish after the window.
const TERMINAL_UNPAID = new Set(['canceled', 'failed', 'refunded', 'chargedback', 'voided']);

/**
 * `overpaid` NÃO está na lista acima, e essa é a correção, não o descuido.
 *
 * No Pagar.me `overpaid` e `underpaid` são status em que o DINHEIRO CHEGOU —
 * o pagador digitou um valor diferente no app do banco. `overpaid` estava
 * listado como "nunca vai ser paga", numa lista que o arquivo documenta como
 * cobranças mortas. O efeito: a conciliação, o único caminho garantido quando
 * o webhook não chega, olhava pro dinheiro na conta da casa e o contava como
 * abandono. A conta seguia aberta, a mesa era cobrada de novo, e o canário
 * ficava verde porque as duas contagens concordavam entre si.
 *
 * Quem decide agora é `info.paid`, e `getCharge` o deriva de `PAID_STATUSES`
 * no adaptador — um só vocabulário de "chegou dinheiro" pros dois caminhos.
 * Achado pela revisão de compliance de 2026-09-08.
 */

/**
 * `requires_payment_method` é ambíguo, e por isso não está na lista acima.
 *
 * Na Stripe ele é o estado INICIAL de um intent recém-criado E o estado em que
 * um intent volta a cair quando o pagador recusa. Pôr na lista marcaria toda
 * cobrança recém-criada como terminal; deixar de fora conta uma recusa como
 * "ainda esperando" até a cobrança sair da janela, em silêncio.
 *
 * O que separa os dois é `attempted` (ver `parseIntent`): um erro de pagamento
 * ou uma cobrança existindo. Alguém TENTOU e não deu.
 *
 * Isso importa no Bizum mais que em qualquer outro trilho, porque quem recusa
 * recusa no app do banco e nada nos avisa — o adaptador nem interpreta
 * `payment_intent.payment_failed`. A conciliação é o único lugar que descobre.
 */
/**
 * Quanto tempo uma autorização de banco pode ficar pendurada antes de a gente
 * chamar de ABANDONO.
 *
 * No Bizum é uma pessoa tocando "aprovar" no app do banco. Isso leva segundos,
 * às vezes um minuto se ela foi procurar o telefone. Trinta minutos é
 * generoso: passado isso, ou ela desistiu, ou fechou o app, ou saiu do
 * restaurante.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

function isTerminalUnpaid(info, charge = null, now = Date.now()) {
  if (TERMINAL_UNPAID.has(info.status)) return true;
  if (info.status === 'requires_payment_method' && info.attempted === true) return true;
  /**
   * `requires_action` ABANDONADO.
   *
   * O estado de quem confirmou e nunca autorizou no app do banco. Não é
   * terminal por si — é o estado normal de quem está autorizando AGORA — então
   * o que o separa é a IDADE da cobrança.
   *
   * Sem isso a cobrança ficava `stillPending` até sair da janela de 24h e
   * desaparecer sem registro nenhum: ninguém nunca soube que aquela mesa
   * tentou pagar e não conseguiu. Achado pela revisão de compliance de
   * 2026-09-08 (M4).
   */
  if (info.status === 'requires_action' && charge && charge.createdAt) {
    const idade = now - Date.parse(charge.createdAt);
    if (Number.isFinite(idade) && idade > ABANDONED_AFTER_MS) return true;
  }
  return false;
}

/**
 * @param {object} deps
 * @param {{ listPendingCharges: Function }} deps.store
 * @param {{ getCharge?: Function }} deps.psp
 * @param {(parsed:object)=>Promise<{status:string, checkId?:string}>} deps.confirm
 *   Bound applyConfirmedPayment (store I/O already injected by the caller).
 */
function createChargeReconciler({ store, psp, confirm }) {
  if (!store || !psp || typeof confirm !== 'function') {
    throw new Error('createChargeReconciler: missing dependencies');
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.checkId]   scope to one check (confirm-on-read)
   * @param {number} [opts.graceMs]   ignore charges younger than this
   * @param {number} [opts.windowMs]  ignore charges older than this
   * @param {number} [opts.limit]
   */
  async function reconcile({
    checkId = null,
    graceMs = DEFAULT_GRACE_MS,
    windowMs = DEFAULT_WINDOW_MS,
    limit = DEFAULT_LIMIT,
  } = {}) {
    // A PSP without getCharge (mock w/o support, or the 503 fallback) can't be
    // polled — nothing to do, and never throw (this runs on the read path).
    if (typeof psp.getCharge !== 'function') {
      return { checked: 0, confirmed: 0, stillPending: 0, terminal: 0, unknown: 0, errors: 0, details: [], note: 'psp sem getCharge' };
    }

    // Um só instante pra toda a rodada: julgar abandono com relógios
    // diferentes por cobrança faria duas cobranças da mesma mesa caírem em
    // lados opostos da linha.
    const now = Date.now();

    let pending;
    try {
      pending = await store.listPendingCharges({ checkId, graceMs, windowMs, limit });
    } catch (err) {
      return { checked: 0, confirmed: 0, stillPending: 0, terminal: 0, unknown: 0, errors: 1, details: [{ error: `list: ${String(err.message).slice(0, 120)}` }] };
    }

    let confirmed = 0;
    let stillPending = 0;
    let terminal = 0;
    let unknown = 0;
    let errors = 0;
    const details = [];

    for (const p of pending) {
      try {
        const info = await psp.getCharge(p.txid);
        if (!info) { unknown += 1; continue; }       // not this PSP's charge (mock/house/gone)
        /**
         * Dinheiro que a API sabe que se moveu e o razão não sabe LANÇAR.
         *
         * Um cancelamento parcial sem `canceled_amount`, um valor que não é
         * centavo inteiro: o adaptador devolve `unusable_money_event`. Isso não
         * é "ainda esperando o Pix" nem "cobrança morta" — é a única categoria
         * que precisa de anomalia DURÁVEL, senão a cobrança sai da janela de
         * 24h em silêncio com os dois registros concordando que nada
         * aconteceu. Achado pela revisão de compliance de 2026-09-08.
         */
        if (info.kind === 'unusable_money_event') {
          terminal += 1;
          if (p.checkId) {
            try {
              await appendValidated(store, p.checkId, 'PAYMENT_ANOMALY', {
                txid: p.txid, severity: 'critical',
                reason: `cobrança ${p.txid}: dinheiro se moveu (${info.status}) e o valor não é mensurável`,
              }, `recon:${p.txid}:${info.status}`);
            } catch (e) {
              if (!/idempot|duplicate|unique/i.test(String(e.message))) {
                process.stderr.write(`[reconcile] anomalia não mensurável não gravada: ${String(e.message).slice(0, 120)}\n`);
              }
            }
          }
          let expUnusable = null;
          if (typeof store.expirePaymentIfPending === 'function') {
            try { expUnusable = await store.expirePaymentIfPending(p.txid); }
            catch { /* a anomalia já está gravada; a varredura segue */ }
          }
          details.push({
            txid: p.txid, checkId: p.checkId, status: `psp:${info.status}`, unusable: true,
            ...(expUnusable === null ? {} : { expired: expUnusable }),
          });
          continue;
        }
        /**
         * ESTORNO visto pela conciliação: o cancelamento parcial mensurável.
         *
         * O dinheiro entrou e parte voltou, e nossa confirmação nunca chegou.
         * Vai pelo MESMO aplicador do webhook, que sabe converter acumulado em
         * delta — mas ele precisa do pagamento no razão primeiro, e aqui ele
         * não está. Então: anomalia com o valor, que é honesto (sabemos que
         * saiu, e quanto) sem inventar um pagamento que ninguém registrou.
         */
        if (info.kind === 'refund' && Number.isSafeInteger(info.cumulativeRefundedCents)) {
          terminal += 1;
          if (p.checkId) {
            try {
              await appendValidated(store, p.checkId, 'PAYMENT_ANOMALY', {
                txid: p.txid, severity: 'critical',
                reason: `cobrança ${p.txid} foi paga e ${info.cumulativeRefundedCents}¢ devolvidos `
                  + 'no adquirente sem passar pelo razão',
              }, `recon:${p.txid}:partial_refund`);
            } catch (e) {
              if (!/idempot|duplicate|unique/i.test(String(e.message))) {
                process.stderr.write(`[reconcile] estorno visto na varredura não gravado: ${String(e.message).slice(0, 120)}\n`);
              }
            }
          }
          // E a LINHA sai de `pendente` (condicional, migração 0020): senão
          // ela deixa a janela de 24h em silêncio e o dinheiro passa a existir
          // só dentro de uma string de anomalia.
          let expirada = null;
          if (typeof store.expirePaymentIfPending === 'function') {
            try { expirada = await store.expirePaymentIfPending(p.txid); }
            catch (e) {
              errors += 1;
              details.push({ txid: p.txid, error: `expire: ${String(e.message).slice(0, 80)}` });
            }
          }
          details.push({
            txid: p.txid, checkId: p.checkId, status: `psp:${info.status}`,
            refundedCents: info.cumulativeRefundedCents,
            ...(expirada === null ? {} : { expired: expirada }),
          });
          continue;
        }
        if (!info.paid) {
          // A charge the gateway settled as canceled/failed/refunded before we
          // ever confirmed it is NOT a normal "still awaiting Pix" — surface it
          // separately so it's visible, not silently dropped after windowMs.
          if (isTerminalUnpaid(info, p, now)) {
            terminal += 1;
            /**
             * E a LINHA sai de `pendente`.
             *
             * Contar não é registrar. A cobrança morta era somada num contador
             * de uma resposta HTTP e mais nada: a linha seguia `pendente` até
             * sair da janela de 24h, e aí sumia do caminho ativo pra sempre —
             * exatamente o "desaparece sem registro nenhum" que a regra do
             * abandono tinha sido escrita pra corrigir.
             *
             * Condicional (migração 0020): se uma confirmação chegou no meio
             * do caminho, ela ganha. Achado pela revisão de segurança de
             * 2026-09-08.
             */
            /**
             * `refunded` e `chargedback` são a ida E a volta do dinheiro.
             *
             * A cobrança foi paga (nossa confirmação se perdeu) e depois
             * devolvida ou contestada. Marcar a linha como `expirado` e contar
             * num contador apaga as duas pernas: líquido zero pra casa, e
             * nenhum rastro de que houve dinheiro — o inegociável #6 no
             * miúdo. A anomalia fica na conta, com o valor que o adquirente
             * reporta. Achado pela revisão de segurança de 2026-09-08.
             */
            if (TERMINAL_COM_DINHEIRO.has(info.status) && p.checkId) {
              try {
                await appendValidated(store, p.checkId, 'PAYMENT_ANOMALY', {
                  txid: p.txid, severity: 'high',
                  reason: `cobrança ${p.txid} foi paga e ${info.status} no adquirente sem passar pelo razão`
                    + `${Number.isSafeInteger(info.amountCents) ? ` (${info.amountCents + (info.tipCents || 0)}¢)` : ''}`,
                }, `recon:${p.txid}:${info.status}`);
              } catch (e) {
                // Já registrada (a chave é estável, então a varredura seguinte
                // não duplica), ou o razão recusou. Nos dois a varredura segue.
                if (!/idempot|duplicate|unique/i.test(String(e.message))) {
                  process.stderr.write(`[reconcile] anomalia de ida-e-volta não gravada: ${String(e.message).slice(0, 120)}\n`);
                }
              }
            }
            let expirada = null;
            if (typeof store.expirePaymentIfPending === 'function') {
              try { expirada = await store.expirePaymentIfPending(p.txid); }
              catch (e) {
                errors += 1;
                details.push({ txid: p.txid, error: `expire: ${String(e.message).slice(0, 80)}` });
              }
            }
            details.push({
              txid: p.txid, checkId: p.checkId, status: `psp:${info.status}`,
              ...(expirada === null ? {} : { expired: expirada }),
            });
          } else {
            stillPending += 1;
          }
          continue;
        }
        /**
         * REPASSA o que o adaptador devolveu. Não copia campo por campo.
         *
         * Isto remontava o objeto à mão — e uma cópia à mão é a fábrica do
         * chamador esquecido. O campo que ficou de fora foi o `excessCents`:
         * quanto daquele pagamento entrou a mais. Sem ele, TODA restituição
         * confirmada por este caminho voltava pra regra proporcional, tirava
         * uma fatia da gorjeta (Lei 13.419), e a marca "a devolver" convergia
         * geometricamente sem nunca chegar a zero — o painel pedindo devolução
         * e o cliente sendo avisado de que é credor depois de restituído.
         *
         * E este é o caminho GARANTIDO, o que existe justamente porque o
         * webhook pode não chegar: o defeito valia pra toda conta curada pela
         * conciliação ou pela leitura do cliente. Achado pela revisão de
         * compliance de 2026-09-08.
         *
         * `kind` é fixado aqui porque o adaptador pode devolver `refund` ou
         * `unusable_money_event`, e esses ramos saíram acima.
         */
        const res = await confirm({ ...info, kind: 'payment_confirmed' });
        if (res.status === 'appended' || res.status === 'divergent_appended') {
          confirmed += 1;
        }
        details.push({ txid: p.txid, checkId: res.checkId || p.checkId, status: res.status });
      } catch (err) {
        errors += 1;
        details.push({ txid: p.txid, error: String(err.message).slice(0, 120) });
      }
    }

    return { checked: pending.length, confirmed, stillPending, terminal, unknown, errors, details };
  }

  return { reconcile };
}

module.exports = {
  createChargeReconciler, DEFAULT_GRACE_MS, DEFAULT_WINDOW_MS, ABANDONED_AFTER_MS,
};
