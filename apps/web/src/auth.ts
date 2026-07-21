import { createClient, type Session } from '@supabase/supabase-js';

/**
 * Frontend auth — Supabase Auth (GoTrue). The publishable key is browser-safe;
 * our tables are service-role-only so it reads nothing, it only drives login.
 * The access token is attached as a Bearer to owner-facing API calls; the API
 * verifies it and enforces venue ownership.
 */

// Auth roda contra o projeto Supabase do SEATABLE (login compartilhado: quem tem
// conta no Seatable entra no Racha). A URL + a chave PUBLICÁVEL são valores
// PÚBLICOS (vão pro bundle do browser de qualquer jeito — não são segredo) e são
// FIXOS do projeto de auth, então hardcoded de propósito: a env da Vercel se
// mostrou frágil (2 rodadas de "Invalid API key" — sobrou a chave publicável do
// RACHA contra a URL do Seatable). Os DADOS do Racha continuam no projeto do
// Racha, via API com Bearer — nada aqui lê dado. Trocou o projeto de auth? Edita.
const AUTH_URL = 'https://ckforlwdhewexyqljsaf.supabase.co';
const AUTH_PUBLISHABLE = 'sb_publishable_GIg9CVZqYQs6rlllwU0Iaw_3E6pcf2N';

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
  if (access_token && refresh_token) {
    try { await supabase.auth.setSession({ access_token, refresh_token }); } catch { /* token inválido → segue pro login */ }
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function onSession(cb: (s: Session | null) => void): () => void {
  if (!supabase) { cb(null); return () => {}; }
  // Recupera a sessão do hash ANTES de perguntar getSession — assim o primeiro
  // render já sabe que está logado (sem piscar o login e voltar).
  recoverOAuthSession()
    .then(() => supabase!.auth.getSession())
    .then(({ data }) => cb(data.session));
  const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => cb(s));
  return () => sub.subscription.unsubscribe();
}

export async function signIn(email: string, password: string) {
  if (!supabase) throw new Error('auth não configurado');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/**
 * Criar conta. Retorna needsConfirm=true quando o projeto exige confirmação de
 * e-mail (Supabase não devolve sessão até confirmar) — o front mostra "confira
 * seu e-mail". Racha é produto próprio: conta é do dono do restaurante, sem
 * depender de Seatable.
 */
export async function signUp(email: string, password: string): Promise<{ needsConfirm: boolean }> {
  if (!supabase) throw new Error('auth não configurado');
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
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
  if (error) throw new Error(error.message);
}

/** Envia o e-mail de redefinição de senha (volta pro /admin pra trocar). */
export async function resetPassword(email: string): Promise<void> {
  if (!supabase) throw new Error('auth não configurado');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/admin`,
  });
  if (error) throw new Error(error.message);
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

/** fetch() that attaches the current access token; throws 'unauthorized' on 401. */
export async function authedReq<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!supabase) throw new Error('auth não configurado');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: token ? `Bearer ${token}` : '' },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { await signOut(); throw new Error('sessão expirada — entre de novo'); }
  if (!res.ok || body.success === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data as T;
}
