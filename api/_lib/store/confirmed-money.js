'use strict';

/**
 * O dinheiro CONFIRMADO de uma linha de pagamento.
 *
 * Existe porque os dois stores precisam da mesma regra e porque a regra é
 * sutil: a linha guarda o valor PEDIDO (`amountCents`, escrito na criação da
 * cobrança) e, desde a migração 0015, também o CONFIRMADO pelo PSP. São
 * números diferentes quando há divergência — pedimos 3390, o PSP confirmou
 * 2450 — e é justamente a diferença entre eles que a conciliação usa pra
 * produzir `amount_mismatch` e `ledger_drift`.
 *
 * Quem soma FATURAMENTO e GORJETA quer o confirmado: é o dinheiro que existe.
 * A gorjeta em especial é a base da folha (Lei 13.419/2017 + STJ Tema 1102), e
 * o painel somava a pedida — o dono levava pra folha um número que o dinheiro
 * não cobria. Achado pela revisão de compliance de 2026-09-08.
 *
 * Nulo cai no registrado: ou o pagamento é anterior à coluna, ou está pendente.
 * Nos dois casos o valor registrado é o que aquele histórico quer dizer.
 */
function confirmedMoney(row) {
  const amountCents = Number.isFinite(row && row.confirmedAmountCents)
    ? row.confirmedAmountCents : (row ? row.amountCents : 0);
  const tipCents = Number.isFinite(row && row.confirmedTipCents)
    ? row.confirmedTipCents : (row ? row.tipCents : 0);
  // LÍQUIDO: confirmado menos estornado.
  //
  // Sem isto, um estorno parcial fazia o pagamento inteiro sumir do
  // faturamento e da gorjeta, porque a linha virava `devolvido` e os
  // agregadores filtram por `confirmado`. Num estorno de R$ 5,00 sobre
  // R$ 33,90 a linha de gorjeta caía 308¢ em vez dos 45¢ do rateio
  // proporcional — desfazendo no relatório a correção feita no razão.
  // Ver a migração 0016.
  const estornado = Number(row && row.refundedAmountCents) || 0;
  const estornadoGorjeta = Number(row && row.refundedTipCents) || 0;
  return {
    amountCents: Math.max(0, (amountCents || 0) - estornado),
    tipCents: Math.max(0, (tipCents || 0) - estornadoGorjeta),
  };
}

module.exports = { confirmedMoney };
