'use strict';

/**
 * Owner auth — token verification, venue-ownership enforcement, and the
 * membership store methods. Uses a FAKE GoTrue client (real token
 * verification is exercised live against Supabase via the dev-server) + the
 * memory store. The load-bearing property: a user can never touch a venue or
 * table they don't own, and non-ownership looks like 404 (never leaks that an
 * id exists).
 */

const { createAuth, AuthError, bearer } = require('../_lib/auth');
const { createMemoryStore } = require('../_lib/store/memory');

// Fake GoTrue: 'tokU1'→user u1, 'tokU2'→user u2, anything else invalid.
const USERS = { tokU1: { id: 'u1', email: 'u1@x.com' }, tokU2: { id: 'u2', email: 'u2@x.com' } };
const fakeAuthClient = {
  auth: {
    getUser: async (token) => USERS[token]
      ? { data: { user: USERS[token] }, error: null }
      : { data: { user: null }, error: { message: 'invalid' } },
  },
};

async function world() {
  const store = createMemoryStore();
  const auth = createAuth({ authClient: fakeAuthClient, store });
  const v1 = await store.createVenue({ name: 'V1', servicoBp: 1000 });
  const v2 = await store.createVenue({ name: 'V2', servicoBp: 1000 });
  await store.addVenueMember(v1.id, 'u1', 'owner');
  await store.addVenueMember(v2.id, 'u2', 'owner');
  const t1 = await store.createTable(v1.id, 'Mesa A');
  const t2 = await store.createTable(v2.id, 'Mesa B');
  return { store, auth, v1, v2, t1, t2 };
}

const reqWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('bearer()', () => {
  test('extracts the token, tolerant of case/space; null otherwise', () => {
    expect(bearer('Bearer abc')).toBe('abc');
    expect(bearer('bearer   xyz ')).toBe('xyz');
    expect(bearer('Basic abc')).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });
});

describe('requireUser — token → identity', () => {
  test('missing token → 401', async () => {
    const { auth } = await world();
    await expect(auth.requireUser(reqWith(null))).rejects.toMatchObject({ statusCode: 401 });
  });
  test('invalid token → 401', async () => {
    const { auth } = await world();
    await expect(auth.requireUser(reqWith('garbage'))).rejects.toThrow(/invalid|expired/);
  });
  test('valid token → the user', async () => {
    const { auth } = await world();
    expect(await auth.requireUser(reqWith('tokU1'))).toMatchObject({ id: 'u1' });
  });
});

describe('requireVenueOwner — cross-venue isolation', () => {
  test('owner passes', async () => {
    const { auth, v1 } = await world();
    await expect(auth.requireVenueOwner({ id: 'u1' }, v1.id)).resolves.toBeUndefined();
  });
  test("non-owner is 404 (never reveal the venue exists)", async () => {
    const { auth, v2 } = await world();
    await expect(auth.requireVenueOwner({ id: 'u1' }, v2.id)).rejects.toMatchObject({ statusCode: 404 });
  });
  test('missing venue id → 400', async () => {
    const { auth } = await world();
    await expect(auth.requireVenueOwner({ id: 'u1' }, '')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('requireTableOwner — resolves table→venue then enforces', () => {
  test('owner of the table’s venue passes', async () => {
    const { auth, t1, v1 } = await world();
    expect(await auth.requireTableOwner({ id: 'u1' }, t1.id)).toBe(v1.id);
  });
  test("another owner cannot act on someone else's table (404)", async () => {
    const { auth, t2 } = await world();
    await expect(auth.requireTableOwner({ id: 'u1' }, t2.id)).rejects.toMatchObject({ statusCode: 404 });
  });
  test('unknown table → 404', async () => {
    const { auth } = await world();
    await expect(auth.requireTableOwner({ id: 'u1' }, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('membership store methods (memory)', () => {
  test('addVenueMember is idempotent; listVenuesForOwner scopes to the user', async () => {
    const { store, v1, v2 } = await world();
    await store.addVenueMember(v1.id, 'u1'); // repeat
    const u1venues = await store.listVenuesForOwner('u1');
    expect(u1venues.map((v) => v.id)).toEqual([v1.id]);
    expect((await store.listVenuesForOwner('u2')).map((v) => v.id)).toEqual([v2.id]);
    expect(await store.userOwnsVenue('u1', v2.id)).toBe(false);
  });
});
