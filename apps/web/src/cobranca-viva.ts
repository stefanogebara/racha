/**
 * A COBRANÇA E O RECIBO SOBREVIVEM A UM RECARREGAR.
 *
 * `charge`, a marca da cobrança e o passo da tela viviam só no estado do React.
 * O iPhone e o Android descartam a aba enquanto a pessoa está no app do banco;
 * na volta a página recarrega, e ela via "Pagar R$ 130,41 com Pix" armado de
 * novo, sem comprovante — com a barra contando 118,55 quando ela pagou 130,41.
 * Recarregar, voltar ou abrir o QR em outra aba gerava OUTRA cobrança, e pagar
 * as duas cobrou R$ 20 por uma parte de R$ 10, a segunda sem comprovante em
 * lugar nenhum. As duas auditorias de cliente acharam isto (BR-1, CB-2).
 *
 * Guardado no `localStorage` e não no `sessionStorage`: abrir o QR de novo é
 * uma aba NOVA, e é justamente quem escaneia outra vez que gera a segunda
 * cobrança. Por MESA (o token) e presa à CONTA em que nasceu. Nada aqui é
 * segredo: o copia-e-cola paga a casa, e nenhum dado do pagador é guardado.
 *
 * Tudo em `try`: aba privada, armazenamento cheio ou bloqueado — a tela segue
 * funcionando como antes, só sem a memória.
 */
/**
 * A forma da cobrança que este módulo guarda — a parte do `ChargeResult` de
 * `api.ts` que a tela usa. Declarada aqui, e não importada, porque os testes
 * rodam em Node sem os tipos do navegador, e o `api.ts` os puxa inteiros.
 * O `App.tsx` passa um `ChargeResult`, que é compatível por estrutura.
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
  v: 1;
  checkId: string;
  charge: CobrancaDaTela;
  /** A marca da cobrança na conta pública (`pagamento-ref.ts`); nula se o aparelho não calcula. */
  ownRef: string | null;
  fase: Fase;
  /** Quando o pagamento foi confirmado — o carimbo do comprovante. */
  paidAt: string | null;
  guardadaEm: number;
  /**
   * Só na LEITURA: a cobrança pendente passou da validade. Ela volta assim uma
   * vez, pra tela conferir se a marca dela caiu na conta antes de esquecê-la —
   * quem pagou aos 10 min e voltou à aba aos 25 perdia o recibo (compliance,
   * PR #17, MEDIUM-3). Quem lê decide; `lerCobranca` já a apagou.
   */
  vencida?: boolean;
}

/** Um Pix vence em 15 min; passado disso, o código na tela não paga mais nada. */
export const VALIDADE_DA_COBRANCA_MS = 20 * 60_000;
/** O recibo vale a noite: quem volta pra conferir depois do café ainda o vê. */
export const VALIDADE_DO_RECIBO_MS = 6 * 60 * 60_000;

const chave = (token: string) => `racha-cobranca:${token}`;

type Armazem = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function armazem(): Armazem | null {
  // `globalThis`, não `window`: o mesmo objeto no navegador, e o módulo
  // compila no Node dos testes. Sem `localStorage` (Node, aba bloqueada) → nulo.
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

export function guardarCobranca(token: string, dados: Omit<CobrancaGuardada, 'v'>, a: Armazem | null = armazem()): void {
  if (!token || !a) return;
  try { a.setItem(chave(token), JSON.stringify({ v: 1, ...dados })); } catch { /* cheio ou bloqueado */ }
}

export function esquecerCobranca(token: string, a: Armazem | null = armazem()): void {
  if (!token || !a) return;
  try { a.removeItem(chave(token)); } catch { /* bloqueado */ }
}

/**
 * O que VOLTA pra tela — ou nulo, e aí a tela abre na conta como sempre.
 *
 * Uma cobrança pendente volta só dentro da validade. Volta MESMO com a conta
 * trocada: a pessoa pode ter pago no banco antes de a aba recarregar, e sumir
 * com o código seria sumir com a única pista disso. A tela a mostra com o aviso
 * de conta trocada (`pix-vivo.ts`), sem o código. Um recibo volta até o fim da
 * noite — o `recibo.ts` já sabe congelá-lo se a conta trocou. Qualquer coisa
 * fora da forma é descartada, não consertada.
 */
/**
 * Apaga o que venceu em QUALQUER mesa. Sem isto a validade só valia pra mesa
 * lida de novo, e a de uma casa que a pessoa nunca mais visitou ficava no
 * aparelho pra sempre (LGPD art. 15 e 16 — compliance, PR #17, LOW-1).
 */
export function varrerVencidas(agoraMs: number, exceto: string, a: (Armazem & Pick<Storage, 'length' | 'key'>) | null = armazem() as Storage | null): void {
  if (!a) return;
  try {
    const chaves: string[] = [];
    // A mesa ABERTA agora fica de fora: a dela é lida logo depois, e uma
    // cobrança vencida mas paga tem de chegar inteira a quem confere a marca.
    for (let i = 0; i < a.length; i++) {
      const k = a.key(i);
      if (k && k.startsWith('racha-cobranca:') && k !== chave(exceto)) chaves.push(k);
    }
    for (const k of chaves) lerCobranca(k.slice('racha-cobranca:'.length), agoraMs, a);
  } catch { /* bloqueado */ }
}

export function lerCobranca(token: string, agoraMs: number, a: Armazem | null = armazem()): CobrancaGuardada | null {
  if (!token || !a) return null;
  let bruto: string | null = null;
  try { bruto = a.getItem(chave(token)); } catch { return null; }
  if (!bruto) return null;
  let d: CobrancaGuardada;
  try { d = JSON.parse(bruto) as CobrancaGuardada; } catch { esquecerCobranca(token, a); return null; }
  const forma = d && d.v === 1 && typeof d.checkId === 'string' && d.charge
    && typeof d.charge.txid === 'string' && Number.isInteger(d.charge.amountCents)
    && Number.isInteger(d.charge.tipCents) && (d.fase === 'pagar' || d.fase === 'pago')
    && Number.isFinite(d.guardadaEm);
  if (!forma) { esquecerCobranca(token, a); return null; }
  const idade = agoraMs - d.guardadaEm;
  if (d.fase === 'pagar') {
    const venceu = idade > VALIDADE_DA_COBRANCA_MS
      || (d.charge.expiresAt != null && Date.parse(d.charge.expiresAt) <= agoraMs);
    if (venceu) { esquecerCobranca(token, a); return { ...d, vencida: true }; }
    return d;
  }
  if (idade > VALIDADE_DO_RECIBO_MS) { esquecerCobranca(token, a); return null; }
  return d;
}
