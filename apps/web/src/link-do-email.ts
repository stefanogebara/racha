/**
 * O LINK DO E-MAIL DO AUTH aponta pro useracha.app, não pro Supabase.
 *
 * O botão "Confirmar e-mail" levava pra `worttfotxasxqjaqwpjf.supabase.co/…`:
 * um endereço que o dono nunca viu, num e-mail que diz "Racha" — a cara de
 * phishing, no primeiro contato do restaurante com a gente. O domínio próprio
 * no Supabase é pago; isto não é.
 *
 * Os modelos (supabase/templates/) mandam `useracha.app/admin#token_hash=…&type=…`
 * e esta página só REPASSA pro mesmo `/auth/v1/verify` que o `{{ .ConfirmationURL }}`
 * abria: o mesmo token, o mesmo fluxo. Nenhum token vira sessão aqui.
 *
 * O TOKEN É UMA CREDENCIAL. O PKCE protege contra o link forjado (o `?code=`
 * que volta só troca com o verifier deste navegador), NÃO contra o roubo do
 * link verdadeiro: quem tem o `token_hash` troca direto por sessão num POST
 * `/verify`. Por isso ele vai no FRAGMENTO (`#`), que o navegador nunca manda
 * pro servidor — nem pro log da Vercel, nem no Referer (segurança, revisão do
 * link, MEDIUM).
 *
 * PURO: sem I/O, sem import relativo (testado em node).
 */

/** Os tipos que os três modelos mandam. Qualquer outro fica onde está. */
const TIPOS = new Set(['signup', 'recovery', 'email_change']);

/**
 * SÓ o token do PKCE (sha224 em hex, 56, com o prefixo `pkce_`) — o único que
 * os nossos fluxos geram. O sem prefixo é do fluxo implícito, e repassá-lo faria
 * desta página um relé que entrega sessão de terceiro no nosso fragmento
 * (segurança, revisão do link, LOW).
 */
const TOKEN = /^pkce_[0-9a-f]{56}$/;

function doFragmento(href: string): { url: URL; p: URLSearchParams } | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  return { url, p: new URLSearchParams(url.hash.replace(/^#/, '')) };
}

/**
 * Pra onde mandar o navegador, ou `null` quando a URL não é a volta de um
 * e-mail do auth. `href` é a URL da página; `authUrl`, o projeto do auth.
 * O `redirect_to` é SEMPRE esta origem + `/admin` — nunca um parâmetro da URL.
 */
export function destinoDoLinkDoEmail(href: string, authUrl: string): string | null {
  const f = doFragmento(href);
  if (!f) return null;
  const token = f.p.get('token_hash');
  const tipo = f.p.get('type');
  if (!token || !tipo || !TIPOS.has(tipo) || !TOKEN.test(token)) return null;
  const verify = new URL('/auth/v1/verify', authUrl);
  verify.searchParams.set('token', token);
  verify.searchParams.set('type', tipo);
  verify.searchParams.set('redirect_to', `${f.url.origin}/admin`);
  return verify.toString();
}

/**
 * O link que NÃO deu certo. O verify volta com `#error=…&error_code=otp_expired`
 * (vencido ou já usado) e a tela de login aparecia muda — uma confirmação
 * quebrada com cara de login normal. Devolve o código que a tela traduz, ou
 * `null` quando não é volta de erro.
 */
export function erroDoLinkDoEmail(href: string): 'auth_otp_expired' | 'auth_link_invalid' | null {
  const f = doFragmento(href);
  if (!f) return null;
  // No PKCE o GoTrue escreve o erro também na QUERY; vale qualquer um dos dois.
  for (const p of [f.p, f.url.searchParams]) {
    if (p.has('error') || p.has('error_code')) {
      return p.get('error_code') === 'otp_expired' ? 'auth_otp_expired' : 'auth_link_invalid';
    }
  }
  return null;
}
