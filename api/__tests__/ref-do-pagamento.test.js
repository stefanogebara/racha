'use strict';

/**
 * O ✓ DO TELEFONE ESPERA A PRÓPRIA COBRANÇA.
 *
 * O telefone avançava pro "Pagamento confirmado" quando o `paidCents` da MESA
 * subia: numa mesa em que quatro pessoas pagam juntas, a primeira a pagar
 * confirmava as outras três (auditoria de fluxo, CRITICAL-1). A conta pública
 * agora carrega, por pagamento, a MARCA do txid (sha256, doze hex) — o telefone
 * compara com a da própria cobrança. O id do adquirente continua fora.
 */

const crypto = require('crypto');
const { reduce } = require('../_lib/checks/check-state');
const { publicCheckState } = require('../_lib/checks/public-state');

const paid = (txid, a) => ({ type: 'PAYMENT_CONFIRMED', payload: { txid, amountCents: a, tipCents: 0, method: 'pix' } });
const marca = (txid) => crypto.createHash('sha256').update(txid).digest('hex').slice(0, 12);

test('cada pagamento público carrega a MARCA do próprio txid — e nunca o txid', () => {
  const st = reduce([{ type: 'OPENED', payload: { totalCents: 40000 } }, paid('ch_ana_001', 10000), paid('ch_bruno_002', 10000)]);
  const pub = publicCheckState(st);
  expect(Object.values(pub.payments).map((p) => p.ref)).toEqual([marca('ch_ana_001'), marca('ch_bruno_002')]);
  expect(JSON.stringify(pub)).not.toMatch(/ch_ana_001|ch_bruno_002/);
});
