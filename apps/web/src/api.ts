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
  copiaECola: string;
  expiresAt: string;
  amountCents: number;
  tipCents: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(body.error || `HTTP ${res.status}`);
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
  /** Demo-only: plays the diner's bank confirming the Pix. */
  devConfirm: (txid: string) =>
    request<{ status: string }>('/api/dev/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid }),
    }),
};

export const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
