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

function createChargeService({ store, psp }) {
  if (!store || !psp) throw new Error('createChargeService: missing dependencies');

  return async function createCharge({ checkId, amountCents, tipCents = 0, payerLabel = null }) {
    if (typeof checkId !== 'string' || !checkId) throw badRequest('checkId required');
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw badRequest('amountCents must be a non-negative integer');
    if (!Number.isSafeInteger(tipCents) || tipCents < 0) throw badRequest('tipCents must be a non-negative integer');
    if (amountCents + tipCents === 0) throw badRequest('zero-value charge');
    if (payerLabel !== null && (typeof payerLabel !== 'string' || payerLabel.length > 60)) {
      throw badRequest('payerLabel must be a string of at most 60 chars');
    }

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

    const charge = await psp.createPixCharge({
      chargeRef: `${checkId}:${state.paidCents}:${amountCents}:${tipCents}`,
      amountCents,
      tipCents,
      recipientId: venue.pspRecipientId,
      description: payerLabel ? `Racha ${payerLabel}` : 'Racha',
    });

    await store.registerCharge({
      checkId, txid: charge.txid, amountCents, tipCents, payerLabel,
    });

    return {
      txid: charge.txid,
      copiaECola: charge.copiaECola,
      expiresAt: charge.expiresAt,
      amountCents, tipCents,
    };
  };
}

module.exports = { createChargeService };
