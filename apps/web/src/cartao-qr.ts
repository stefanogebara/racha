/**
 * O CARTÃO DE QR — o que fica impresso na mesa por meses. Uma fonte só pros
 * dois cartões (a folha `/qrs` e o avulso do `/admin`), que diziam coisas
 * diferentes (auditoria dos QRs, Q7). Puro, sem React.
 *
 * O cartão é OFERTA IMPRESSA (CDC art. 30: vincula o restaurante), e vive mais
 * que qualquer configuração. Então ele só afirma o que é sempre verdade pra
 * aquela casa: ver a conta, dividir, e pagar pelo trilho do MERCADO dela. Ele
 * prometia "Google Pay · Saldo da casa com bônus" em toda casa, sem condição —
 * numa casa sem Stripe e com o saldo desligado (auditoria da configuração, R1).
 * Trilho opcional (carteira, cartão, saldo) a tela mostra quando existe; o
 * papel não promete.
 */

/**
 * O IDIOMA DO CARTÃO é o do MERCADO da casa, não o da aba do dono. O padrão da
 * interface é inglês, e um dono brasileiro que nunca escolheu idioma imprimia
 * "Table 12 · Scan to see the bill…" — oferta impressa que fica meses numa
 * mesa no Brasil fora do português (CDC art. 31; compliance, PR #20, HIGH-1).
 */
export function idiomaDoCartao(market: string | undefined | null): 'pt' | 'es' {
  return market === 'es' ? 'es' : 'pt';
}

/**
 * Um texto do cartão, no idioma do mercado — nunca no da interface. Recebe a
 * ENTRADA do dicionário (`DICT['qr.scanToPay']`), não a chave: este módulo não
 * importa nada, pra os testes em Node o carregarem sem o empacotador.
 */
export function textoDoCartao(entrada: { pt: string; es: string }, market: string | undefined | null, vars: Record<string, string> = {}): string {
  return entrada[idiomaDoCartao(market)].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/**
 * A CASA JÁ RECEBE? Sem recebedor (Brasil) ou sem conta Stripe (Espanha), a
 * cobrança real é recusada — e o cartão que promete "pagar no Pix" mentiria
 * até o recebedor existir. A folha não imprime nesse estado (compliance,
 * PR #20, M-1). A forma do recebedor é a canônica do repositório.
 */
export function casaRecebe(venue: { market?: string; pspRecipientId?: string | null; stripeAccountId?: string | null } | null | undefined): boolean {
  if (!venue) return false;
  if (venue.market === 'es') return /^acct_/.test(venue.stripeAccountId || '');
  return /^r[ep]_/.test(venue.pspRecipientId || '');
}

/**
 * O QR aponta SEMPRE pra produção: o cartão vive na mesa por meses e não pode
 * depender de onde o dono abriu a página. O avulso do `/admin` usava a origem
 * da aba — de um preview, saía um QR que morre com o preview (auditoria, Q2).
 */
export const ORIGEM_DE_PRODUCAO = 'https://racha-gray.vercel.app';

export const urlDaMesa = (qrToken: string) => `${ORIGEM_DE_PRODUCAO}/?t=${qrToken}`;

/** O trilho que TODA casa daquele mercado tem. Nome próprio: não se traduz. */
export function trilhoDoCartao(market: string | undefined | null): 'Pix' | 'Bizum' {
  return market === 'es' ? 'Bizum' : 'Pix';
}

/**
 * O título da mesa. O rótulo é PALAVRA DA CASA e sai como ela escreveu —
 * "Varanda 1" não vira "Mesa Varanda 1" nem "Table Varanda 1" (auditoria,
 * R3; CLAUDE.md: o conteúdo da casa nunca é traduzido). Só um rótulo que é
 * NÚMERO puro ganha o prefixo da tela, porque "12" sozinho num cartão não diz
 * que é uma mesa.
 */
export function tituloDaMesa(label: string, prefixo: (label: string) => string): string {
  const r = label.trim();
  return /^\d+$/.test(r) ? prefixo(r) : r;
}
