import { createClient, type Session } from '@supabase/supabase-js';
// O MESMO decodificador do `api.ts`: `code` e `vars` têm que atravessar aqui
// também, ou o painel do dono mostra "HTTP 404". Ver `erroDaResposta`.
import { erroDaResposta } from './api';

/**
 * Frontend auth — Supabase Auth (GoTrue). The publishable key is browser-safe;
 * our tables are service-role-only so it reads nothing, it only drives login.
 * The access token is attached as a Bearer to owner-facing API calls; the API
 * verifies it and enforces venue ownership.
 */

// O AUTH É DO PRÓPRIO RACHA — o mesmo projeto Supabase dos dados.
//
// Rodava contra o projeto do SEATABLE (login compartilhado): o cadastro de um
// dono de restaurante virava usuário do Seatable sem ninguém avisar, e o Google
// mostrava o endereço cru do projeto do Seatable na hora de autorizar. O
// CLAUDE.md pede produto próprio ("own Supabase") e proíbe partilha de dado com
// o Seatable sem consentimento (inegociável #10). Decidido pelo dono em
// 2026-09-24. A URL e a chave PUBLICÁVEL são valores PÚBLICOS (vão pro bundle de
// qualquer jeito) e fixos do projeto, então hardcoded de propósito — a env da
// Vercel já trocou uma pela outra duas vezes ("Invalid API key"). O servidor
// confere o token contra o MESMO projeto (sem `AUTH_SUPABASE_URL`, ele usa o
// `SUPABASE_URL` dos dados).
export const AUTH_URL = 'https://worttfotxasxqjaqwpjf.supabase.co';
const AUTH_PUBLISHABLE = 'sb_publishable_cID1pB9ptK-9FdXr4MQ_3A_j-clyc9E';

/**
 * O Google fica DESLIGADO até o Racha ter o próprio cliente OAuth (Supabase →
 * Authentication → Providers → Google) — com ele desligado no projeto, o botão
 * só levaria a um erro. Ligou lá? Liga aqui.
 */
export const GOOGLE_LIGADO = false;

/** O mínimo que a tela exige ao criar a senha — dito ANTES de enviar. */
export const SENHA_MINIMA = 8;

/**
 * O ERRO DO AUTH VIRA CÓDIGO, não frase. O GoTrue responde em inglês
 * ("Invalid login credentials") e a tela mostrava isso cru no painel em
 * português (auditoria do portão, P4). Agora o erro leva `auth_<código>`: os
 * conhecidos têm tradução (`err.auth_*`), e qualquer outro cai na frase
 * genérica traduzida — nunca no inglês do servidor.
 */
function erroDoAuth(error: { code?: string; status?: number }): Error {
  const code = `auth_${error.code || (error.status === 429 ? 'over_request_rate_limit' : 'unknown')}`;
  // A frase do GoTrue NÃO entra no erro: ela é inglês e o censo proíbe texto
  // cru do servidor no estado da tela. O código é o que a tela traduz.
  const e = new Error(code) as Error & { code?: string };
  e.code = code;
  return e;
}

/** A página voltou de um link de REDEFINIÇÃO de senha — ver `recoverOAuthSession`. */
const MARCA_DE_RECUPERACAO = 'racha-recuperacao';
export function emRecuperacaoDeSenha(): boolean {
  try { return sessionStorage.getItem(MARCA_DE_RECUPERACAO) === '1'; } catch { return false; }
}
function marcarRecuperacao(sim: boolean) {
  try { if (sim) sessionStorage.setItem(MARCA_DE_RECUPERACAO, '1'); else sessionStorage.removeItem(MARCA_DE_RECUPERACAO); } catch { /* aba privada */ }
}

// flowType 'implicit': o callback do OAuth (Google via Supabase do Seatable)
// volta com os tokens no HASH (#access_token=...), não em ?code=. No modo PKCE
// (default do supabase-js) o cliente só olha ?code e IGNORA o hash — a sessão
// nunca se estabelecia e caía de volta no login (verificado 2026-07-21).
// detectSessionInUrl OFF: processamos o hash na mão (recoverOAuthSession).
export const supabase = createClient(AUTH_URL, AUTH_PUBLISHABLE, {
  auth: {
    flowType: 'implicit',
    detectSessionInUrl: false,
    persistSession: true,
    autoRefreshToken: true,
  },
});

/**
 * Cinto-e-suspensório: se o OAuth voltou com #access_token no hash e o detect
 * automático não pegou, extrai os tokens e seta a sessão na mão. Idempotente —
 * no-op quando não há hash (o caminho normal). Limpa o hash da URL no fim.
 */
