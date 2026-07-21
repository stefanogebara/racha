import { createClient, type Session } from '@supabase/supabase-js';

/**
 * Frontend auth — Supabase Auth (GoTrue). The publishable key is browser-safe;
 * our tables are service-role-only so it reads nothing, it only drives login.
 * The access token is attached as a Bearer to owner-facing API calls; the API
 * verifies it and enforces venue ownership.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabase = url && key ? createClient(url, key) : null;

export function onSession(cb: (s: Session | null) => void): () => void {
  if (!supabase) { cb(null); return () => {}; }
  supabase.auth.getSession().then(({ data }) => cb(data.session));
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
