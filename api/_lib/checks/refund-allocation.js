'use strict';

/**
 * COMO UMA DEVOLUÇÃO SE REPARTE entre consumo e serviço — uma regra só, pura,
 * usada pelo estorno que vem do PSP (`webhook-handler`) e pelo que o dono
 * registra fora do trilho (`/api/checks/record-restitution`).
 *
 * Era a MESMA conta escrita duas vezes, em dois arquivos, e as duas cópias já
 * tinham divergido uma vez. Pior: nenhuma das duas conhecia o serviço DEVIDO do
 * pago-depois-de-fechar, e é ele que faz a regra existir.
 *
 * Três baldes, nesta ordem:
 *
 *  1. O EXCEDENTE, do consumo. Foi por ali que entrou (ver `parseCharge`), é
 *     por ali que sai.
 *  2. O SERVIÇO DEVIDO de um pagamento atrasado, da gorjeta. Quando a mesa já
 *     havia pagado no caixa, a parte duplicada volta inteira — e os 10% sobre
 *     ela nunca foram serviço prestado a ninguém: são do cliente. Proporcional,
 *     este balde saía errado, e o erro fica na BASE DA FOLHA do garçom (Lei
 *     13.419/2017 e STJ Tema 1102 — o serviço é remuneração, distribuída por
 *     folha). Devolver R$ 110 de uma duplicação de R$ 100 + R$ 10 tem de deixar
 *     a gorjeta menor em exatamente R$ 10.
 *  3. O RESTO é estorno comum, proporcional sobre o que sobrou dos dois
 *     primeiros — a regra de sempre, que devolve junto a fatia de serviço do
 *     que foi estornado.
 *
 * Compliance MEDIUM-2 de 3eea5f3.
 *
 * O excedente é DERIVADO pelo redutor (ver `PAYMENT_CONFIRMED`), então aqui ele
 * nunca falta. Quanto ainda falta restituir sai por subtração, e é exato por
 * construção: o excedente sai do consumo PRIMEIRO, então os primeiros
 * `refundedAmountCents` centavos devolvidos foram exatamente ele. Nada de teto
 * pela sobra da CONTA — ela é reduzida por qualquer coisa que mexa no total, e
 * um teto assim vazava entre pagadores: compensar a dívida de um com o crédito
 * de outro não existe (CC art. 876).
 *
 * A conta que ENCOLHEU depois de paga (`ADJUSTED` pra baixo) também produz
 * sobra, e nela nenhum pagamento tem excedente — corretamente: ninguém pagou a
 * mais, a conta diminuiu. Aí o estorno é comum e proporcional, o que devolve
 * junto a fatia de serviço do item que saiu.
 */

const { paidAfterClose } = require('./check-state');
const { allocateProportional, allocateRefund, allocateRestitution } = require('./split-engine');

/** O serviço que este pagamento atrasado deve de volta, dê no que der. */
function servicoDevidoDoAtrasado(estado, txid) {
  if (!estado) return 0;
  return paidAfterClose(estado)
    .filter((x) => x.txid === txid && x.sempreDevido)
    .reduce((soma, x) => soma + x.amountCents, 0);
}

/**
 * @param {object|null} estado estado derivado do razão (pode faltar: aí não há
 *   serviço devido a conhecer e a regra é a de sempre)
 * @param {string} txid
 * @param {object} pg o pagamento no estado derivado
 * @param {number} valor centavos desta devolução
 */
function alocarDevolucaoDoPagamento(estado, txid, pg, valor) {
  const consumo = Math.max(0, pg.amountCents - (pg.refundedAmountCents || 0));
  const gorjeta = Math.max(0, (pg.tipCents || 0) - (pg.refundedTipCents || 0));
  const excedente = Math.min(
    Math.max(0, (pg.excessCents || 0) - (pg.refundedAmountCents || 0)),
    consumo,
  );
  const devido = Math.min(servicoDevidoDoAtrasado(estado, txid), gorjeta);
  // Sem serviço devido, nada muda: as duas regras antigas, intactas.
  if (devido === 0) {
    return excedente > 0
      ? allocateRestitution(consumo, gorjeta, valor, excedente)
      : allocateRefund(consumo, gorjeta, valor);
  }
  const doExcedente = Math.min(valor, excedente);
  let resto = valor - doExcedente;
  const daGorjetaDevida = Math.min(resto, devido);
  resto -= daGorjetaDevida;
  if (resto === 0) return { amountCents: doExcedente, tipCents: daGorjetaDevida };
  const p = allocateProportional(consumo - doExcedente, gorjeta - daGorjetaDevida, resto);
  return { amountCents: doExcedente + p.amountCents, tipCents: daGorjetaDevida + p.tipCents };
}

module.exports = { alocarDevolucaoDoPagamento, servicoDevidoDoAtrasado };
