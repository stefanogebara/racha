'use strict';

/**
 * Manual POS adapter — the pilot's universal path. The restaurant PUSHES the
 * check into Racha (owner enters the total/items in the panel), so there is no
 * POS to pull from and nothing to write back: Racha is the source of truth and
 * the restaurant reconciles from the Racha panel.
 *
 * It implements the full PosAdapter contract (see pos/adapter.js) so callers
 * and the UI are provider-agnostic; the "no-op" methods make the manual case
 * explicit rather than a special branch everywhere.
 */

function createManualAdapter() {
  return {
    provider: 'manual',
    capabilities: { pull: false, writeBack: false },

    /** Nothing to pull — a manual venue's checks originate in Racha itself. */
    async pullOpenCheck() {
      return null;
    },

    /** Nothing to sync — the restaurant sees the payment in the Racha panel. */
    async writeBackPayment() {
      return { ok: true, skipped: 'manual' };
    },
  };
}

module.exports = { createManualAdapter };
