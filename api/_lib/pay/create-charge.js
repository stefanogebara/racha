'use strict';

/**
 * Create a Pix charge for a share of a check — the money-out gate.
 *
 * Rules enforced HERE (not in the UI, which is advisory):
 * - the venue must have a psp_recipient_id (no platform-custody charges);
 * - consumption amount cannot exceed remaining-to-pay AT CHARGE TIME
 *   (overpay window shrinks to webhook-race size; the reducer flags any
 *   residual overpay rather than losing it);
 * - tips ride the same charge but are tracked separately end-to-end
 *   (Lei 13.419: they are employee remuneration, not revenue);
 * - serviço percentage comes from the VENUE config, never a default.
 */

const { reduce, remainingCents } = require('../checks/check-state');

function badRequest(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  return err;
}

const WALLETS = Object.freeze(['apple_pay', 'google_pay']);

function createChargeService({ store, psp }) {
  if (!store || !psp) throw new Error('createChargeService: missing dependencies');

  /**
   * @param {object} args
   * @param {'pix'|'apple_pay'|'google_pay'} [args.wallet]  omitted → Pix.
   * @param {string} [args.paymentToken]  wallet-sheet token (required for wallets)
   */
  return async function createCharge({ checkId, amountCents, tipCents = 0, payerLabel = null, wallet = null, paymentToken = null, payerDocument = null }) {
    if (typeof checkId !== 'string' || !checkId) throw badRequest('checkId required');
    // CPF do pagador — o adquirente exige em cartão (BR). Normaliza e valida
    // formato aqui; nulo é aceito (Pix pode dispensar).
    if (payerDocument !== null) {
      payerDocument = String(payerDocument).replace(/\D/g, '');
      if (!/^\d{11}$/.test(payerDocument)) throw badRequest('CPF inválido (11 dígitos)');
    }
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw badRequest('amountCents must be a non-negative integer');
    if (!Number.isSafeInteger(tipCents) || tipCents < 0) throw badRequest('tipCents must be a non-negative integer');
    if (amountCents + tipCents === 0) throw badRequest('zero-value charge');
    if (payerLabel !== null && (typeof payerLabel !== 'string' || payerLabel.length > 60)) {
      throw badRequest('payerLabel must be a string of at most 60 chars');
    }
    if (wallet !== null && !WALLETS.includes(wallet)) throw badRequest(`carteira desconhecida: ${wallet}`);

    const venue = await store.getVenueForCheck(checkId);
    if (!venue) throw badRequest('unknown check');
    if (!venue.pspRecipientId) {
      // Compliance gate: without a settlement recipient the funds would land
      // on the platform account (BACEN Res. 494 custody territory).
      throw badRequest('venue has no settlement recipient configured');
    }

    const state = reduce(await store.loadEvents(checkId));
    if (!state) throw badRequest('check has no events');
    if (state.status === 'fechada') throw badRequest('check is closed');
    const remaining = remainingCents(state);
    if (amountCents > remaining) {
      throw badRequest(`amount exceeds remaining (${remaining} centavos)`);
    }

    const chargeRef = `${checkId}:${state.paidCents}:${amountCents}:${tipCents}`;
    let charge;
    if (wallet) {
      // Apple/Google Pay = tokenized CARD charge. Same money gates as Pix;
      // tips ride along exactly the same (Lei 13.419 tracking downstream).
      charge = await psp.createWalletCharge({
        chargeRef, amountCents, tipCents,
        recipientId: venue.pspRecipientId,
        wallet, paymentToken, payerDocument,
      });
    } else {
      charge = await psp.createPixCharge({
        chargeRef, amountCents, tipCents,
        recipientId: venue.pspRecipientId,
        description: payerLabel ? `Racha ${payerLabel}` : 'Racha',
        payerDocument,
      });
    }

    await store.registerCharge({
      checkId, txid: charge.txid, amountCents, tipCents, payerLabel,
      method: wallet ? 'card' : 'pix',
    });

    return {
      txid: charge.txid,
      copiaECola: charge.copiaECola ?? null, // wallets have no BR Code
      expiresAt: charge.expiresAt ?? null,
      amountCents, tipCents,
      method: wallet ? 'card' : 'pix',
      wallet: wallet ?? null,
    };
  };
}

module.exports = { createChargeService };
