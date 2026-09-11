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
      // Prefix ONLY a valid name — an empty name must stay empty so the
      // blank-name validation still fires (and there's nothing to clean up).
      store.createVenue = async (a) => {
        const name = a.name ? `__onb__ ${a.name}` : a.name;
        const v = await orig({ ...a, name });
        created.push(v.id);
        return v;
      };
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
    const v = await store.createVenue({ name: 'RotaTest', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
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
    const v = await store.createVenue({ name: 'DeacTest', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    const t = await store.createTable(v.id, `Mesa ${crypto.randomInt(10000, 99999)}`);
    // deactivation is refused while a check is open, so close it first (append CLOSED)
    const check = await store.openCheck(t.qrToken, [{ id: 'a', name: 'A', priceCents: 1000 }]);
    expect(await store.getCheckByQrToken(t.qrToken)).not.toBeNull();
    await store.appendEvent(check.id, 'CLOSED', {});

    await store.setTableActive(t.id, false);
    expect(await store.getCheckByQrToken(t.qrToken)).toBeNull();

    await store.setTableActive(t.id, true);
    // check is closed now, so the QR resolves the TABLE but has no open check
    expect(await store.getCheckByQrToken(t.qrToken)).toBeNull();
  });

  // ---- regression: review findings 2026-07-17 (parity memory↔supabase) ----

  test('onboarding with NO CNPJ succeeds (optional field, both stores)', async () => {
    const v = await store.createVenue({ name: 'SemCNPJ', cnpj: null, servicoBp: 1000 });
    expect(v.id).toBeTruthy();
  });

  test('a CLOSED check is not returned by QR, and the badge clears (derived, not cache)', async () => {
    const v = await store.createVenue({ name: 'ClosedTest', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    const t = await store.createTable(v.id, `Mesa ${crypto.randomInt(10000, 99999)}`);
    const check = await store.openCheck(t.qrToken, [{ id: 'a', name: 'A', priceCents: 5000 }]);
    await store.appendEvent(check.id, 'PAYMENT_CONFIRMED', { txid: 'p1', amountCents: 5000, tipCents: 0, method: 'pix' });
    await store.appendEvent(check.id, 'CLOSED', {});

    // no open check → QR resolves the table but returns null (no bill leak)
    expect(await store.getCheckByQrToken(t.qrToken)).toBeNull();
    const listed = (await store.listTables(v.id)).find((x) => x.id === t.id);
    expect(listed.hasOpenCheck).toBe(false);
  });

  test('duplicate label blocked even for a DEACTIVATED table (matches DB constraint)', async () => {
    const v = await store.createVenue({ name: 'DupTest', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    const label = `Mesa ${crypto.randomInt(10000, 99999)}`;
    const t = await store.createTable(v.id, label);
    await store.setTableActive(t.id, false); // no open check → allowed
    await expect(store.createTable(v.id, label)).rejects.toThrow(/duplicate/);
  });

  test('deactivating a table WITH an open check is refused (no stranded diner)', async () => {
    const v = await store.createVenue({ name: 'StrandTest', servicoBp: 1000, pspRecipientId: 're_teste0000000000000000000' });
    const t = await store.createTable(v.id, `Mesa ${crypto.randomInt(10000, 99999)}`);
    await store.openCheck(t.qrToken, [{ id: 'a', name: 'A', priceCents: 1000 }]);
    await expect(store.setTableActive(t.id, false)).rejects.toThrow(/open check/);
  });

  test('listTables sorts locale-numeric (Mesa 2 before Mesa 10)', async () => {
    const v = await store.createVenue({ name: 'SortTest', servicoBp: 1000 });
    const tag = crypto.randomInt(100, 999);
    for (const n of [10, 2, 1]) await store.createTable(v.id, `M${tag} ${n}`);
    const labels = (await store.listTables(v.id)).filter((t) => t.label.startsWith(`M${tag} `)).map((t) => t.label);
    expect(labels).toEqual([`M${tag} 1`, `M${tag} 2`, `M${tag} 10`]);
  });
});
