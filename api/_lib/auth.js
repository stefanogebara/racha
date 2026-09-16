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
 * O GoTrue OLHOU O TOKEN E DISSE NÃO — ou só não deu pra perguntar?
 *
 * Isto era uma lista de RECUSA ("o que conta como falha de transporte"), e
 * perdeu pro primeiro código que ela não listava. A segunda revisão de
 * segurança de 2026-09-16 mediu dois furos:
 *
 *  · **429.** Não está no `NETWORK_ERROR_CODES` do auth-js (que cobre 500-504 e
 *    520-530), então vem como `AuthApiError(429)` e caía no 401 — e o cliente
 *    desloga em qualquer 401. Alguém sem autenticação nenhuma jogando tokens
 *    falsos em qualquer rota de dono empurra o IP de saída compartilhado da
 *    Vercel pro limite de taxa do GoTrue, e todo dono com o painel aberto é
 *    deslogado no meio do turno. O mesmo dano de antes, agora DE PROPÓSITO.
 *  · **403 de WAF** na frente do GoTrue: idem.
 *
 * Então inverte-se: a única coisa que conta como "o token não presta" é um
 * **401**. Todo o resto — 0, 403, 429, 5xx, erro sem forma, transporte — é "não
 * deu pra perguntar". Uma lista de permissão sobre o que autoriza a deslogar,
 * pela mesma razão que a lista de invisíveis virou uma pergunta inversa: lista
 * de recusa perde pro próximo valor.
 *
 * ERRAR PRA QUE LADO: classificar uma recusa de verdade como 503 devolve 503 e
 * NÃO devolve usuário — o ramo lança. Ninguém entra; a pessoa vê "o login não
 * respondeu" em vez de "entre de novo". Classificar uma indisponibilidade como
 * 401 desloga a casa inteira. O lado seguro é este.
 */
function naoDeuPraPerguntar(error) {
  if (!error) return false;
  // SÓ DECIDE QUANDO HÁ UM STATUS PRA JULGAR.
  //
  // O auth-js sempre põe um: `0` quando a ida não voltou, o código da resposta
  // quando voltou (lido em `@supabase/auth-js/.../lib/fetch.js`). Um erro SEM
  // status não veio dele — é um dublê, um provedor de auth diferente, uma
  // versão mais velha — e aí a resposta honesta é a antiga: trate como recusa
  // de token. O contrário estragaria o outro lado: quem tem mesmo um token
  // ruim veria "o login não respondeu" pra sempre, sem nunca ser convidado a
  // entrar de novo.
  const status = Number(error.status);
  if (!Number.isFinite(status)) return false;
  return status !== 401;
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
