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
 * O GoTrue DECIDIU SOBRE ESTE TOKEN — ou só não deu pra perguntar?
 *
 * Esta pergunta já errou duas vezes, nas duas direções, e as duas versões
 * anteriores erraram pelo mesmo motivo: decidiam pelo STATUS, que aqui é
 * artefato de transporte, e não pelo campo que carrega SIGNIFICADO.
 *
 * MEDIDO contra a produção em 2026-09-16 (`/auth/v1/user`, projeto real):
 *
 *   token lixo, apikey certa   → 403 {"error_code":"bad_jwt","msg":"invalid JWT…"}
 *   JWT expirado/assinatura má → 403 {"error_code":"bad_jwt","msg":"…signature is invalid"}
 *   apikey ERRADA (rotação)    → 401 {"message":"Invalid API key"}   ← sem código
 *
 * Ou seja, ao contrário do que as duas versões supunham:
 *
 *  · **Um token recusado NÃO é 401 — é 403.** A regra anterior ("só 401 conta
 *    como recusa") deixava o ramo de deslogar INALCANÇÁVEL em produção: quem
 *    tivesse a sessão de fato revogada lia "o login não respondeu" e nunca era
 *    convidado a entrar de novo.
 *  · **O 401 que existe de verdade é do KONG**, na frente do GoTrue, quando a
 *    `apikey` está errada — o cenário de uma rotação de chave em que a env da
 *    Vercel ficou pra trás, que esta casa já viu duas vezes. A regra anterior
 *    chamava isso de "token ruim" e deslogava TODO dono com o painel aberto:
 *    exatamente o dano que ela existia pra impedir, disparado pela falha de
 *    configuração mais provável que existe.
 *
 * Então decide-se pelo `code`, que o auth-js levanta do `error_code` do corpo
 * (`lib/fetch.js`) e que só existe quando o GOTRUE respondeu sobre o token. É
 * lista de PERMISSÃO: o que não está aqui não desloga ninguém.
 *
 * ERRAR PRA QUE LADO: um código novo que o GoTrue invente cai em 503 — a pessoa
 * vê "o login não respondeu" até o access token vencer, e aí o próprio auth-js
 * falha o refresh e emite `SIGNED_OUT` (limite de uma vida de token, ~1 h).
 * Chato e temporário. O outro lado — deslogar a casa inteira num soluço de
 * plataforma — é o que se está evitando. Achado pela terceira revisão de
 * compliance de 2026-09-16 (o anterior era HIGH e não tinha fechado).
 */
const CODIGOS_DE_RECUSA = new Set([
  'bad_jwt',                     // malformado, expirado, assinatura inválida
  'session_expired',
  'user_not_found',              // a conta sumiu
  'user_banned',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'no_authorization',
]);

/**
 * E A RECUSA QUE NÃO CHEGA COMO CÓDIGO.
 *
 * `session_not_found` estava na lista acima e NUNCA chegaria nela: o auth-js
 * intercepta esse código uma linha antes de montar o `AuthApiError` e lança
 * `AuthSessionMissingError`, que é um `CustomAuthError` — medido com a classe
 * de verdade: `name='AuthSessionMissingError'`, `status=400`, **`code=undefined`**.
 *
 * Quer dizer que a sessão foi REVOGADA (o dono saiu noutro aparelho, um admin
 * encerrou, a conta sumiu) — o único evento em que a resposta certa é mesmo
 * "entre de novo" — e a lista de códigos o classificava como "não deu pra
 * perguntar". O operador leria uma revogação como queda de plataforma, que é o
 * sinal errado justamente onde o certo é claro. Achado pela terceira revisão de
 * segurança de 2026-09-16 (M1).
 *
 * Pelo NOME, e não importando a classe: o `authClient` é injetado (o de teste
 * não é o do auth-js), e casar por nome funciona pros dois. O teste constrói a
 * classe DE VERDADE, que é o que garante que este nome é o nome.
 */
const NOMES_DE_RECUSA = new Set(['AuthSessionMissingError']);

/** O GoTrue respondeu SOBRE O TOKEN? (E não: "houve alguma resposta".) */
function recusouOToken(error) {
  if (!error) return false;
  if (typeof error.name === 'string' && NOMES_DE_RECUSA.has(error.name)) return true;
  return typeof error.code === 'string' && CODIGOS_DE_RECUSA.has(error.code);
}

function naoDeuPraPerguntar(error) {
  if (!error) return false;
  return !recusouOToken(error);
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

module.exports = { createAuth, AuthError, bearer, naoDeuPraPerguntar, CODIGOS_DE_RECUSA, NOMES_DE_RECUSA };
