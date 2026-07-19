/**
 * Vínculo carteira↔celular — localStorage do aparelho do cliente.
 *
 * A spec sugere a chave `racha:house:<venueId>`, mas nenhuma resposta pública
 * (config/open/account) expõe venueId — só venue.name. V1 pragmático: uma
 * única carteira "última usada" em `racha:house:last`, e a tela da conta
 * (GET /api/check, que também só traz venue.name) casa por venueName.
 * Quando a API pública expuser venueId, migrar para a chave por venue.
 */

export interface StoredWallet { token: string; venueName: string }

const LAST_KEY = 'racha:house:last';

export function storeWallet(token: string, venueName: string): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ token, venueName }));
  } catch {
    // storage indisponível (modo privado etc.) — a carteira segue pelo link.
  }
}

export function readStoredWallet(): StoredWallet | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWallet>;
    if (typeof parsed.token !== 'string' || typeof parsed.venueName !== 'string') return null;
    return { token: parsed.token, venueName: parsed.venueName };
  } catch {
    return null; // JSON corrompido ou storage bloqueado — trata como sem carteira.
  }
}

export function clearStoredWallet(): void {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    // sem storage não há o que limpar.
  }
}
