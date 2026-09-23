/**
 * A COBRANÇA E O RECIBO SOBREVIVEM A UM RECARREGAR.
 *
 * `charge`, a marca da cobrança e o passo da tela viviam só no estado do React.
 * O iPhone e o Android descartam a aba enquanto a pessoa está no app do banco;
 * na volta a página recarrega, e ela via "Pagar R$ 130,41 com Pix" armado de
 * novo, sem comprovante. Recarregar, voltar ou abrir o QR em outra aba gerava
 * OUTRA cobrança, e pagar as duas cobrou R$ 20 por uma parte de R$ 10 (as duas
 * auditorias de cliente, BR-1 e CB-2).
 *
 * Guardado no `localStorage` e não no `sessionStorage`: abrir o QR de novo é
 * uma aba NOVA, e é justamente quem escaneia outra vez que gera a segunda
 * cobrança. Nenhum dado do pagador é guardado.
 *
 * O QUE VEM DO ARMAZENAMENTO É SUSPEITO (segurança, PR #17, M-1/M-2). Qualquer
 * script da mesma origem, ou alguém com o inspetor aberto, escreve aqui — e o
 * que ele escrevesse sobreviveria a recarregar. Então:
 *  · a forma é conferida por lista fechada (`formaValida`), inclusive as datas,
 *    que com `NaN` ou no futuro faziam a entrada nunca vencer;
 *  · a MARCA do pagamento não é guardada: é recalculada do txid, que não é
 *    público — as marcas são (`/api/check`), e uma marca copiada de outro
 *    pagamento levava ao ✓ de um pagamento alheio;
 *  · um RECIBO só volta se essa marca estiver entre os pagamentos da conta viva
 *    (`restaurarNaTela`) — recibo que o servidor não confirma não volta;
 *  · o copia-e-cola tem de ser um BR Code de Pix cobrando exatamente o valor da
 *    cobrança. O que isto NÃO pega, e fica escrito: um código forjado pra OUTRA
 *    chave com o mesmo valor. A chave do recebedor não é verificável daqui; só
 *    buscar o código no servidor pelo txid fecharia isso;
 *  · a CHAVE é um hash do token da mesa, não o token: a lista de chaves não
 *    vira a lista das mesas visitadas, e o token é credencial de `/api/pay`.
 *
 * Tudo em `try`: aba privada, armazenamento cheio ou bloqueado — a tela segue
 * funcionando como antes, só sem a memória.
 */

/**
 * A forma da cobrança que este módulo guarda — a parte do `ChargeResult` de
 * `api.ts` que a tela usa. Declarada aqui, e não importada, porque os testes
 * rodam em Node sem os tipos do navegador, e o `api.ts` os puxa inteiros.
 */
export interface CobrancaDaTela {
  txid: string;
  checkId?: string;
  copiaECola: string | null;
  expiresAt: string | null;
  amountCents: number;
  tipCents: number;
  method?: 'pix' | 'card' | 'bizum';
  wallet?: 'apple_pay' | 'google_pay' | null;
}

export type Fase = 'pagar' | 'pago';

export interface CobrancaGuardada {
  v: 2;
  checkId: string;
  charge: CobrancaDaTela;
  fase: Fase;
  /** Quando o pagamento foi confirmado — o carimbo do comprovante. */
  paidAt: string | null;
  guardadaEm: number;
  /**
   * Só na LEITURA: a cobrança pendente passou da validade. Volta assim uma vez,
   * pra tela conferir se a marca dela caiu na conta antes de esquecê-la — quem
   * pagou aos 10 min e voltou à aba aos 25 perdia o recibo (compliance, PR #17,
   * M-3). `lerCobranca` já a apagou.
   */
  vencida?: boolean;
}

/** Um Pix vence em 15 min; passado disso, o código na tela não paga mais nada. */
export const VALIDADE_DA_COBRANCA_MS = 20 * 60_000;
/** O recibo vale a noite: quem volta pra conferir depois do café ainda o vê. */
export const VALIDADE_DO_RECIBO_MS = 6 * 60 * 60_000;
/** Folga pro relógio do aparelho andar pra trás; mais que isso é entrada forjada. */
const FOLGA_DO_RELOGIO_MS = 60_000;

