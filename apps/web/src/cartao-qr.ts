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
