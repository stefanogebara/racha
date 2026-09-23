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

export interface ReciboVista {
  /** A barra de progresso e o "falta …" da conta. */
  mostrarProgresso: boolean;
  /** O botão "Pagar mais uma parte". */
  oferecerMais: boolean;
  /** A conta embaixo já é outra: o recibo congela e o poll para. */
  contaTrocou: boolean;
}

/**
 * @param contaPaga  o `check.id` em que ESTE telefone pagou (nulo = ainda não
 *                   gravado — o primeiro render depois do pagamento)
 * @param contaViva  o `check.id` que o poll trouxe agora
 * @param faltaCents quanto falta na conta viva
 */
export function reciboVista(contaPaga: string | null, contaViva: string | null, faltaCents: number): ReciboVista {
  if (contaPaga && contaViva && contaPaga !== contaViva) {
    return { mostrarProgresso: false, oferecerMais: false, contaTrocou: true };
  }
  return { mostrarProgresso: true, oferecerMais: faltaCents > 0, contaTrocou: false };
}