const PREFIXO = 'racha-cobranca:';

type Armazem = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ArmazemListavel = Armazem & Pick<Storage, 'length' | 'key'>;

function armazem(): ArmazemListavel | null {
  // `globalThis`, não `window`: o mesmo objeto no navegador, e o módulo
  // compila no Node dos testes. Sem `localStorage` (Node, aba bloqueada) → nulo.
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

/**
 * A chave desta mesa: sha256 do token, 24 hex. Sem `crypto.subtle` (página
 * fora de HTTPS) → nulo, e a memória simplesmente não existe nesse aparelho.
 */
export async function chaveDaMesa(token: string): Promise<string | null> {
  const sutil = globalThis.crypto && globalThis.crypto.subtle;
  if (!sutil || !token) return null;
  try {
    const h = new Uint8Array(await sutil.digest('SHA-256', new TextEncoder().encode(`mesa:${token}`)));
    return PREFIXO + Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
  } catch { return null; }
}

export function guardarCobranca(chave: string, dados: Omit<CobrancaGuardada, 'v' | 'vencida'>, a: Armazem | null = armazem()): void {
  if (!chave || !a) return;
  try { a.setItem(chave, JSON.stringify({ v: 2, ...dados })); } catch { /* cheio ou bloqueado */ }
}

export function esquecerCobranca(chave: string, a: Armazem | null = armazem()): void {
  if (!chave || !a) return;
  try { a.removeItem(chave); } catch { /* bloqueado */ }
}

const dataOuNulo = (v: unknown): boolean => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
const centavos = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/**
 * O copia-e-cola é um BR Code de Pix cobrando EXATAMENTE `cents`?
 *
 * Confere o cabeçalho do payload (`000201`), a conta do Pix (`br.gov.bcb.pix`)
 * e o campo 54 com o valor em reais, tamanho e tudo (`54` + `06` + `148.79`).
 * NÃO lê o TLV inteiro: o PSP de mentira da demo monta o código com tamanhos
 * fixos e CRC `MOCK`, e o parse estrito recusava todo código da demo. O que o
 * campo 54 garante já é o que importa aqui — um código forjado pra cobrar
 * OUTRO valor não passa. Os centavos viram texto da string, nunca de um
 * `parseFloat` (inegociável #5).
 */
export function pixCobraOValor(copia: string, cents: number): boolean {
  if (!Number.isInteger(cents) || cents < 0 || !copia.startsWith('000201')) return false;
  if (!copia.toLowerCase().includes('br.gov.bcb.pix')) return false;
  const valor = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  return copia.includes(`54${String(valor.length).padStart(2, '0')}${valor}`);
}

/** A entrada tem a forma que esta tela grava — por lista fechada, e nada além. */
export function formaValida(d: unknown, agoraMs: number): d is CobrancaGuardada {
  if (!d || typeof d !== 'object') return false;
  const g = d as Record<string, unknown>;
  const c = g.charge as Record<string, unknown> | undefined;
  if (g.v !== 2 || typeof g.checkId !== 'string' || !g.checkId) return false;
  if (g.fase !== 'pagar' && g.fase !== 'pago') return false;
  if (!Number.isFinite(g.guardadaEm) || (g.guardadaEm as number) > agoraMs + FOLGA_DO_RELOGIO_MS) return false;
  if (!dataOuNulo(g.paidAt ?? null)) return false;
  if (!c || typeof c !== 'object') return false;
  if (typeof c.txid !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(c.txid)) return false;
  // A conta da cobrança É a conta guardada: a tela do Pix lê a da cobrança.
  if (c.checkId !== g.checkId) return false;
  if (!centavos(c.amountCents) || !centavos(c.tipCents)) return false;
  if (!dataOuNulo(c.expiresAt ?? null)) return false;
  if (c.method !== undefined && c.method !== 'pix' && c.method !== 'card' && c.method !== 'bizum') return false;
  if (c.wallet !== undefined && c.wallet !== null && c.wallet !== 'apple_pay' && c.wallet !== 'google_pay') return false;
  if (c.copiaECola !== null && c.copiaECola !== undefined) {
    if (typeof c.copiaECola !== 'string') return false;
    if (!pixCobraOValor(c.copiaECola, (c.amountCents as number) + (c.tipCents as number))) return false;
  }
  return true;
}

/**
 * O que está guardado pra esta mesa — ou nulo. Fora da forma: apagado, não
 * consertado. Cobrança pendente vencida: apagada e devolvida UMA vez com
 * `vencida`. Recibo depois da noite: apagado.
 */
export function lerCobranca(chave: string, agoraMs: number, a: Armazem | null = armazem()): CobrancaGuardada | null {
  if (!chave || !a) return null;
  let bruto: string | null = null;
  try { bruto = a.getItem(chave); } catch { return null; }
  if (!bruto) return null;
  let d: unknown;
  try { d = JSON.parse(bruto); } catch { esquecerCobranca(chave, a); return null; }
  if (!formaValida(d, agoraMs)) { esquecerCobranca(chave, a); return null; }
  const idade = agoraMs - d.guardadaEm;
  if (d.fase === 'pagar') {
    const venceu = idade > VALIDADE_DA_COBRANCA_MS
      || (d.charge.expiresAt != null && Date.parse(d.charge.expiresAt) <= agoraMs);
    if (venceu) { esquecerCobranca(chave, a); return { ...d, vencida: true }; }
    return d;
  }
  if (idade > VALIDADE_DO_RECIBO_MS) { esquecerCobranca(chave, a); return null; }
  return d;
}

/**
 * Apaga o que venceu ou está fora da forma em QUALQUER mesa, menos a aberta
 * agora (a dela é lida logo depois, e uma cobrança vencida mas paga tem de
 * chegar inteira a quem confere a marca). Sem isto a validade só valia pra
 * mesa lida de novo (LGPD art. 15 e 16 — compliance, PR #17, L-1).
 */
export function varrerVencidas(agoraMs: number, exceto: string | null, a: ArmazemListavel | null = armazem()): void {
  if (!a) return;
  try {
    const chaves: string[] = [];
    for (let i = 0; i < a.length; i++) {
      const k = a.key(i);
      if (k && k.startsWith(PREFIXO) && k !== exceto) chaves.push(k);
    }
    for (const k of chaves) lerCobranca(k, agoraMs, a);
  } catch { /* bloqueado */ }
}

export interface NaTela {
  fase: Fase;
  charge: CobrancaDaTela;
  /** A marca recalculada do txid — nunca a guardada. */
  ownRef: string | null;
  /** Nulo quando a hora do pagamento não é sabida: melhor nenhuma que inventada. */
  paidAt: string | null;
}

/**
 * O QUE VOLTA PRA TELA — decisão pura.
 *
 * @param g           o que `lerCobranca` devolveu
 * @param contaViva   o `check.id` que o poll trouxe
 * @param refsDaConta as marcas dos pagamentos da conta viva (`/api/check`)
 * @param marca       `refDoPagamento(g.charge.txid)`, recalculada agora
 */
export function restaurarNaTela(g: CobrancaGuardada | null, contaViva: string, refsDaConta: ReadonlySet<string>, marca: string | null): NaTela | null {
  if (!g) return null;
  const caiu = marca !== null && refsDaConta.has(marca);
  // Vencida: só volta como recibo, e só se o servidor confirma o pagamento.
  if (g.vencida) return caiu ? { fase: 'pago', charge: g.charge, ownRef: marca, paidAt: null } : null;
  if (g.fase === 'pago') {
    // O recibo volta só na conta dele (compliance HIGH-2) E confirmado pelo
    // servidor (segurança M-1). Sem `crypto.subtle` não há como confirmar: não
    // volta — a pessoa tem o comprovante do banco.
    if (g.checkId !== contaViva || !caiu) return null;
    return { fase: 'pago', charge: g.charge, ownRef: marca, paidAt: g.paidAt };
  }
  // Pendente que já caiu: direto pro recibo, sem data — a tela não sabe a hora
  // do pagamento, e o ✓ do poll gravaria a hora do RECARREGAR (segurança L-1).
  if (caiu) return { fase: 'pago', charge: g.charge, ownRef: marca, paidAt: null };
  // Pendente: volta mesmo com a conta trocada — a tela do Pix a mostra com o
  // aviso de conta trocada, sem o código.
  return { fase: 'pagar', charge: g.charge, ownRef: marca, paidAt: null };
}
