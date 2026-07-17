'use strict';

/**
 * Owner auth — identity via Supabase Auth (GoTrue), authorization via
 * venue_members. We do NOT roll our own password crypto (fintech-adjacent
 * product; use the platform's battle-tested auth). The API:
 *   1. verifies the caller's Supabase access token → a user, and
 *   2. checks that user owns the venue they're acting on,
 * BEFORE serving or mutating any restaurant-facing data.
 *
 * Diners never authenticate — the diner endpoints (/api/check, /api/pay,
 * webhooks) are deliberately public. Only owner surfaces are gated.
 *
 * No dev bypass exists: token verification hits real GoTrue. If auth isn't
 * configured, authed endpoints refuse (501), they don't silently open.
 * (Seatable lesson: dev bypasses become production behavior.)
 */

class AuthError extends Error {
  constructor(message, statusCode = 401) { super(message); this.statusCode = statusCode; }
}

function bearer(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const m = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * @param {object} deps
 * @param {import('@supabase/supabase-js').SupabaseClient} deps.authClient
 *   A Supabase client (service role) used only to verify tokens via GoTrue.
 * @param {object} deps.store  the data store (venue_members access)
 */
function createAuth({ authClient, store }) {
  if (!authClient || !store) throw new Error('createAuth: authClient and store required');

  /** Resolve the caller to a user, or throw AuthError(401). */
  async function requireUser(req) {
    const token = bearer(req.headers && req.headers.authorization);
    if (!token) throw new AuthError('missing bearer token', 401);
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data || !data.user) throw new AuthError('invalid or expired token', 401);
    return data.user; // { id, email, ... }
  }

  /** Require the user to own venueId, or throw AuthError(403). */
  async function requireVenueOwner(user, venueId) {
    if (!venueId) throw new AuthError('venue required', 400);
    const ok = await store.userOwnsVenue(user.id, venueId);
    // 404 (not 403) on non-ownership: never reveal that a venue id exists to a
    // non-owner. A real owner gets through; everyone else sees "not found".
    if (!ok) throw new AuthError('not found', 404);
  }

  /** Resolve the venue that owns a table, then assert ownership. */
  async function requireTableOwner(user, tableId) {
    if (!tableId) throw new AuthError('table required', 400);
    const venueId = await store.venueIdForTable(tableId);
    if (!venueId) throw new AuthError('not found', 404);
    await requireVenueOwner(user, venueId);
    return venueId;
  }

  return { requireUser, requireVenueOwner, requireTableOwner };
}

module.exports = { createAuth, AuthError, bearer };
