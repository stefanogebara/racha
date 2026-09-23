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
  /** acceptsWallet: a casa tem recebedor Pagar.me de verdade — só então o
   *  `pay.google.com` é carregado. Ver o comentário no `/api/check`. */
  /** demo: mesa pública de demonstração — dinheiro é do MockPsp, nunca real. */
  /** taxId: o documento da CASA (CNPJ no Brasil, NIF em Espanha). Nulo é
   *  normal — a migração 0002 tirou o `not null` porque um documento de
   *  mentira num recibo de verdade é pior que a ausência dele. */
  venue: { name: string; servicoBp: number; acceptsCard?: boolean; acceptsWallet?: boolean; demo?: boolean; taxId?: string | null }
    & Partial<MarketView>;
  /** `training`: mesa de treino — não cobra; a tela avisa no lugar de pagar. */
  table: { label: string; training?: boolean };
  check: { id: string; items: CheckItem[] };
  state: {
    status: 'aberta' | 'parcial' | 'paga' | 'fechada';
    totalCents: number;
    paidCents: number;
    tipCents: number;
    overpaidCents: number;
    /** A CONTAGEM, não o texto: o texto das anomalias carrega motivo de
     *  disputa, prazo de prova e a nota do dono, e esta leitura é pública.
     *  Ver `api/_lib/checks/public-state.js`. */
    anomalies: number;
    /**
     * Os pagamentos da mesa, pelo ordinal (`p1`, `p2`) e SEM o id do adquirente.
     * `ref` é o sha256 do txid em doze hex: o telefone reconhece o PRÓPRIO
     * pagamento sem conhecer o de ninguém (ver `pagamento-ref.ts`).
     */
    payments?: Record<string, {
      ref?: string; amountCents: number; tipCents: number;
      refundedAmountCents: number; refundedTipCents: number; late: boolean;
    }>;
    /**
     * Avisos DO CLIENTE sobre o próprio dinheiro: código estável + centavos, a
     * traduzir e formatar aqui (o servidor nunca manda texto de erro nem
     * dinheiro formatado). Nada da postura da casa entra nesta lista —
     * situação de disputa, prazo de prova e a nota do dono ficam no painel.
     */
    notices?: Array<{ code: 'overpaid_pending_restitution' | 'refund_reversed'; amountCents: number }>;
  };
}

export interface ChargeResult {
  txid: string;
  /** A conta em que a cobrança nasceu. O recibo se prende a ela (`recibo.ts`). */
  checkId?: string;
  /**
   * null em cobranças de carteira (Apple/Google Pay) e em Bizum — só o Pix tem
   * código copia-e-cola. No Bizum quem autoriza é o banco do pagador.
   */
  copiaECola: string | null;
  expiresAt: string | null;
  amountCents: number;
  tipCents: number;
  method?: 'pix' | 'card' | 'bizum';
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
  // `| string` porque o servidor pode nomear um tipo novo antes do cliente
  // saber dele — mas escrito assim a união inteira colapsava em `string` e os
  // três literais não checavam nada. `(string & {})` mantém a autocompletar e
  // a checagem dos conhecidos sem fechar a porta pro desconhecido.
  type: 'load' | 'redeem' | 'refund' | (string & {});
  label: string;
  amountCents: number;
  bonusCents?: number;
}

export interface HouseAccountView {
  /** `demo`: só a casa de demonstração mostra o botão de simular a confirmação. */
  venue: { name: string; demo?: boolean };
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
export interface Venue {
  id: string; name: string; city: string | null; servicoBp: number;
  pspRecipientId: string | null;
  /** A conta Stripe da casa (Espanha): é ela que diz se a casa recebe (`casaRecebe`). */
  stripeAccountId?: string | null;
  /**
   * O documento da casa. Vem só na visão AUTENTICADA do dono (`/api/tables`);
   * pro cliente ele passa por `documentoPublicavelDaCasa`, que confere o valor
   * além do mercado. Nulo é legítimo — e desde 2026-09-13 é também o que
   * desliga a cobrança do serviço, então o painel avisa.
   */
  cnpj?: string | null;
  /**
   * A casa pode cobrar serviço? Vem CALCULADO pelo servidor, com o mesmo
   * predicado do portão do dinheiro (`documentoPublicavelDaCasa`). O painel
   * perguntava `!venue.cnpj` e o portão perguntava outra coisa: casa com CPF
   * ou com dígito trocado não via aviso e seguia sem arrecadar.
   */
  //
  // OBRIGATÓRIO de propósito: com `?`, qualquer caminho novo que alimente o
  // painel sem o campo faz o aviso de "esta casa não pode cobrar serviço"
  // sumir em silêncio, em vez de aparecer. Degradar aberto num aviso é o
  // mesmo defeito do guarda que degrada aberto. Ausência tem que ser erro de
  // tipo. Apontado pela revisão de segurança de 2026-09-13.
  podeCobrarServico: boolean;
  /** br | es — decide o trilho, a moeda e QUAL tela de recebimento aparece. */
  market?: 'br' | 'es';
}

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

/**
 * A ÚNICA tradução de resposta HTTP pra erro no cliente.
 *
 * Existiam duas, e só esta foi atualizada quando o servidor passou a mandar
 * `code` + `vars` em vez de frase. A outra (`authedReq`, no `auth.ts`) fazia
 * `new Error(body.error || \`HTTP ${res.status}\`)` — e o `errorBody` OMITE
 * `error` quando há código, então todo painel do dono passou a mostrar
 * "HTTP 404" no lugar de uma frase. Exatamente a regressão que o `tErr` foi
 * escrito pra evitar, na metade que eu não conferi. Achado da revisão de
 * segurança de 2026-09-10.
 *
 * Uma função só, e um censo em `bundle.test.ts` que proíbe a segunda.
 */
export function erroDaResposta(res: Response, body: unknown): ApiError {
  // `unknown` e não `any`: o corpo vem da rede. Uma leitura estreita aqui é o
  // que garante que `code` e `vars` sejam o que dizem ser.
  const b = (body ?? {}) as { error?: unknown; code?: unknown; vars?: unknown };
  return new ApiError(
    typeof b.error === 'string' ? b.error : `HTTP ${res.status}`,
    res.status,
    typeof b.code === 'string' ? b.code : undefined,
    b.vars && typeof b.vars === 'object' ? (b.vars as Record<string, string | number>) : undefined,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init); // falha de rede rejeita aqui, sem status
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw erroDaResposta(res, body);
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
    request<{ txid: string; checkId?: string; clientSecret: string; amountCents: number; tipCents: number; method: 'card' | 'bizum' }>('/api/pay/stripe-intent', {
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

