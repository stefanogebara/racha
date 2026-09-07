/** API client — thin, typed, no state. Centavos everywhere; format at the edge. */

export interface CheckItem { id: string; name: string; priceCents: number }

/**
 * O mercado da casa, DECLARADO PELO SERVIDOR (api/_lib/markets.js).
 *
 * O cliente não deduz nada disto: nem a moeda, nem se há linha de serviço, nem
 * se o pagador precisa dar documento. A UI inferindo uma regra de dinheiro foi
 * o CRÍTICO #1 da revisão #37, e uma segunda implementação das regras aqui
 * seria a divergência da #32 outra vez.
 *
 * Os campos são opcionais no tipo porque um servidor mais antigo não os manda —
 * e aí o cliente usa os defaults brasileiros, que é o que aquele servidor quer
 * dizer.
 */
export interface MarketView {
  market: 'br' | 'es';
  currency: 'BRL' | 'EUR';
  defaultLang: 'pt' | 'en' | 'es';
  rails: ('pix' | 'bizum' | 'card')[];
  serviceCharge: { mode: 'preselected' | 'optIn' | 'none'; bp: number };
  payerTaxId: { required: boolean; kind: 'cpf' | 'nif' };
  charge: { minCents: number; maxCents: number | null };
}

export interface CheckView {
  /** acceptsCard: o restaurante tem conta Stripe conectada (cartão/Apple Pay). */
  /** demo: mesa pública de demonstração — dinheiro é do MockPsp, nunca real. */
  venue: { name: string; servicoBp: number; acceptsCard?: boolean; demo?: boolean }
    & Partial<MarketView>;
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

// ---- Superfícies do dono (buscadas via authedReq de auth.ts, com Bearer).

/** GET /api/tables?v=<venueId> → { venue, tables } — inventário de mesas. */
export interface Venue { id: string; name: string; city: string | null; servicoBp: number; pspRecipientId: string | null }

export interface VenueTable {
  id: string;
  label: string;
  qrToken: string;
  qrRotatedAt: string | null;
  active: boolean;
  /** Mesa de treino: a equipe pratica nela, mas ela fica fora dos QRs impressos. */
  training: boolean;
  hasOpenCheck: boolean;
}

export interface TablesView { venue: Venue; tables: VenueTable[] }

/** GET /api/panel → data.ativacao — tração dos últimos 7 dias para o dono. */
export interface PanelAtivacao {
  /** 7 dias em ordem cronológica; dias sem movimento vêm presentes, zerados. */
  dias: Array<{ dia: string /* 'YYYY-MM-DD' */; pagamentos: number; valorCents: number; gorjetaCents: number; contas: number }>;
  /** Pagamentos confirmados na semana, por método. */
  metodos: { pix: number; card: number; house_account: number };
  semana: { pagamentos: number; valorCents: number; gorjetaCents: number; contas: number };
}

/**
 * Erro de API com o status HTTP anexado — callers distinguem 404 (recurso
 * sumiu de verdade) de um soluço de rede (status === undefined, o fetch
 * rejeita com TypeError antes de haver resposta).
 */
export class ApiError extends Error {
  status?: number;
  /**
   * Código estável do erro, quando o servidor manda um. A MENSAGEM do servidor
   * é em português e não dá pra traduzir texto livre no cliente — então o que
   * atravessa a fronteira é o código, e a mensagem fica como reserva pra um
   * servidor mais velho ou um erro que ainda não tem tradução. Ver tError().
   */
  code?: string;
  /** Valores pra interpolar na tradução (ex.: quanto ainda falta). */
  vars?: Record<string, string | number>;
  constructor(message: string, status?: number, code?: string,
              vars?: Record<string, string | number>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.vars = vars;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init); // falha de rede rejeita aqui, sem status
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status, body.code, body.vars);
  }
  return body.data as T;
}

export const api = {
  getCheck: (token: string) => request<CheckView>(`/api/check?t=${encodeURIComponent(token)}`),
  pay: (
    token: string, amountCents: number, tipCents: number, payerLabel: string | null,
    payerDocument?: string, rail: 'pix' | 'bizum' = 'pix',
  ) =>
    request<ChargeResult>('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, amountCents, tipCents, payerLabel, payerDocument: payerDocument ?? null, rail }),
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
  /** Stripe (2º rail): cria o PaymentIntent (destination charge) e devolve o
   *  clientSecret pro Express Checkout Element confirmar (Apple/Google Pay/cartão). */
  /**
   * Cria o PaymentIntent na Stripe. `rail` decide o meio: 'card' (Apple/Google
   * Pay, Express Checkout) ou 'bizum' (Payment Element, Espanha). O SERVIDOR
   * confere se o trilho atende o mercado daquela mesa — pedir 'bizum' numa
   * mesa brasileira volta 400, não uma cobrança em euro.
   */
  stripeIntent: (
    token: string, amountCents: number, tipCents: number, payerLabel: string | null,
    payerDocument?: string, rail: 'card' | 'bizum' = 'card',
  ) =>
    request<{ txid: string; clientSecret: string; amountCents: number; tipCents: number; method: 'card' | 'bizum' }>('/api/pay/stripe-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, amountCents, tipCents, payerLabel, payerDocument: payerDocument ?? null, rail }),
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

/**
 * Dinheiro pra tela. A moeda é sempre BRL — trocar de idioma não converte
 * dinheiro — mas a SEPARAÇÃO segue o idioma (decisão #34): "R$ 1.234,56" lido
 * por um falante de inglês vale mil vezes menos do que é.
 *
 * O padrão continua pt-BR pros poucos chamadores que não são tela (prompts de
 * admin, logs). Quem desenha tela passa o idioma — `money(cents, lang)` do
 * i18n.ts é a mesma função com o argumento obrigatório.
 */
export const brl = (cents: number, lang: 'pt' | 'en' = 'pt') =>
  (cents / 100).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US',
                               { style: 'currency', currency: 'BRL' });

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
/// Uma data curta no formato do idioma. "06/12/2026" não quer dizer a mesma
/// coisa nos dois, e um saldo que "expira em 06/12" é exatamente o número que
/// não pode ser ambíguo.
export const dmy = (iso: string, lang: 'pt' | 'en' = 'pt') =>
  new Date(iso).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US');
