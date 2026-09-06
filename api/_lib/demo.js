'use strict';
/**
 * A mesa pública de demonstração (`?t=demoracha`) — UMA fonte pra conta que a
 * landing mostra, o dev-server semeia e o cron reseta.
 *
 * A landing prova "R$237.10 ÷ 3" com a conta desta mesa (Home.tsx: PROOF_TOTAL).
 * Se os itens mudarem, o total muda, e a prova mente — o teste
 * `demo-ensure.test.js` amarra os dois.
 *
 * `ensureDemoCheck` é auto-cura: um ambiente sem a mesa (preview do Vercel sem
 * store persistente, banco novo) ou com a conta da demo fechada (alguém pagou
 * tudo) NÃO mostra "conta não encontrada" no telefone da landing — cria/reabre.
 * Só toca o token fixo da demo; nunca uma mesa real.
 */

const DEMO_TOKEN = 'demoracha';
const DEMO_VENUE_NAME = 'Bar do Zé — demonstração';

const DEMO_ITEMS = Object.freeze([
  { id: 'd1', name: 'Picanha na chapa', priceCents: 8990 },
  { id: 'd2', name: 'Chopp artesanal (4x)', priceCents: 5560 },
  { id: 'd3', name: 'Batata rústica', priceCents: 3290 },
  { id: 'd4', name: 'Caipirinha (2x)', priceCents: 3980 },
  { id: 'd5', name: 'Pudim da casa', priceCents: 1890 },
].map(Object.freeze));

const DEMO_TOTAL_CENTS = DEMO_ITEMS.reduce((s, i) => s + i.priceCents, 0); // 23710

function isFresh(view) {
  return Boolean(view) && view.state.paidCents === 0 && view.state.totalCents === DEMO_TOTAL_CENTS;
}

/** Garante mesa + conta aberta pra demo. Devolve a view (nunca null). */
async function ensureDemoCheck(store, token = DEMO_TOKEN) {
  const open = await store.getCheckByQrToken(token);
  if (open) return open;
  const hit = await store.getVenueByTableToken(token);
  if (!hit) {
    const venue = await store.seedVenue({ name: DEMO_VENUE_NAME, servicoBp: 1000, pspRecipientId: 'rcpt_demo' });
    await store.seedTable(venue.id, 'Mesa demo', token);
  }
  await store.openCheck(token, DEMO_ITEMS.map((i) => ({ ...i })));
  const view = await store.getCheckByQrToken(token);
  if (!view) throw new Error('demo check did not open');
  return view;
}

/** Fecha a conta atual (se houver) e abre uma fresca. Idempotente se já fresca. */
async function resetDemoCheck(store, token = DEMO_TOKEN) {
  const view = await store.getCheckByQrToken(token);
  if (isFresh(view)) return { status: 'já fresca', totalCents: DEMO_TOTAL_CENTS };
  if (view) await store.appendEvent(view.check.id, 'CLOSED', {});
  await ensureDemoCheck(store, token);
  return { status: 'resetada', totalCents: DEMO_TOTAL_CENTS };
}

module.exports = { DEMO_TOKEN, DEMO_ITEMS, DEMO_TOTAL_CENTS, ensureDemoCheck, resetDemoCheck, isFresh };
