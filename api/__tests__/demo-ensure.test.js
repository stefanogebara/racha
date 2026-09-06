'use strict';
/**
 * A mesa da demo se auto-cura e a conta dela é a conta que a landing prova.
 */
const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require('../_lib/store/memory');
const { DEMO_TOKEN, DEMO_ITEMS, DEMO_TOTAL_CENTS, ensureDemoCheck, resetDemoCheck } = require('../_lib/demo');

describe('demo table self-heal', () => {
  test('empty store → ensure creates venue, table and an open check with the demo items', async () => {
    const store = createMemoryStore();
    expect(await store.getCheckByQrToken(DEMO_TOKEN)).toBeNull();
    const view = await ensureDemoCheck(store);
    expect(view.state.totalCents).toBe(DEMO_TOTAL_CENTS);
    expect(view.check.items.map((i) => i.name)).toEqual(DEMO_ITEMS.map((i) => i.name));
    expect(view.venue.name).toMatch(/demonstra/);
  });

  test('ensure is idempotent: same open check on the second call', async () => {
    const store = createMemoryStore();
    const a = await ensureDemoCheck(store);
    const b = await ensureDemoCheck(store);
    expect(b.check.id).toBe(a.check.id);
  });

  test('closed demo check → ensure reopens a fresh one on the same table', async () => {
    const store = createMemoryStore();
    const a = await ensureDemoCheck(store);
    await store.appendEvent(a.check.id, 'CLOSED', {});
    expect(await store.getCheckByQrToken(DEMO_TOKEN)).toBeNull();
    const b = await ensureDemoCheck(store);
    expect(b.check.id).not.toBe(a.check.id);
    expect(b.state.totalCents).toBe(DEMO_TOTAL_CENTS);
    expect(b.table.label).toBe(a.table.label);
  });

  test('reset: fresh → "já fresca"; partly paid → closes and reopens', async () => {
    const store = createMemoryStore();
    const a = await ensureDemoCheck(store);
    expect((await resetDemoCheck(store)).status).toBe('já fresca');
    await store.appendEvent(a.check.id, 'PAYMENT_CONFIRMED', { txid: 't1', amountCents: 1000, tipCents: 0, payerLabel: null });
    const r = await resetDemoCheck(store);
    expect(r).toEqual({ status: 'resetada', totalCents: DEMO_TOTAL_CENTS });
    const b = await store.getCheckByQrToken(DEMO_TOKEN);
    expect(b.check.id).not.toBe(a.check.id);
    expect(b.state.paidCents).toBe(0);
  });

  // --- a demo NUNCA toca uma mesa de verdade -------------------------------
  // `RACHA_DEMO_TABLE_TOKEN` é uma env que alguém pode digitar errado. Sem a
  // asserção de identidade, um typo apontando pro token de uma mesa real fazia
  // `resetDemoCheck` FECHAR a conta aberta dela por uma rota pública sem auth.
  async function realVenueWithToken(store, token) {
    const venue = await store.createVenue({ name: 'Bar de Verdade', servicoBp: 1000, pspRecipientId: 'rcpt_live_1' });
    const table = await store.seedTable(venue.id, 'Mesa 7', token);
    await store.openCheck(table.qrToken, [{ id: 'r1', name: 'Picanha', priceCents: 5000 }]);
    return { venue, table };
  }

  test('ensure refuses a token bound to a REAL venue and leaves its check untouched', async () => {
    const store = createMemoryStore();
    await realVenueWithToken(store, 'mesa7real');
    const before = await store.getCheckByQrToken('mesa7real');
    await expect(ensureDemoCheck(store, 'mesa7real')).rejects.toThrow(/not the demo table/);
    const after = await store.getCheckByQrToken('mesa7real');
    expect(after.check.id).toBe(before.check.id);
    expect(after.state.totalCents).toBe(5000);
  });

  test('reset refuses a REAL table BEFORE closing anything', async () => {
    const store = createMemoryStore();
    await realVenueWithToken(store, 'mesa7real');
    const before = await store.getCheckByQrToken('mesa7real');
    await expect(resetDemoCheck(store, 'mesa7real')).rejects.toThrow(/not the demo table/);
    const after = await store.getCheckByQrToken('mesa7real');
    expect(after.check.id).toBe(before.check.id); // não fechou, não abriu outra
    expect(after.state.totalCents).toBe(5000);
  });

  test('a venue whose pspRecipientId is real is not the demo, even if isTest', async () => {
    const store = createMemoryStore();
    const v = await store.createVenue({ name: 'Quase demo', servicoBp: 1000, pspRecipientId: 'rcpt_live_2', isTest: true });
    await store.seedTable(v.id, 'Mesa demo', 'quasedemo');
    await expect(ensureDemoCheck(store, 'quasedemo')).rejects.toThrow(/not the demo table/);
  });

  test('the demo venue it creates is marked isTest + rcpt_demo (kept out of the money sweep)', async () => {
    const store = createMemoryStore();
    await ensureDemoCheck(store);
    const rows = await store.listVenueActivation();
    const demo = rows.find((v) => /demonstra/.test(v.name));
    expect(demo.isTest).toBe(true);
    const table = await store.findTableAnyState(DEMO_TOKEN);
    const venue = await store.getVenue(table.venueId);
    expect(venue.pspRecipientId).toBe('rcpt_demo');
  });

  test('a DEACTIVATED demo table throws instead of orphaning one venue per request', async () => {
    const store = createMemoryStore();
    await ensureDemoCheck(store);
    const table = await store.findTableAnyState(DEMO_TOKEN);
    const open = await store.getCheckByQrToken(DEMO_TOKEN);
    await store.appendEvent(open.check.id, 'CLOSED', {}); // mesa só desativa sem conta aberta
    await store.setTableActive(table.id, false);
    const antes = (await store.listVenueActivation()).length;
    await expect(ensureDemoCheck(store)).rejects.toThrow(/deactivated/);
    await expect(ensureDemoCheck(store)).rejects.toThrow(/deactivated/);
    expect((await store.listVenueActivation()).length).toBe(antes); // zero órfãs
  });

  test('a fixed token cannot be re-pointed at another venue (mirrors the DB unique)', async () => {
    const store = createMemoryStore();
    await ensureDemoCheck(store);
    const other = await store.createVenue({ name: 'Outro', servicoBp: 1000, pspRecipientId: 'rcpt_live_3' });
    // seedTable é síncrono no store de memória — o throw é imediato.
    expect(() => store.seedTable(other.id, 'Mesa demo', DEMO_TOKEN)).toThrow(/duplicate table token/);
  });

  test('the landing proves THIS bill: PROOF_TOTAL in Home.tsx equals the demo total', () => {
    const home = fs.readFileSync(path.join(__dirname, '../../apps/web/src/Home.tsx'), 'utf8');
    const m = home.match(/const PROOF_TOTAL = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(DEMO_TOTAL_CENTS);
    expect(DEMO_TOTAL_CENTS).toBe(23710);
  });
});
