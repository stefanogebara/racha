/**
 * A MARCA do MEU pagamento na conta pública: sha256 do txid, doze hex — a mesma
 * conta do `refDoPagamento` do servidor (`api/_lib/checks/public-state.js`).
 *
 * O telefone só avança pro ✓ quando a SUA cobrança cai. Antes, qualquer
 * pagamento da mesa servia, e numa mesa em que várias pessoas pagam juntas o
 * telefone de quem ainda não pagou dizia "Pagamento confirmado".
 *
 * Sem `crypto.subtle` (página fora de HTTPS) devolve `null`, e o telefone não
 * avança sozinho — melhor ficar na tela do código do que confirmar o que não é.
 */
export async function refDoPagamento(txid: string): Promise<string | null> {
  const sutil = globalThis.crypto && globalThis.crypto.subtle;
  if (!sutil || !txid) return null;
  const hash = new Uint8Array(await sutil.digest('SHA-256', new TextEncoder().encode(txid)));
  return Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
