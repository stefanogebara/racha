/**
 * A volta do trilho que redireciona — sem o token da mesa na URL.
 *
 * `confirmParams.return_url` era `window.location.href`, e a página da conta
 * é `/?t=<qrToken>`. Então o token ia pra Stripe como PARÂMETRO, e a Stripe
 * o guarda no PaymentIntent (`next_action.redirect_to_url.return_url`),
 * visível no painel e na API deles.
 *
 * O `t` é uma capacidade ao portador sem segundo fator: quem o tem lê a conta
 * inteira (`GET /api/check`) e CRIA COBRANÇA de verdade (`POST /api/pay`), os
 * dois sem autenticação. Numa casa espanhola isso ainda é capacidade viva de
 * titular europeu dentro de um processador nos EUA.
 *
 * O pior não era o vazamento: era que na MESMA tela, no mesmo commit, a gente
 * tinha acabado de escrever `<meta name="referrer" content="strict-origin">`
 * com um comentário afirmando que "o token da conta não sai daqui". Fechamos o
 * canal do `Referer` e mandamos o token pela porta da frente. Garantia escrita
 * e falsa é pior do que vazamento não documentado — quem revisa depois lê a
 * garantia e para de olhar. Achado da revisão de segurança de 2026-09-10.
 *
 * A volta agora é `/?r=1`, e o token vem do `sessionStorage` da própria aba.
 */

const CHAVE = 'racha-t';
/** A marca da volta. Sem ela, uma visita a `/` não ressuscita mesa nenhuma. */
const MARCA = 'r';

/** A pessoa VOLTOU de um trilho que redireciona — com ou sem token guardado. */
export function voltandoDePagamento(busca: string): boolean {
  return new URLSearchParams(busca).get(MARCA) === '1';
}

/** Guarda o token da aba assim que a conta abre. Falha em silêncio. */
export function lembrarToken(token: string): void {
  if (!token) return;
  try { sessionStorage.setItem(CHAVE, token); } catch { /* aba privada */ }
}

/** O token que a aba guardou — só vale quando a URL traz a marca da volta. */
export function tokenDaVolta(busca: string): string {
  if (new URLSearchParams(busca).get(MARCA) !== '1') return '';
  try { return sessionStorage.getItem(CHAVE) || ''; } catch { return ''; }
}

/**
 * Pra onde o PSP devolve o pagador. Sem `t`, sem `pl`, sem nada — só a marca.
 * A escolha de idioma sobrevive porque mora no `localStorage`, não na URL.
 */
export function urlDeVolta(): string {
  return `${window.location.origin}${window.location.pathname}?${MARCA}=1`;
}
