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
/**
 * O erro do GoTrue é de TRANSPORTE — quer dizer que a pergunta não chegou, e
 * não que a resposta foi "não"?
 *
 * Duas marcas, porque uma sozinha envelhece: o `status: 0` (a convenção de "sem
 * resposta", a mesma do postgrest-js) e o NOME da classe do auth-js. Um token
 * recusado de verdade volta com 401/403 e outro nome.
 */
function naoDeuPraPerguntar(error) {
  if (!error) return false;
  if (error.status === 0) return true;
  return error.name === 'AuthRetryableFetchError';
}

function createAuth({ authClient, store }) {
  if (!authClient || !store) throw new Error('createAuth: authClient and store required');

  /**
   * Resolve the caller to a user, or throw AuthError(401) — MENOS quando o
   * problema não é o token.
   *
   * ────────────────────────────────────────────────────────────────────────
   * "NÃO CONSEGUI PERGUNTAR" NÃO É "A RESPOSTA É NÃO".
   *
   * Isto colapsava toda falha do `getUser` num 401. Desde que o cliente do
   * Supabase ganhou prazo (10 s), um GoTrue lento virou um desfecho comum — e
   * medido contra um servidor que aceita e pendura, o erro que volta é:
   *
   *     AuthRetryableFetchError   status 0   "This operation was aborted"
   *
   * O tipo diz *Retryable* no nome. Virava 401, e o cliente (`auth.ts`) faz
   * `signOut()` em QUALQUER 401, e o painel recarrega a cada 4 s. Ou seja: uma
   * lentidão de dez segundos no GoTrue não derrubava uma requisição — derrubava
   * a SESSÃO de todo dono com o painel aberto, no meio do turno, obrigando a
   * logar de novo enquanto a casa serve. E cegava o monitoramento junto: uma
   * queda de plataforma aparecia como pico de 401, indistinguível de ataque de
   * credencial.
   *
   * `status === 0` é a marca de "a resposta não veio" (o postgrest-js usa a
   * mesma convenção). Vai como 503 com código estável — o cliente escolhe a
   * frase, e um 503 não desloga ninguém. Achado pela revisão de segurança de
   * 2026-09-16 (MEDIUM-2).
   * ────────────────────────────────────────────────────────────────────────
   */
  async function requireUser(req) {
    const token = bearer(req.headers && req.headers.authorization);
    if (!token) throw new AuthError('missing bearer token', 401);
    const { data, error } = await authClient.auth.getUser(token);
    if (error && naoDeuPraPerguntar(error)) {
      const e = new AuthError('auth unavailable', 503);
      e.code = 'auth_unavailable';
      throw e;
    }
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

module.exports = { createAuth, AuthError, bearer, naoDeuPraPerguntar };
