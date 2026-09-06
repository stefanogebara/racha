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

  test('the landing proves THIS bill: PROOF_TOTAL in Home.tsx equals the demo total', () => {
    const home = fs.readFileSync(path.join(__dirname, '../../apps/web/src/Home.tsx'), 'utf8');
    const m = home.match(/const PROOF_TOTAL = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(DEMO_TOTAL_CENTS);
    expect(DEMO_TOTAL_CENTS).toBe(23710);
  });
});
