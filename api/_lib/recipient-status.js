'use strict';

/**
 * Status do recebedor Pagar.me e o que fazer com cada um.
 *
 * O onboarding passa por status intermediários (registration → affiliation → …)
 * antes de chegar num TERMINAL. O dono só quer saber do terminal:
 *   - active                      → aprovado ("já pode receber")
 *   - refused/suspended/blocked    → problema ("não aprovado, corrija")
 * Os intermediários a gente RASTREIA (pra continuar vigiando), mas NÃO avisa —
 * senão o dono levaria um "seu status mudou" a cada passo do KYC.
 */

const RECIPIENT_TERMINAL = Object.freeze(['active', 'refused', 'suspended', 'blocked']);

/** Terminal = vale avisar o dono E parar de vigiar. */
function isTerminalRecipientStatus(status) {
  return RECIPIENT_TERMINAL.includes(status);
}

module.exports = { RECIPIENT_TERMINAL, isTerminalRecipientStatus };
