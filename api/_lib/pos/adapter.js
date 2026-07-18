'use strict';

/**
 * POS adapter contract + registry.
 *
 * A pay-at-table product is only as good as its ability to (1) get the open
 * check (comanda) for a table and (2) write the payment back so the POS shows
 * it settled. Every venue has a `pos_provider`; this resolves the right
 * adapter. Manual mode ships now (the pilot); Colibri / Simphony are the next
 * integrations and slot in here without touching callers.
 *
 * @typedef {Object} PosAdapter
 * @property {string} provider  'manual' | 'colibri' | 'simphony'
 * @property {{ pull: boolean, writeBack: boolean }} capabilities
 *   pull      — can fetch the live open check from the POS (manual: false).
 *   writeBack — can post a confirmed payment to the POS (manual: false).
 * @property {() => Promise<{items: Array, totalCents: number}|null>} pullOpenCheck
 *   Fetch the live open check for a table from the POS. Manual: returns null.
 * @property {() => Promise<{ok: boolean, ref?: string, skipped?: string}>} writeBackPayment
 *   Post a confirmed payment back to the POS. Manual: no-op { ok, skipped }.
 */

const { createManualAdapter } = require('./manual');

const PROVIDERS = Object.freeze(['manual', 'colibri', 'simphony']);

/**
 * Resolve the POS adapter for a venue. Unknown/unimplemented providers throw a
 * clear error rather than silently degrading — a venue mis-flagged as an
 * unbuilt integration must fail loudly, not fall back to manual and hide it.
 * @param {{ posProvider?: string }} venue
 * @returns {PosAdapter}
 */
function resolvePosAdapter(venue) {
  const provider = (venue && venue.posProvider) || 'manual';
  switch (provider) {
    case 'manual':
      return createManualAdapter();
    case 'colibri':
    case 'simphony':
      throw new Error(`integração POS '${provider}' ainda não implementada (próxima fatia)`);
    default:
      throw new Error(`provider POS desconhecido: ${provider}`);
  }
}

module.exports = { resolvePosAdapter, PROVIDERS };
