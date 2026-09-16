'use strict';

/**
 * UM MEMBRO NÃO É UM DONO.
 *
 * `venue_members` nasceu com `role in ('owner','staff')` e as duas leituras de
 * autorização ignoravam a coluna: qualquer linha abria o painel, o
 * `/api/refund`, os repasses e o documento da casa. Não vazava porque o único
 * escritor grava `'owner'` fixo — medido em produção em 2026-09-16: dez linhas,
 * todas `owner`. O defeito estava esperando a PRIMEIRA linha de `staff`, e ela
 * chegaria com cara de feature nova funcionando.
 *
 * Os dois stores são medidos, porque metade do conserto é o erro de sempre.
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { createSupabaseStore } = require('../_lib/store/supabase');
const { PAPEL_DE_DONO } = require('../_lib/store/papeis');

const UID = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';

/** Falso que devolve as linhas de `venue_members` que casam com os filtros. */
function clienteComMembros(linhas) {
  const from = (tabela) => {
    const f = {};
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; }, in() { return b; },
      eq(col, val) { f[col] = val; return b; },
      maybeSingle() { return casam().then((d) => ({ data: d[0] ?? null, error: null })); },
      single() { return b.maybeSingle(); },
      then(ok, falha) { return casam().then((d) => ({ data: d, error: null })).then(ok, falha); },
    };
    function casam() {
      if (tabela !== 'venue_members') return Promise.resolve([]);
      return Promise.resolve(linhas.filter((r) => Object.entries(f).every(([c, v]) => r[c] === v)));
    }
    return b;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

const membro = (role) => ({
  id: 'm1', user_id: UID, venue_id: VID, role,
  venues: { id: VID, name: 'Casa', city: null, servico_basis_points: 1000, psp_recipient_id: null, market: 'BR' },
});

describe('o papel é conferido — nos dois stores', () => {
  test.each([['owner', true], ['staff', false]])(
    'supabase: um membro `%s` é dono? %p', async (role, esperado) => {
      const store = createSupabaseStore({ client: clienteComMembros([membro(role)]) });
      expect(await store.userOwnsVenue(UID, VID)).toBe(esperado);
      expect((await store.listVenuesForOwner(UID)).length).toBe(esperado ? 1 : 0);
    });

  test.each([['owner', true], ['staff', false]])(
    'memória: um membro `%s` é dono? %p', async (role, esperado) => {
      const store = createMemoryStore();
      const v = await store.seedVenue({ name: 'Casa', servicoBp: 1000 });
      await store.addVenueMember(v.id, UID, role);
      expect(await store.userOwnsVenue(UID, v.id)).toBe(esperado);
      expect((await store.listVenuesForOwner(UID)).length).toBe(esperado ? 1 : 0);
    });

  test('e o portão do `auth` recusa o staff com 404, não com 403', async () => {
    const { createAuth } = require('../_lib/auth');
    const store = createMemoryStore();
    const v = await store.seedVenue({ name: 'Casa', servicoBp: 1000 });
    await store.addVenueMember(v.id, UID, 'staff');
    const authClient = { auth: { getUser: async () => ({ data: null, error: new Error('não usado aqui') }) } };
    const auth = createAuth({ authClient, store });
    // 404 e não 403: não se confirma a EXISTÊNCIA da casa a quem não é dono.
    await expect(auth.requireVenueOwner({ id: UID }, v.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('o papel que o código usa é um papel que o banco aceita', () => {
  test('`PAPEL_DE_DONO` está no CHECK da migração que criou a tabela', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
    const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const m = sql.match(/role text not null default '(\w+)' check \(role in \(([^)]+)\)\)/);
    expect(m).not.toBeNull();
    const aceitos = m[2].split(',').map((x) => x.trim().replace(/'/g, ''));
    // Um papel que o banco recusa vira um portão que nunca abre; um que o
    // código não conhece vira um portão que sempre abre.
    expect(aceitos).toContain(PAPEL_DE_DONO);
    expect(m[1]).toBe(PAPEL_DE_DONO);
  });

  test('ninguém escreve o papel por literal — só pela constante', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const raiz = path.join(__dirname, '..');
    for (const rel of ['_lib/store/supabase.js', '_lib/store/memory.js', '_app/router.js']) {
      const fonte = fs.readFileSync(path.join(raiz, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect({ rel, achado: /['"`]owner['"`]/.test(fonte) }).toEqual({ rel, achado: false });
    }
  });
});
