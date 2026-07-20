/** API client — thin, typed, no state. Centavos everywhere; format at the edge. */

export interface CheckItem { id: string; name: string; priceCents: number }

export interface CheckView {
  venue: { name: string; servicoBp: number };
  table: { label: string };
  check: { id: string; items: CheckItem[] };
  state: {
    status: 'aberta' | 'parcial' | 'paga' | 'fechada';
    totalCents: number;
    paidCents: number;
    tipCents: number;
    overpaidCents: number;
    anomalies: unknown[];
  };
}

export interface ChargeResult {
  txid: string;
  /** null em cobranças de carteira (Apple/Google Pay) — só Pix tem BR Code. */
  copiaECola: string | null;
  expiresAt: string | null;
  amountCents: number;
  tipCents: number;
  method?: 'pix' | 'card';
  wallet?: 'apple_pay' | 'google_pay' | null;
}

// ---- House accounts (saldo da casa) — docs/house-accounts/README.md is canon.

export interface HouseConfig {
  enabled: boolean;
  venueName: string;
  bonusBp: number;
  validityDays: number;
  minLoadCents: number;
  maxLoadCents: number;
}

export interface HouseLot { remainingCents: number; expiresAt: string }

export interface HouseLedgerEntry {
  at: string | null;
  type: 'load' | 'redeem' | 'refund' | string;
  label: string;
  amountCents: number;
  bonusCents?: number;
}

export interface HouseAccountView {
  venue: { name: string };
  config: { bonusBp: number; validityDays: number };
  account: {
    name: string;
    phoneMasked: string;
    principalCents: number;
    bonusCents: number;
    totalCents: number;
    lots: HouseLot[];
    ledger: HouseLedgerEntry[];
  };
}

export interface HouseLoadResult {
  txid: string;
  copiaECola: string;
  expiresAt: string;
  amountCents: number;
  bonusCents: number;
}

export interface HouseRedeemResult {
  txid: string;
  principalUsedCents: number;
  bonusUsedCents: number;
  /** null quando a conta fechou/girou no meio do redeem — o débito ACONTECEU mesmo assim. */
  check: CheckView | null;
}

/**
 * Erro de API com o status HTTP anexado — callers distinguem 404 (recurso
 * sumiu de verdade) de um soluço de rede (status === undefined, o fetch
 * rejeita com TypeError antes de haver resposta).
 */
export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init); // falha de rede rejeita aqui, sem status
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  }
  return body.data as T;
}

export const api = {
  getCheck: (token: string) => request<CheckView>(`/api/check?t=${encodeURIComponent(token)}`),
  pay: (token: string, amountCents: number, tipCents: number, payerLabel: string | null) =>
    request<ChargeResult>('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, amountCents, tipCents, payerLabel }),
    }),
  /** Apple/Google Pay: mesma rota e portões do Pix, cobrança de cartão tokenizada.
   *  payerDocument (CPF) é exigido pelo adquirente em cartão no BR. */
  payWallet: (
    token: string, amountCents: number, tipCents: number, payerLabel: string | null,
    wallet: 'apple_pay' | 'google_pay', paymentToken: string, payerDocument?: string,
  ) =>
    request<ChargeResult>('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, amountCents, tipCents, payerLabel, wallet, paymentToken, payerDocument: payerDocument ?? null }),
    }),
  /** Demo-only: plays the diner's bank confirming the Pix. */
  devConfirm: (txid: string) =>
    request<{ status: string }>('/api/dev/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid }),
    }),

  // House accounts — diner-facing (public; the tokens are the credentials).
  houseConfig: (tableToken: string) =>
    request<HouseConfig>(`/api/house/config?t=${encodeURIComponent(tableToken)}`),
  houseOpen: (tableToken: string, phone: string, name: string) =>
    request<{ accountToken: string; venueName: string }>('/api/house/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tableToken, phone, name }),
    }),
  houseAccount: (accountToken: string) =>
    request<HouseAccountView>(`/api/house/account?t=${encodeURIComponent(accountToken)}`),
  houseLoad: (accountToken: string, amountCents: number) =>
    request<HouseLoadResult>('/api/house/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountToken, amountCents }),
    }),
  houseRedeem: (accountToken: string, tableToken: string, amountCents: number, idempotencyKey?: string) =>
    request<HouseRedeemResult>('/api/house/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // idempotencyKey: mesmo key na retentativa = mesmo débito (o servidor dedupa).
      body: JSON.stringify({ accountToken, token: tableToken, amountCents, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    }),
};

export const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Dinheiro digitado/colado (pt-BR) → centavos. O ÚNICO parser de valores do app.
 *
 * Regras:
 *  - tira 'R$', espaços e qualquer caractere fora de [0-9.,];
 *  - '.' e ',' juntos → '.' é milhar (some), ',' é decimal ('1.234,56' → 123456);
 *  - só ',' → decimal ('47,50' → 4750);
 *  - só '.' → milhar quando é agrupamento exato de 3 em 3 ('1.000' → 100000,
 *    '1.234.567' idem); senão decimal ('10.50' → 1050);
 *  - no máximo 2 casas decimais;
 *  - null para vazio, negativo, mais de um separador decimal ou lixo ('abc').
 * Zero é um parse válido (retorna 0) — quem decide se 0 paga algo é o caller.
 */
export function parseBrlToCents(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed.includes('-')) return null; // valor negativo nunca é pagamento
  const cleaned = trimmed.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(cleaned)) return null;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  let intPart: string;
  let fracPart = '';

  if (hasDot && hasComma) {
    // pt-BR completo: ponto é milhar, vírgula é decimal.
    const parts = cleaned.replace(/\./g, '').split(',');
    if (parts.length !== 2) return null;
    [intPart, fracPart] = parts;
  } else if (hasComma) {
    const parts = cleaned.split(',');
    if (parts.length !== 2) return null;
    [intPart, fracPart] = parts;
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      intPart = cleaned.replace(/\./g, ''); // '1.000' é mil, não um real
    } else {
      const parts = cleaned.split('.');
      if (parts.length !== 2) return null;
      [intPart, fracPart] = parts; // '10.50' digitado no teclado errado → decimal
    }
  } else {
    intPart = cleaned;
  }

  if (fracPart.length > 2) return null;
  const cents = Number(intPart || '0') * 100 + Number((fracPart || '0').padEnd(2, '0'));
  return Number.isFinite(cents) ? Math.round(cents) : null;
}

/** ISO date → DD/MM/AAAA (cópia legal exige a data por extenso nesse formato). */
export const dmy = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
