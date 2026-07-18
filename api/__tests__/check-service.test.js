'use strict';

/**
 * Check lifecycle service + POS adapter registry. The lifecycle runs against
 * BOTH stores (memory always; supabase when creds present). Manual mode is the
 * push path: open → (adjust) → close, all through the strict event gate.
 */

const crypto = require('crypto');
const { createCheckService, normalizeItems } = require('../_lib/checks/check-service');
const { reduce, STATUS } = require('../_lib/checks/check-state');
const { resolvePosAdapter, PROVIDERS } = require('../_lib/pos/adapter');
const { createMemoryStore } = require('../_lib/store/memory');

// --- pure normalization -----------------------------------------------------
describe('normalizeItems', () => {
  test('itemized → validated list; total = sum', () => {
    const out = normalizeItems({ items: [{ name: 'Picanha', priceCents: 8990 }, { name: 'Chopp', priceCents: 2000 }] });
    expect(out).toHaveLength(2);
    expect(out.reduce((s, i) => s + i.priceCents, 0)).toBe(10990);
  });
  test('total-only → a single "Total da conta" line', () => {
    expect(normalizeItems({ totalCents: 5000 })).toEqual([{ id: 'total', name: 'Total da conta', priceCents: 5000 }]);
  });
  test('rejects empty, zero, negative, nameless', () => {
    expect(() => normalizeItems({})).toThrow(/itens ou um total/);
    expect(() => normalizeItems({ totalCents: 0 })).toThrow(/maior que zero/);
    expect(() => normalizeItems({ items: [{ name: 'x', priceCents: -1 }] })).toThrow(/inválido/);
    expect(() => normalizeItems({ items: [{ name: '  ', priceCents: 100 }] })).toThrow(/nome/);
    expect(() => normalizeItems({ items: [{ name: 'a', priceCents: 0 }] })).toThrow(/não pode ser zero/);
  });
});

// --- POS adapter registry ---------------------------------------------------
describe('resolvePosAdapter', () => {
  test('manual adapter: no pull, no write-back, no-op payment sync', async () => {
    const a = resolvePosAdapter({ posProvider: 'manual' });
    expect(a.provider).toBe('manual');
    expect(a.capabilities).toEqual({ pull: false, writeBack: false });
    expect(await a.pullOpenCheck()).toBeNull();
    expect(await a.writeBackPayment()).toEqual({ ok: true, skipped: 'manual' });
  });
  test('defaults to manual when unset', () => {
    expect(resolvePosAdapter({}).provider).toBe('manual');
    expect(resolvePosAdapter(null).provider).toBe('manual');
  });
  test('unbuilt integrations fail LOUDLY (never silent-degrade to manual)', () => {
    expect(() => resolvePosAdapter({ posProvider: 'colibri' })).toThrow(/não implementada/);
    expect(() => resolvePosAdapter({ posProvider: 'simphony' })).toThrow(/não implementada/);
    expect(() => resolvePosAdapter({ posProvider: 'bogus' })).toThrow(/desconhecido/);
    expect(PROVIDERS).toEqual(['manual', 'colibri', 'simphony']);
  });
});

// --- lifecycle against both stores -----------------------------------------
const impls = [{ name: 'memory', make: async () => ({ store: createMemoryStore(), cleanup: async () => {} }) }];
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createSupabaseStore } = require('../_lib/store/supabase');
  impls.push({
    name: 'supabase',
    make: async () => {
      const store = createSupabaseStore();
      const created = [];
      const orig = store.createVenue.bind(store);
      store.createVenue = async (a) => { const v = await orig({ ...a, name: `__cs__ ${a.name}` }); created.push(v.id); return v; };
      return { store, cleanup: async () => { for (const id of created) await store.client.from('venues').delete().eq('id', id); } };
    },
  });
}

describe.each(impls)('check lifecycle [$name]', ({ make }) => {
  let store, cleanup, svc;
  beforeAll(async () => { ({ store, cleanup } = await make()); svc = createCheckService({ store }); });
  afterAll(async () => { await cleanup(); });

  async function freshTable() {
    const v = await store.createVenue({ name: 'Lifecycle', servicoBp: 1000 });
    return store.createTable(v.id, `Mesa ${crypto.randomInt(10000, 99999)}`);
  }

  test('open a total-only check → the diner sees it via the QR', async () => {
    const t = await freshTable();
    const r = await svc.openCheck({ tableId: t.id, totalCents: 8500 });
    expect(r.totalCents).toBe(8500);
    const view = await store.getCheckByQrToken(t.qrToken);
    expect(view.state.status).toBe(STATUS.ABERTA);
    expect(view.state.totalCents).toBe(8500);
    expect(view.check.items).toEqual([{ id: 'total', name: 'Total da conta', priceCents: 8500 }]);
  });

  test('one open check per table (second open refused)', async () => {
    const t = await freshTable();
    await svc.openCheck({ tableId: t.id, totalCents: 1000 });
    await expect(svc.openCheck({ tableId: t.id, totalCents: 2000 })).rejects.toThrow(/já tem uma conta/);
  });

  test('adjust updates BOTH the total and the items the diner sees', async () => {
    const t = await freshTable();
    const { checkId } = await svc.openCheck({ tableId: t.id, items: [{ name: 'Prato', priceCents: 4000 }] });
    await svc.adjustCheck({ checkId, items: [{ name: 'Prato', priceCents: 4000 }, { name: 'Sobremesa', priceCents: 1800 }] });
    const view = await store.getCheckByQrToken(t.qrToken);
    expect(view.state.totalCents).toBe(5800);
    expect(view.check.items.map((i) => i.name)).toEqual(['Prato', 'Sobremesa']);
  });

  test('close, then open/adjust/close are all refused on the closed check', async () => {
    const t = await freshTable();
    const { checkId } = await svc.openCheck({ tableId: t.id, totalCents: 3000 });
    await svc.closeCheck({ checkId });
    expect(reduce(await store.loadEvents(checkId)).status).toBe(STATUS.FECHADA);
    await expect(svc.adjustCheck({ checkId, totalCents: 4000 })).rejects.toThrow(/closed|fechada/i);
    await expect(svc.closeCheck({ checkId })).rejects.toThrow(/closed|already/i);
    // the table is free again → a NEW check can open
    const r2 = await svc.openCheck({ tableId: t.id, totalCents: 1500 });
    expect(r2.checkId).not.toBe(checkId);
  });

  test('open on unknown / inactive table is refused', async () => {
    await expect(svc.openCheck({ tableId: 'nope', totalCents: 1000 })).rejects.toThrow(/não encontrada/);
    const t = await freshTable();
    await store.setTableActive(t.id, false);
    await expect(svc.openCheck({ tableId: t.id, totalCents: 1000 })).rejects.toThrow(/desativada/);
  });
});
