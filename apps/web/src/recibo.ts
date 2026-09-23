/**
 * O RECIBO FICA PRESO À CONTA QUE FOI PAGA.
 *
 * A tela de "pago" montava a barra de progresso e o botão "Pagar mais uma
 * parte" a partir da conta VIVA do poll, enquanto o "Você pagou" vinha da
 * cobrança local. Nada comparava o `check.id`. Então, quando a conta embaixo
 * trocava, a mesma tela dizia ao mesmo tempo "Você pagou R$ 237,10" e "falta
 * R$ 237,10" — com um botão pra pagar de novo.
 *
 * Isso tem dois caminhos, e o da demo é o menor:
 *
 *  · NA DEMO, a conta paga se renova depois de 90s (`demoPagaHaTempo`).
 *  · NUMA CASA DE VERDADE — e isto é anterior a tudo aqui —, a pessoa paga e
 *    deixa a aba aberta, o dono fecha a mesa, o garçom abre a conta da
 *    PRÓXIMA mesa no mesmo QR. O telefone de quem já foi embora continuava
 *    sondando, passava a mostrar o progresso da conta dos outros e oferecia
 *    "Pagar mais uma parte": um toque e a pessoa estava nos itens de outra mesa
 *    e num Pix de dinheiro real. É o convite a pagar em duplicidade que o
 *    próprio `App.tsx` trata como CDC art. 42.
 *
 * Achado pela revisão de compliance de 2026-09-23 — a renovação da demo tornou
 * o caminho repetível o bastante pra ser visto.
 *
 * Decisão pura, sem I/O e sem React, pra ser testada sem navegador.
 */

/** Um aviso de dinheiro da conta — o que a casa deve ao cliente. */
export interface AvisoDaConta {
  code: 'overpaid_pending_restitution' | 'refund_reversed';
  amountCents: number;
}

export interface ReciboVista {
  /** A barra de progresso e o "falta …" da conta. */
  mostrarProgresso: boolean;
  /** O botão "Pagar mais uma parte". */
  oferecerMais: boolean;
  /** A conta embaixo já é outra: o recibo congela e o poll para. */
  contaTrocou: boolean;
  /**
   * OS AVISOS DE DINHEIRO a mostrar no recibo — sempre os da conta PAGA.
   *
   * Moram aqui, e não lidos direto do `state` no JSX, porque foi assim que a
   * primeira versão deixou passar: o progresso e o botão passavam por esta
   * decisão, os avisos não. Quem tinha valor a receber perdia o aviso na troca
   * e, com o poll atrasado, via o aviso da mesa dos outros como se fosse dele.
   */
  avisos: AvisoDaConta[];
}

/**
 * @param contaPaga      o `check.id` em que a cobrança deste telefone NASCEU
 *                       (vem do servidor, na própria cobrança — não do poll)
 * @param contaViva      o `check.id` que o poll trouxe agora
 * @param faltaCents     quanto falta na conta viva
 * @param avisosVivos    os avisos da conta viva
 * @param avisosDaPaga   os últimos avisos vistos da conta PAGA, enquanto ela
 *                       ainda era a viva (nulo = nunca vistos)
 */
export function reciboVista(
  contaPaga: string | null,
  contaViva: string | null,
  faltaCents: number,
  avisosVivos: readonly AvisoDaConta[],
  avisosDaPaga: readonly AvisoDaConta[] | null,
): ReciboVista {
  if (contaPaga && contaViva && contaPaga !== contaViva) {
    // Nunca os vivos: são da mesa de outra pessoa. Se nunca vimos os da conta
    // paga, não se inventa — fica vazio, que é o comportamento de antes.
    return { mostrarProgresso: false, oferecerMais: false, contaTrocou: true, avisos: [...(avisosDaPaga ?? [])] };
  }
  return { mostrarProgresso: true, oferecerMais: faltaCents > 0, contaTrocou: false, avisos: [...avisosVivos] };
}
