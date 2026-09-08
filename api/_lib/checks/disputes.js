'use strict';

/**
 * Quantas disputas uma conta tem, e em que pé.
 *
 * O restaurante é julgado pelo adquirente por TAXA DE CHARGEBACK — é o número
 * que decide se ele continua aceitando cartão, e acima de certo patamar a
 * bandeira aplica programa de monitoramento. O razão já sabia o desfecho de
 * cada disputa (`disputeStatus` no pagamento) e nada mostrava isso pra ninguém:
 * o dono não tinha como ver o próprio número. Achado pela revisão de
 * compliance de 2026-09-08.
 *
 * Contagem, não valor: a taxa que o adquirente olha é por TRANSAÇÃO.
 */
function disputeCounts(state) {
  const zero = { open: 0, lost: 0, won: 0 };
  if (!state || !state.payments) return zero;
  return Object.values(state.payments).reduce((acc, pay) => {
    if (pay.disputeStatus === 'lost') acc.lost += 1;
    else if (pay.disputeStatus === 'won' || pay.disputeStatus === 'warning_closed') acc.won += 1;
    else if (pay.disputedAmountCents > 0) acc.open += 1;
    return acc;
  }, { ...zero });
}

module.exports = { disputeCounts };
