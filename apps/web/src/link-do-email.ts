/**
 * O LINK DO E-MAIL DO AUTH aponta pro useracha.app, não pro Supabase.
 *
 * O botão "Confirmar e-mail" levava pra `worttfotxasxqjaqwpjf.supabase.co/…`:
 * um endereço que o dono nunca viu, num e-mail que diz "Racha" — a cara de
 * phishing, no primeiro contato do restaurante com a gente. O domínio próprio
 * no Supabase é pago; isto não é.
 *
 * Os modelos (supabase/templates/) mandam `useracha.app/admin?token_hash=…&type=…`
 * e esta página só REPASSA pro mesmo `/auth/v1/verify` que o `{{ .ConfirmationURL }}`
 * abria — o mesmo token, o mesmo PKCE: o verify volta com `?code=`, e o código
 * só vira sessão com o verifier do navegador que pediu o link (`auth.ts`).
 * Nenhum token vira sessão aqui; nada de sessão nova neste módulo.
 *
 * PURO: sem I/O, sem import relativo (testado em node).
 */

/** Os tipos que os três modelos mandam. Qualquer outro fica onde está. */
const TIPOS = new Set(['signup', 'recovery', 'email_change']);

/** O token hash do GoTrue: hex, com o prefixo `pkce_` no fluxo PKCE. */
const TOKEN = /^(?:pkce_)?[0-9a-f]{20,128}$/;

/**
 * Pra onde mandar o navegador, ou `null` quando a URL não é a volta de um
 * e-mail do auth. `href` é a URL da página; `authUrl`, o projeto do auth.
 * O `redirect_to` é SEMPRE esta origem + `/admin` — nunca um parâmetro da URL.
 */
export function destinoDoLinkDoEmail(href: string, authUrl: string): string | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  const token = url.searchParams.get('token_hash');
  const tipo = url.searchParams.get('type');
  if (!token || !tipo || !TIPOS.has(tipo) || !TOKEN.test(token)) return null;
  const verify = new URL('/auth/v1/verify', authUrl);
  verify.searchParams.set('token', token);
  verify.searchParams.set('type', tipo);
  verify.searchParams.set('redirect_to', `${url.origin}/admin`);
  return verify.toString();
}