export async function recoverOAuthSession(): Promise<void> {
  if (!supabase || typeof window === 'undefined') return;
  const hash = window.location.hash;
  if (!hash.includes('access_token')) return;
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const access_token = p.get('access_token');
  const refresh_token = p.get('refresh_token');
  // O link de "esqueci a senha" volta com `type=recovery`: a sessão abre, mas o
  // dono tem de TROCAR a senha antes de entrar. Antes a sessão abria e pronto —
  // na próxima vez ele esquecia de novo (auditoria do portão, P3).
  if (p.get('type') === 'recovery') marcarRecuperacao(true);
  if (access_token && refresh_token) {
    try { await supabase.auth.setSession({ access_token, refresh_token }); } catch { /* token inválido → segue pro login */ }
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function onSession(cb: (s: Session | null) => void): () => void {
  if (!supabase) { cb(null); return () => {}; }
  // Recupera a sessão do hash ANTES de perguntar getSession — assim o primeiro
  // render já sabe que está logado (sem piscar o login e voltar).
  // Com `.catch`: sem ele, uma rejeição aqui deixava `cb` sem ser chamado
  // NUNCA — a tela de login ficava carregando pra sempre em vez de mostrar o
  // login. A promessa solta escondia a falha em vez de degradar pra "deslogado".
  void recoverOAuthSession()
    .then(() => supabase.auth.getSession())
    .then(({ data }) => cb(data.session))
    .catch(() => cb(null));
  const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => cb(s));
  return () => sub.subscription.unsubscribe();
}

export async function signIn(email: string, password: string) {
  if (!supabase) throw new Error('auth não configurado');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw erroDoAuth(error);
}

/**
 * Criar conta. Retorna needsConfirm=true quando o projeto exige confirmação de
 * e-mail (Supabase não devolve sessão até confirmar) — o front mostra "confira
 * seu e-mail". Racha é produto próprio: conta é do dono do restaurante, sem
 * depender de Seatable.
 */
export async function signUp(email: string, password: string): Promise<{ needsConfirm: boolean }> {
  if (!supabase) throw new Error('auth não configurado');
  const { data, error } = await supabase.auth.signUp({
    email, password,
    // O link de confirmação volta pro painel, não pra URL padrão do projeto.
    options: { emailRedirectTo: `${window.location.origin}/admin` },
  });
  if (error) throw erroDoAuth(error);
  return { needsConfirm: !data.session };
}

/**
 * Login com Google (OAuth). Exige o provider Google habilitado no Supabase Auth
 * do Racha (Authentication → Providers) + a URL /admin na allowlist de redirect.
 * Redireciona a página; a sessão volta pronta em /admin.
 */
export async function signInWithGoogle(): Promise<void> {
  if (!supabase) throw new Error('auth não configurado');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/admin` },
  });
  if (error) throw erroDoAuth(error);
}

/** Envia o e-mail de redefinição de senha (volta pro /admin pra trocar). */
export async function resetPassword(email: string): Promise<void> {
  if (!supabase) throw new Error('auth não configurado');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/admin`,
  });
  if (error) throw erroDoAuth(error);
}

/** A senha NOVA, depois do link de redefinição. Só então a marca sai. */
export async function definirSenhaNova(password: string): Promise<void> {
  if (!supabase) throw new Error('auth não configurado');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw erroDoAuth(error);
  marcarRecuperacao(false);
}

export async function signOut() {
  marcarRecuperacao(false);
  if (supabase) await supabase.auth.signOut();
}

/** fetch() that attaches the current access token; throws 'unauthorized' on 401. */
export async function authedReq<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!supabase) throw new Error('auth não configurado');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  /**
   * SEM TOKEN, NÃO PERGUNTA — e sobretudo não desloga.
   *
   * Isto mandava `Authorization: ''`, o servidor respondia 401 "missing bearer
   * token" (corretamente), e a linha de baixo destruía uma sessão que estava só
   * SE RENOVANDO: o `getSession()` faz uma ida de refresh, e um soluço de rede
   * ali deixa `token` indefinido. Com o painel perguntando a cada poucos
   * segundos, um turno dá muitas chances de acontecer — e este caminho é mais
   * provável que o do servidor, porque não depende de o GoTrue estar fora, só
   * de uma ida falhar. Achado pela revisão de compliance de 2026-09-16
   * (MEDIUM-B).
   *
   * O erro sai com CÓDIGO, o mesmo do lado do servidor: pra quem lê a tela, "o
   * login não respondeu" é a mesma coisa nos dois casos.
   */
  if (!token) {
    const e = new Error('auth unavailable') as Error & { code?: string };
    e.code = 'auth_unavailable';
    throw e;
  }
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { await signOut(); throw new Error('sessão expirada — entre de novo'); }
  if (!res.ok || body.success === false) throw erroDaResposta(res, body);
  return body.data as T;
}
