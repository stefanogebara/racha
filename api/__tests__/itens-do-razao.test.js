'use strict';

/**
 * OS ITENS DA CONTA VÊM DO RAZÃO — da mesma leitura que dá o total.
 *
 * O leitor pegava `pos_ref` numa ida e os eventos noutra; um ajuste no meio
 * mostrava itens velhos com total novo (compliance e segurança, PR #29).
 */
const { itensDoRazao, validateEvent, reduce } = require('../_lib/checks/check-state');
const { createMemoryStore } = require('../_lib/store/memory');
const { createSupabaseStore } = require('../_lib/store/supabase');
const { createCheckService } = require('../_lib/checks/check-service');

const it = (name, priceCents) => ({ id: name, name, priceCents });
const ev = (seq, type, payload) => ({ seq, type, payload });

describe('itensDoRazao', () => {
  test('o ÚLTIMO OPENED/ADJUSTED decide', () => {
    expect(itensDoRazao([ev(1, 'OPENED', { totalCents: 100, items: [it('A', 100)] })])).toEqual([it('A', 100)]);
    expect(itensDoRazao([
      ev(1, 'OPENED', { totalCents: 100, items: [it('A', 100)] }),
      ev(2, 'PAYMENT_CONFIRMED', { txid: 't', amountCents: 50 }),
      ev(3, 'ADJUSTED', { totalCents: 300, items: [it('B', 300)] }),
      ev(4, 'PAYMENT_CONFIRMED', { txid: 'u', amountCents: 50 }),
    ])).toEqual([it('B', 300)]);
  });
  test('último sem itens (conta antiga) → null, e NÃO os itens de um evento anterior', () => {
    expect(itensDoRazao([
      ev(1, 'OPENED', { totalCents: 100, items: [it('A', 100)] }),
      ev(2, 'ADJUSTED', { totalCents: 300 }),
    ])).toBeNull();
    expect(itensDoRazao([])).toBeNull();
    expect(itensDoRazao(undefined)).toBeNull();
  });
  test('devolve cópia: quem mexe no retorno não mexe no razão', () => {
    const log = [ev(1, 'OPENED', { totalCents: 100, items: [it('A', 100)] })];
    itensDoRazao(log)[0].priceCents = 1;
    expect(log[0].payload.items[0].priceCents).toBe(100);
  });
  test('OPENED com itens que não somam o total é recusado', () => {
    expect(() => validateEvent({ type: 'OPENED', payload: { totalCents: 100, items: [it('A', 99)] } }, null)).toThrow(/OPENED\.items sum 99/);
    expect(() => validateEvent({ type: 'OPENED', payload: { totalCents: 100 } }, null)).not.toThrow();
  });
});

describe('o leitor serve os itens do razão', () => {
  test('memória: depois de abrir e de ajustar, itens e total vêm juntos do razão', async () => {
    const store = createMemoryStore();
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000 });
    const table = store.seedTable(venue.id, 'Mesa 1');
    const svc = createCheckService({ store });
    const { checkId } = await svc.openCheck({ tableId: table.id, items: [{ name: 'A', priceCents: 1000 }] });
    expect((await store.loadEvents(checkId))[0].payload.items).toEqual([{ id: 'i1', name: 'A', priceCents: 1000 }]);
    await svc.adjustCheck({ checkId, items: [{ name: 'B', priceCents: 700 }, { name: 'C', priceCents: 300 }] });
    const v = await store.getCheckByQrToken(table.qrToken);
    expect(v.check.items.map((i) => i.name)).toEqual(['B', 'C']);
    expect(v.check.items.reduce((s, i) => s + i.priceCents, 0)).toBe(v.state.totalCents);
  });

  test('supabase: com pos_ref VELHO e razão NOVO (o rasgo), serve o do razão', async () => {
    const razao = [
      { check_id: '00000000-0000-4000-8000-0000000000c1', seq: 1, type: 'OPENED', payload: { totalCents: 1000 }, psp_event_id: null, created_at: '2026-09-25T10:00:00Z' },
      { check_id: '00000000-0000-4000-8000-0000000000c1', seq: 2, type: 'ADJUSTED', payload: { totalCents: 1500, items: [it('Novo', 1500)] }, psp_event_id: null, created_at: '2026-09-25T10:01:00Z' },
    ];
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: clienteFalso({
      venue_tables: { id: 't1', label: 'Mesa 1', active: true, training: false, venues: { name: 'Casa', market: 'br', servico_basis_points: 1000, cnpj: null } },
      checks: [{ id: '00000000-0000-4000-8000-0000000000c1', pos_ref: JSON.stringify([it('Velho', 1000)]), opened_at: '2026-09-25T10:00:00Z' }],
      check_events: razao,
    }) });
    const v = await store.getCheckByQrToken('qr1');
    expect(v.check.items).toEqual([it('Novo', 1500)]);
    expect(v.state.totalCents).toBe(1500);
  });

  test('supabase: conta antiga, sem itens no razão → cai no pos_ref', async () => {
    const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: clienteFalso({
      venue_tables: { id: 't1', label: 'Mesa 1', active: true, training: false, venues: { name: 'Casa', market: 'br', servico_basis_points: 1000, cnpj: null } },
      checks: [{ id: '00000000-0000-4000-8000-0000000000c1', pos_ref: JSON.stringify([it('Antigo', 1000)]), opened_at: '2026-09-25T10:00:00Z' }],
      check_events: [{ check_id: '00000000-0000-4000-8000-0000000000c1', seq: 1, type: 'OPENED', payload: { totalCents: 1000 }, psp_event_id: null, created_at: '2026-09-25T10:00:00Z' }],
    }) });
    expect((await store.getCheckByQrToken('qr1')).check.items).toEqual([it('Antigo', 1000)]);
  });
});

/** Um cliente PostgREST mínimo: `from(tabela)` encadeável, que resolve pelo nome da tabela. */
function clienteFalso({ venue_tables: mesa, checks, check_events: eventos }) {
  const q = (tabela) => {
    const b = {
      select() { return b; }, eq() { return b; }, neq() { return b; }, in() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle: async () => ({ data: tabela === 'venue_tables' ? mesa : null, error: null }),
      single: async () => ({ data: tabela === 'venue_tables' ? mesa : null, error: null }),
      then(ok, falha) {
        const data = tabela === 'checks' ? checks : tabela === 'check_events' ? eventos : [];
        return Promise.resolve({ data, error: null }).then(ok, falha);
      },
    };
    return b;
  };
  return { from: q, rpc: async () => ({ data: null, error: null }) };
}
void reduce;
