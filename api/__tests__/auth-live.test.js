'use strict';

/**
 * LIVE Supabase coverage for the auth-critical membership methods. The unit
 * tests (auth.test.js) run these against the memory store; this closes the gap
 * the review flagged — the authorization logic that decides who can touch a
 * venue had never run against real Postgres + the auth.users FK.
 *
 * Skipped unless SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set. Creates two
 * real GoTrue users + a venue, exercises ownership, and cleans everything up.
 */

const hasLive = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = hasLive ? describe : describe.skip;

d('venue_members (live supabase)', () => {
  let admin, store, userA, userB, venue, table;

  beforeAll(async () => {
    const { createClient } = require('@supabase/supabase-js');
    admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { createSupabaseStore } = require('../_lib/store/supabase');
    store = createSupabaseStore();
    const mk = async (tag) => {
      const { data, error } = await admin.auth.admin.createUser({
        email: `authlive+${tag}.${Date.now()}@teste.demo`, password: 'x'.repeat(16), email_confirm: true,
      });
      if (error) throw new Error(error.message);
      return data.user.id;
    };
    userA = await mk('a');
    userB = await mk('b');
    venue = await store.createVenue({ name: `__authlive__ ${Date.now()}`, servicoBp: 1000 });
    table = await store.createTable(venue.id, 'Mesa Live');
  }, 30000);

  afterAll(async () => {
    if (venue) await store.client.from('venues').delete().eq('id', venue.id); // cascade removes members+tables
    if (userA) await admin.auth.admin.deleteUser(userA);
    if (userB) await admin.auth.admin.deleteUser(userB);
  }, 30000);

  test('owner is bound; a different user is not; isolation holds', async () => {
    await store.addVenueMember(venue.id, userA, 'owner');
    expect(await store.userOwnsVenue(userA, venue.id)).toBe(true);
    expect(await store.userOwnsVenue(userB, venue.id)).toBe(false);
  });

  test('listVenuesForOwner scopes to the user', async () => {
    const a = await store.listVenuesForOwner(userA);
    expect(a.map((v) => v.id)).toContain(venue.id);
    expect((await store.listVenuesForOwner(userB)).map((v) => v.id)).not.toContain(venue.id);
  });

  test('venueIdForTable resolves table → owning venue', async () => {
    expect(await store.venueIdForTable(table.id)).toBe(venue.id);
    expect(await store.venueIdForTable('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  test('addVenueMember is idempotent AND never silently changes an existing role', async () => {
    await store.addVenueMember(venue.id, userA, 'owner');
    await store.addVenueMember(venue.id, userA, 'staff'); // re-add with a DIFFERENT role
    const { data } = await store.client
      .from('venue_members').select('role').eq('venue_id', venue.id).eq('user_id', userA).single();
    expect(data.role).toBe('owner'); // preserved, not overwritten to 'staff'
  });
});
