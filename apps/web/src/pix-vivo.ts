/**
 * O CÓDIGO NA TELA AINDA VALE PAGAR? — decisão pura, sem I/O e sem React.
 *
 * Cobrança pendente não reserva valor: duas pessoas geram Pix pra mesma parte,
 * uma paga, e a outra continuava vendo o próprio código com "Copiar código Pix"
 * — o telefone dela JÁ sabia, pelo poll, que a mesa estava quitada. A auditoria
 * de bordas mediu R$ 148,79 pagos a mais assim, sem um aviso antes (CB-1). É o
 * convite a pagar em duplicidade que o `App.tsx` trata como CDC art. 42.
 *
 * O servidor segura o dinheiro do lado dele: o pagamento a mais fica registrado
 * e sinalizado pra restituição. O que falta é a tela não CONVIDAR.
 */

export type AvisoDaCobranca =
  /** Pode pagar: a mesa ainda deve pelo menos o que este código cobra. */
  | 'ok'
  /** A mesa já está paga. Pagar este código é pagar a mais. */
  | 'mesa_paga'
  /** Alguém pagou uma parte: a mesa agora deve MENOS do que este código. */
  | 'passa_do_que_falta'
  /** A conta embaixo é outra (fechou e abriu a da próxima mesa no mesmo QR). */
  | 'conta_trocou';

export interface CobrancaNaTela {
  /** Quanto a conta viva ainda deve, em centavos (consumo, sem serviço). */
  faltaCents: number;
  /** O CONSUMO que este código cobra — `charge.amountCents`, sem o serviço. */
  cobrancaCents: number;
  /** A marca DESTA cobrança já apareceu entre os pagamentos da conta. */
  minhaCaiu: boolean;
  /** A conta em que a cobrança nasceu (do servidor), se ele mandou. */
  contaDaCobranca: string | null;
  /** A conta que o poll trouxe agora. */
  contaViva: string | null;
}

export function avisoDaCobranca(c: CobrancaNaTela): AvisoDaCobranca {
  // O MEU caiu: não é aviso, é o ✓ — o efeito de `App.tsx` leva pra "pago".
  // Sem isto, o telefone de quem fechou a mesa diria "a mesa já foi paga" pra
  // quem acabou de pagá-la, no quadro antes do ✓.
  if (c.minhaCaiu) return 'ok';
  if (c.contaDaCobranca && c.contaViva && c.contaDaCobranca !== c.contaViva) return 'conta_trocou';
  if (c.faltaCents <= 0) return 'mesa_paga';
  // Só o CONSUMO se compara: o serviço é da parte de cada um e não entra no
  // "falta" da mesa. Mesma régua do servidor, que recusa `amount_over` por ela.
  if (c.cobrancaCents > c.faltaCents) return 'passa_do_que_falta';
  return 'ok';
}

/** O pedaço da conta viva que a decisão lê — estrutural, sem puxar `api.ts`. */
export interface ContaViva {
  check: { id: string };
  state: { totalCents: number; paidCents: number; payments?: Record<string, { ref?: string }> };
}

/**
 * Os ARGUMENTOS da decisão, montados da conta viva — também puro, e testado
 * por valor. Montados no JSX, eles eram onde a guarda morria calada: um
 * `faltaCents` trocado pelo total, um `minhaCaiu` fixo em falso ou um
 * `contaDaCobranca` nulo desligavam os avisos com a suíte verde (segurança,
 * PR #17, M-3).
 */
export function cobrancaNaTela(
  view: ContaViva,
  charge: { amountCents: number; tipCents: number; checkId?: string },
  ownRef: string | null,
): CobrancaNaTela {
  return {
    faltaCents: Math.max(0, view.state.totalCents - view.state.paidCents),
    cobrancaCents: charge.amountCents,
    minhaCaiu: ownRef !== null && Object.values(view.state.payments || {}).some((p) => p.ref === ownRef),
    contaDaCobranca: charge.checkId ?? null,
    contaViva: view.check.id,
  };
}

/** As marcas dos pagamentos da conta viva — o que `restaurarNaTela` confere. */
export function marcasDaConta(view: ContaViva): Set<string> {
  return new Set(Object.values(view.state.payments || {}).map((p) => p.ref).filter((r): r is string => typeof r === 'string'));
}
