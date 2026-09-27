/**
 * Mesas numeradas em lote — a regra, sem React e sem rede (testável com
 * `node --test`). Quem chama injeta o `post` de UMA mesa; aqui se decide o que
 * é pulado, o que para o lote e o que conta.
 */

/** Teto por lote: um salão grande faz dois lotes; "1 a 2000" não vira 2000 idas. */
export const MESAS_POR_LOTE = 60;

export type ResultadoDoLote = { criadas: number; puladas: number; erro: unknown };

/** O lote vale? Nome, números inteiros, fim ≥ começo, e dentro do teto. */
export function loteValido(prefixo: string, de: number, ate: number): boolean {
  return prefixo.trim() !== '' && Number.isInteger(de) && Number.isInteger(ate)
    && de >= 0 && ate >= de && ate - de < MESAS_POR_LOTE;
}

/**
 * Cria "{prefixo} {de}" … "{prefixo} {ate}", uma por vez, na ordem.
 * - Nome que já existe (409) é PULADO: repetir "1 a 20" completa o que falta.
 * - Qualquer outro erro PARA o lote e volta em `erro` — sem ele, uma queda de
 *   rede no meio viraria vinte mensagens de erro, ou nenhuma.
 */
export async function criarMesasNumeradas(
  post: (label: string) => Promise<unknown>,
  prefixo: string, de: number, ate: number,
  onProgress?: (feitas: number, total: number) => void,
): Promise<ResultadoDoLote> {
  if (!loteValido(prefixo, de, ate)) return { criadas: 0, puladas: 0, erro: null };
  const base = prefixo.trim();
  const total = ate - de + 1;
  let criadas = 0;
  let puladas = 0;
  for (let n = de; n <= ate; n++) {
    try {
      await post(`${base} ${n}`);
      criadas++;
    } catch (e) {
      if ((e as { status?: number }).status === 409) puladas++;
      else return { criadas, puladas, erro: e };
    }
    onProgress?.(n - de + 1, total);
  }
  return { criadas, puladas, erro: null };
}
