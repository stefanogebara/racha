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
import type { ChargeResult } from './api';

export type Fase = 'pagar' | 'pago';

export interface CobrancaGuardada {
  v: 1;
  checkId: string;
  charge: ChargeResult;
  /** A marca da cobrança na conta pública (`pagamento-ref.ts`); nula se o aparelho não calcula. */
  ownRef: string | null;
  fase: Fase;
  /** Quando o pagamento foi confirmado — o carimbo do comprovante. */
  paidAt: string | null;
  guardadaEm: number;
}

/** Um Pix vence em 15 min; passado disso, o código na tela não paga mais nada. */
export const VALIDADE_DA_COBRANCA_MS = 20 * 60_000;
/** O recibo vale a noite: quem volta pra conferir depois do café ainda o vê. */
export const VALIDADE_DO_RECIBO_MS = 6 * 60 * 60_000;

const chave = (token: string) => `racha-cobranca:${token}`;

type Armazem = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function armazem(): Armazem | null {
  try { return window.localStorage; } catch { return null; }
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
    if (venceu) { esquecerCobranca(token, a); return null; }
    return d;
  }
  if (idade > VALIDADE_DO_RECIBO_MS) { esquecerCobranca(token, a); return null; }
  return d;
}
