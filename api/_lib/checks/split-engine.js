'use strict';

/**
 * Split engine — pure, exact, integer-centavo money math.
 *
 * INVARIANT (the one that matters): every split of T centavos returns parts
 * that sum to EXACTLY T. No floats anywhere; callers that hold reais convert
 * at the boundary. Largest-remainder allocation; centavo leftovers are
 * distributed deterministically, rotated so repeated splits don't always tax
 * the same person.
 *
 * Serviço (the 10%) is computed here but is ALWAYS optional upstream
 * (CDC — the UI must allow removal; this module just does the math).
 */

/** Throws unless v is a safe non-negative integer (centavos). */
function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer (centavos), got: ${v}`);
  }
}

/**
 * Divide `totalCents` into `n` parts, each differing by at most 1 centavo,
 * summing exactly to totalCents. `rotate` shifts which positions absorb the
 * extra centavos (pass e.g. an item index so leftovers spread across people).
 *
 * @param {number} totalCents
 * @param {number} n - number of parts (>= 1)
 * @param {number} [rotate=0]
 * @returns {number[]} n parts, sum === totalCents
 */
function splitEqual(totalCents, n, rotate = 0) {
  assertCents(totalCents, 'totalCents');
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new TypeError(`n must be a positive integer, got: ${n}`);
  }
  if (!Number.isSafeInteger(rotate) || rotate < 0) {
    throw new TypeError(`rotate must be a non-negative integer, got: ${rotate}`);
  }
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  const parts = new Array(n).fill(base);
  for (let i = 0; i < remainder; i++) {
    parts[(i + rotate) % n] += 1;
  }
  return parts;
}

/**
 * Validate a custom split: the diner-entered amounts must cover the total
 * exactly. Returns { ok:true } or { ok:false, diffCents } (positive = short).
 *
 * @param {number} totalCents
 * @param {number[]} amounts
 */
function validateCustomSplit(totalCents, amounts) {
  assertCents(totalCents, 'totalCents');
  if (!Array.isArray(amounts) || amounts.length === 0) {
    throw new TypeError('amounts must be a non-empty array');
  }
  amounts.forEach((a, i) => assertCents(a, `amounts[${i}]`));
  const sum = amounts.reduce((s, a) => s + a, 0);
  return sum === totalCents ? { ok: true } : { ok: false, diffCents: totalCents - sum };
}

/**
 * Split by items: each item is claimed by one or more people; each person's
 * share is the exact sum of their item allocations. Item prices shared by k
 * people use largest-remainder with rotation by item position, so the extra
 * centavo doesn't always land on the same claimant.
 *
 * @param {Array<{id:string, priceCents:number, claimedBy:string[]}>} items
 *   claimedBy: personIds; must be non-empty per item (unclaimed → error, the
 *   UI resolves claims before computing).
 * @returns {{ perPerson: Record<string, number>, totalCents: number }}
 */
function splitByItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError('items must be a non-empty array');
  }
  // Null-prototype accumulator: personIds are diner-entered strings in a
  // no-login flow — a guest named "__proto__" must not vanish their share
  // (review finding: plain-object keying silently destroyed money).
  const perPerson = Object.create(null);
  let totalCents = 0;
  items.forEach((item, idx) => {
    assertCents(item.priceCents, `items[${idx}].priceCents`);
    if (!Array.isArray(item.claimedBy) || item.claimedBy.length === 0) {
      throw new Error(`item ${item.id ?? idx} has no claimants`);
    }
    if (new Set(item.claimedBy).size !== item.claimedBy.length) {
      throw new Error(`item ${item.id ?? idx} has duplicate claimants`);
    }
    if (totalCents + item.priceCents > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('check total exceeds safe integer range');
    }
    totalCents += item.priceCents;
    const shares = splitEqual(item.priceCents, item.claimedBy.length, idx);
    item.claimedBy.forEach((personId, j) => {
      if (typeof personId !== 'string' || personId.length === 0) {
        throw new TypeError(`items[${idx}].claimedBy must contain non-empty strings`);
      }
      perPerson[personId] = (perPerson[personId] || 0) + shares[j];
    });
  });
  return { perPerson, totalCents };
}

/**
 * Serviço (tip) on a base amount. Half-up rounding to the centavo.
 * pctBasisPoints: 1000 = 10%. Kept in basis points to stay integer-only.
 * NO default percentage (review finding): the venue's configured rate must be
 * passed explicitly — a silent 10% fallback is exactly the kind of implicit
 * charge the CDC rules exist to prevent.
 */
function servicoCents(baseCents, pctBasisPoints) {
  assertCents(baseCents, 'baseCents');
  if (!Number.isSafeInteger(pctBasisPoints) || pctBasisPoints < 0 || pctBasisPoints > 3000) {
    // >30% serviço is not a thing; catches unit mistakes (e.g. passing 10 for 10%... 10bp=0.1%).
    throw new TypeError(`pctBasisPoints out of range [0,3000]: ${pctBasisPoints}`);
  }
  if (pctBasisPoints > 0 && baseCents > Math.floor((Number.MAX_SAFE_INTEGER - 5000) / pctBasisPoints)) {
    throw new RangeError('servico computation exceeds safe integer range');
  }
  return Math.floor((baseCents * pctBasisPoints + 5000) / 10000);
}

/**
 * Rateia um ESTORNO entre consumo e gorjeta, na proporção do que foi pago.
 *
 * Por que isto existe, e por que é decisão jurídica e não aritmética: o
 * adaptador da Stripe fazia
 *
 *     amountCents: Math.max(0, refunded - tipCents),
 *     tipCents:    Math.min(tipCents, refunded),
 *
 * ou seja, devolvia a GORJETA INTEIRA primeiro e só depois tocava o consumo.
 * Num estorno parcial de R$ 5,00 sobre uma conta de R$ 30,82 + R$ 3,08 de
 * serviço, isso estornava R$ 3,08 de gorjeta e R$ 1,92 de consumo: o serviço
 * todo raspado por acidente de ordem de subtração.
 *
 * A gorjeta é remuneração do empregado (Lei 13.419/2017 + STJ Tema 1102) e o
 * total dela é a base da folha. Escolher quem perde primeiro num estorno é uma
 * decisão sobre o salário de alguém, e ela não pode ser efeito colateral de
 * um `Math.min`. Proporcional é a única regra defensável sem contrato dizendo
 * outra coisa: cada lado devolve a fatia que recebeu.
 *
 * Achado pela revisão de compliance de 2026-09-08.
 *
 * Exato por construção: as duas partes SOMAM o estorno, sempre. A gorjeta é
 * arredondada meio-pra-cima (igual ao `servicoCents`) e o consumo recebe o
 * resto — então nenhum centavo se cria nem desaparece.
 */
function allocateProportional(paidAmountCents, paidTipCents, refundCents) {
  assertCents(paidAmountCents, 'paidAmountCents');
  assertCents(paidTipCents, 'paidTipCents');
  assertCents(refundCents, 'refundCents');
  const paidTotal = paidAmountCents + paidTipCents;
  if (refundCents > paidTotal) {
    throw new RangeError(`refund ${refundCents} exceeds paid total ${paidTotal}`);
  }
  if (refundCents === 0 || paidTotal === 0) return { amountCents: 0, tipCents: 0 };
  if (paidTipCents === 0) return { amountCents: refundCents, tipCents: 0 };
  if (paidAmountCents === 0) return { amountCents: 0, tipCents: refundCents };
  // Meio-pra-cima em inteiros, sem float: (a*b + t/2) / t com t = paidTotal.
  const num = refundCents * paidTipCents;
  let tipCents = Math.floor((num * 2 + paidTotal) / (paidTotal * 2));
  // A borda: o rateio nunca pode devolver mais gorjeta do que existe, nem mais
  // consumo do que existe.
  if (tipCents > paidTipCents) tipCents = paidTipCents;
  let amountCents = refundCents - tipCents;
  if (amountCents > paidAmountCents) {
    amountCents = paidAmountCents;
    tipCents = refundCents - amountCents;
  }
  return { amountCents, tipCents };
}

/**
 * Rateio de ESTORNO. Mesmo cálculo, nome que diz de que lado o dinheiro anda.
 */
const allocateRefund = allocateProportional;

/**
 * Reparte um pagamento PARCIAL entre consumo e gorjeta — o SERVIÇO É O RESÍDUO.
 *
 * No Pix o cliente digita o valor no app do banco e pode pagar menos do que a
 * cobrança pediu (`underpaid`). O dinheiro chegou; falta decidir o que ele
 * quitou.
 *
 * Esta função JÁ FOI um alias de `allocateProportional`, e o raciocínio era
 * "é a mesma decisão do estorno". Não é, e a diferença é jurídica:
 *
 *  - No ESTORNO o pagamento foi completo. As duas parcelas foram validamente
 *    recebidas, então desfazer tira uma fatia proporcional de cada.
 *  - No PAGAMENTO A MENOR nada de serviço foi recebido ainda, e a pergunta é
 *    de IMPUTAÇÃO (CC art. 352: quem paga indica qual dívida quita). As duas
 *    linhas não são da mesma natureza: o preço da comida é dívida líquida do
 *    consumidor; os 10% são OPCIONAIS (CDC art. 39, V e § único — o
 *    inegociável #3) e, pelo STJ Tema 1102, nem sequer são receita da casa.
 *    Numa conta cuja única linha recusável é o serviço, quem digita menos está
 *    indicando exatamente isso — recusando ou arredondando o serviço, não
 *    dando calote parcial no prato.
 *
 * O que a regra proporcional produzia, concretamente: conta de R$ 33,90 +
 * R$ 3,39 de serviço, cliente paga R$ 33,90 exatos. Proporcional registrava
 * R$ 30,81 de consumo + R$ 3,09 de gorjeta, a conta ficava `parcial` devendo
 * R$ 3,09 de comida QUE A CASA JÁ RECEBEU, e a mesa era apresentada de novo —
 * CDC art. 42 § único, repetição em dobro. E inflava a base da folha em 309
 * centavos que o cliente recusou, que a casa teria que bancar do próprio
 * caixa com INSS/IRRF/FGTS por cima.
 *
 * Com o serviço como resíduo: consumo R$ 33,90, gorjeta zero, conta QUITADA.
 *
 * O contrapeso obrigatório: como esta regra favorece sistematicamente a casa
 * na linha da gorjeta, o relatório do restaurante mostra serviço COBRADO vs
 * serviço ARRECADADO por período. Uma diferença visível é um fato do negócio;
 * a mesma diferença invisível é uma reclamação trabalhista.
 *
 * A regra é fixa no código e igual pra toda casa — nunca configurável, porque
 * um botão que encolhe a base da folha é exatamente o que uma fiscalização
 * lê como má-fé.
 *
 * Recomendação da revisão de compliance de 2026-09-08.
 */
function allocateUnderpayment(orderAmountCents, orderTipCents, receivedCents) {
  assertCents(orderAmountCents, 'orderAmountCents');
  assertCents(orderTipCents, 'orderTipCents');
  assertCents(receivedCents, 'receivedCents');
  const pedido = orderAmountCents + orderTipCents;
  if (receivedCents > pedido) {
    throw new RangeError(`received ${receivedCents} exceeds order ${pedido}`);
  }
  // O consumo primeiro, até o limite do que a conta pediu; o que sobrar é
  // serviço. As duas partes somam o recebido por construção.
  const amountCents = Math.min(receivedCents, orderAmountCents);
  return { amountCents, tipCents: receivedCents - amountCents };
}

module.exports = {
  splitEqual, validateCustomSplit, splitByItems, servicoCents,
  allocateProportional, allocateRefund, allocateUnderpayment, assertCents,
};
