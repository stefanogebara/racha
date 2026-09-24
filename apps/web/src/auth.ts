import { createClient, type Session } from '@supabase/supabase-js';
// O MESMO decodificador do `api.ts`: `code` e `vars` têm que atravessar aqui
// também, ou o painel do dono mostra "HTTP 404". Ver `erroDaResposta`.
import { buscar, erroDaResposta } from './api';
import type { Lang } from './i18n';

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

/**
 * SESSÃO DE OUTRO PROJETO sai do navegador. Quem entrou no painel pelo login
 * compartilhado guardava a chave de sessão do projeto do Seatable na origem do
 * Racha — um refresh token vivo de OUTRO produto, que um XSS aqui roubaria
 * (compliance e segurança, PR #22). Toda chave `sb-*-auth-token` que não seja
 * a do projeto de auth atual sai no boot.
 */
try {
  const minha = `sb-${new URL(AUTH_URL).hostname.split('.')[0]}-auth-token`;
  for (const k of Object.keys(localStorage)) {
    if (/^sb-[a-z0-9]+-auth-token$/.test(k) && k !== minha) localStorage.removeItem(k);
  }
} catch { /* storage bloqueado */ }

/**
 * PKCE, NÃO IMPLÍCITO. O fluxo implícito aceitava QUALQUER par de tokens no hash
 * da URL: um link `…/painel#access_token=<do atacante>&type=recovery` trocava a
 * sessão do dono pela conta do atacante — e, com a tela de senha nova, o dono
 * definia a senha da conta DELE (segurança, PR #22, HIGH-1). O implícito só
 * existia pelo Google via Supabase do Seatable, e os dois saíram.
 *
 * Com PKCE, um link de confirmação ou de redefinição volta com `?code=`, e o
 * código só vira sessão com o `code_verifier` que ficou no navegador que PEDIU
 * o link. Um link forjado, aberto em outro navegador, não troca por nada. O
 * custo: o link tem de ser aberto no mesmo navegador — pro painel do dono, ok
 * (a confirmação de e-mail vale mesmo assim; ele só entra com a senha).
 */
export const supabase = createClient(AUTH_URL, AUTH_PUBLISHABLE, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: false,   // a troca do `?code=` é feita à mão, abaixo
    persistSession: true,
    autoRefreshToken: true,
  },
});

/**
 * A volta de um link do auth: troca o `?code=` pela sessão (só funciona com o
 * verifier DESTE navegador) e limpa a URL ANTES de esperar a rede — os tokens e
 * o código não ficam na barra de endereço. Hash com token é IGNORADO e apagado:
 * é a porta que o implícito deixava aberta.
 */
export async function recoverOAuthSession(): Promise<void> {
  if (!supabase || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const hashTinhaToken = window.location.hash.includes('access_token');
  if (!code && !hashTinhaToken) return;
  url.searchParams.delete('code');
  history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
  if (!code) return;
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    // O link de "esqueci a senha": a sessão abre, mas a senha nova vem antes do
    // painel (auditoria do portão, P3). A marca só entra com a troca BEM-feita.
    // O supabase-js guarda o tipo junto do verifier e devolve `redirectType:
    // 'recovery'` (conferido no GoTrueClient instalado). O evento
    // PASSWORD_RECOVERY também sai, mas ANTES de o `onSession` assinar — por
    // isso a marca sai daqui.
    if (!error && (data as { redirectType?: string | null }).redirectType === 'recovery') marcarRecuperacao(true);
  } catch { /* código de outro navegador, vencido ou já usado → segue pro login */ }
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
  const { data: sub } = supabase.auth.onAuthStateChange((evento, s) => {
    // O evento de recuperação vem do PRÓPRIO cliente, depois de uma troca de
    // código bem-feita — nunca de um parâmetro que alguém pôs na URL.
    if (evento === 'PASSWORD_RECOVERY') marcarRecuperacao(true);
    cb(s);
  });
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
export async function signUp(email: string, password: string, lang: Lang): Promise<{ needsConfirm: boolean }> {
  if (!supabase) throw new Error('auth não configurado');
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: {
      // O link de confirmação volta pro painel, não pra URL padrão do projeto.
      emailRedirectTo: `${window.location.origin}/admin`,
      // O IDIOMA DO E-MAIL. Os modelos do auth (supabase/templates/) escolhem o
      // texto por `.Data.lang` — o idioma em que o dono criou a conta, que vale
      // também pra redefinição de senha depois. Sem isto, todo e-mail saía no
      // modelo padrão em inglês, pra um dono que se cadastrou em português.
      data: { lang },
    },
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
  const res = await buscar(path, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await signOut();
    // Código, não frase fixa em português (compliance, PR #22, L3).
    const e = new Error('session_expired') as Error & { code?: string };
    e.code = 'session_expired';
    throw e;
  }
  if (!res.ok || body.success === false) throw erroDaResposta(res, body);
  return body.data as T;
}
