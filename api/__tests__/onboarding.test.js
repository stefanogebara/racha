'use strict';

/**
 * Onboarding + table/QR management — runs against BOTH stores (memory always;
 * supabase when creds present). The load-bearing security property: rotating
 * a table's QR makes the OLD token stop resolving, while the live check stays
 * reachable via the NEW token.
 */

const crypto = require('crypto');
const { createMemoryStore } = require('../_lib/store/memory');

const impls = [
  { name: 'memory', make: async () => ({ store: createMemoryStore(), cleanup: async () => {} }) },
];
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createSupabaseStore } = require('../_lib/store/supabase');
  impls.push({
    name: 'supabase',
    make: async () => {
      const store = createSupabaseStore();
      const created = [];
      const orig = store.createVenue.bind(store);
      store.createVenue = async (a) => { const v = await orig({ ...a, name: `__onb__ ${a.name}` }); created.push(v.id); return v; };
      return { store, cleanup: async () => { for (const id of created) await store.client.from('venues').delete().eq('id', id); } };
    },
  });
}

describe.each(impls)('onboarding + QR mgmt [$name]', ({ make }) => {
  let store, cleanup;
  beforeAll(async () => { ({ store, cleanup } = await make()); });
  afterAll(async () => { await cleanup(); });

  test('onboard a venue (no PSP recipient yet — charges gate later)', async () => {
    const v = await store.createVenue({ name: 'Cantina Nova', cnpj: '11444777000161', city: 'São Paulo', servicoBp: 1200 });
    expect(v.id).toBeTruthy();
    expect(v.servicoBp).toBe(1200);
    expect(v.pspRecipientId ?? null).toBeNull();
    const fetched = await store.getVenue(v.id);
    expect(fetched.name).toContain('Cantina Nova');
  });

  test('createVenue rejects bad serviço and blank name', async () => {
    await expect(store.createVenue({ name: '', servicoBp: 1000 })).rejects.toThrow(/name/);
    await expect(store.createVenue({ name: 'X', servicoBp: 4000 })).rejects.toThrow(/range/);
  });

  test('create tables, list them, reject duplicate labels', async () => {
    const v = await store.createVenue({ name: 'Mesas Ltda', servicoBp: 1000 });
    const suffix = crypto.randomInt(10000, 99999);
    const t1 = await store.createTable(v.id, `Mesa ${suffix}A`);
    await store.createTable(v.id, `Mesa ${suffix}B`);
    expect(t1.qrToken).toMatch(/^[a-f0-9]{32}$/);
    await expect(store.createTable(v.id, `Mesa ${suffix}A`)).rejects.toThrow(/duplicate/);
    const tables = await store.listTables(v.id);
    const mine = tables.filter((t) => t.label.startsWith(`Mesa ${suffix}`));
    expect(mine).toHaveLength(2);
    expect(mine.every((t) => t.active && !t.hasOpenCheck)).toBe(true);
  });

  test('SECURITY: rotating the QR kills the old token, keeps the live check on the new one', async () => {
    const v = await store.createVenue({ name: 'RotaTest', servicoBp: 1000, pspRecipientId: 'r' });
    const t = await store.createTable(v.id, `Mesa ${crypto.randomInt(10000, 99999)}`);
    await store.openCheck(t.qrToken, [{ id: 'a', name: 'A', priceCents: 5000 }]);

    // before rotation: the token resolves the open check
    const before = await store.getCheckByQrToken(t.qrToken);
    expect(before.state.totalCents).toBe(5000);

    const rot = await store.rotateTableQr(t.id);
    expect(rot.qrToken).not.toBe(t.qrToken);
    expect(rot.qrRotatedAt).toBeTruthy();

    // OLD token is dead — a photographed QR grants nothing anymore
    expect(await store.getCheckByQrToken(t.qrToken)).toBeNull();
    // NEW token resolves the SAME live check (check is tied to table, not token)
    const after = await store.getCheckByQrToken(rot.qrToken);
    expect(after).not.toBeNull();
    expect(after.state.totalCents).toBe(5000);

    // list reflects the rotation
    const listed = (await store.listTables(v.id)).find((x) => x.id === t.id);
    expect(listed.qrToken).toBe(rot.qrToken);
    expect(listed.hasOpenCheck).toBe(true);
  });

  test('SECURITY: a deactivated table stops resolving its QR', async () => {
    const v = await store.createVenue({ name: 'DeacTest', servicoBp: 1000, pspRecipientId: 'r' });
    const t = await store.createTable(v.id, `Mesa ${crypto.randomInt(10000, 99999)}`);
    await store.openCheck(t.qrToken, [{ id: 'a', name: 'A', priceCents: 1000 }]);
    expect(await store.getCheckByQrToken(t.qrToken)).not.toBeNull();

    await store.setTableActive(t.id, false);
    expect(await store.getCheckByQrToken(t.qrToken)).toBeNull();

    await store.setTableActive(t.id, true);
    expect(await store.getCheckByQrToken(t.qrToken)).not.toBeNull();
  });
});
