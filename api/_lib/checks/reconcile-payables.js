'use strict';

/**
 * A TERCEIRA PERNA da conciliação: o razão do ADQUIRENTE contra o nosso.
 *
 * As duas pernas que já existiam — `check_events` e a linha de `payments` —
 * não são independentes: uma é projeção da outra, escritas pela mesma variável
 * na mesma chamada. Compará-las pega defeito de projeção e nada mais. Toda
 * revisão desta série apontou a mesma coisa, e o cabeçalho do
 * `reconcile-daily` já admitia a falta.
 *
 * Os RECEBÍVEIS (`GET /payables?charge_id=…`) são a terceira: uma linha por
 * recebedor, dizendo para quem o dinheiro daquela cobrança foi. Não são nossos
 * — quem escreve é a Pagar.me — e é isso que os torna testemunha.
 *
 * O invariante é o inegociável #4, literal: **todo o dinheiro vai da PSP pra
 * subconta do restaurante.** Um recebível de crédito em nome de qualquer outro
 * recebedor, inclusive o nosso, é conta-bolsão — e é o que faz a Racha precisar
 * de licença do BACEN (Res. 494/2025). Não é um número que divergiu: é o
 * perímetro regulatório mudando de lugar.
 *
 * O que provoca isso hoje: o split é `flat` pelo valor PEDIDO, e desde que
 * `overpaid` passou a contar como dinheiro recebido, o capturado pode passar da
 * soma das regras. A documentação diz que `charge_remainder_fee: true` manda o
 * restante pro recebedor da regra, e é o que a gente configura — mas ler a
 * documentação não é medir. Isto mede, em produção, a cada cobrança.
 *
 * PURO e TOTAL: sem I/O, nunca estoura. Quem busca é o chamador.
 */

/** Recebível que MOVE dinheiro pro recebedor (o resto é estorno/chargeback). */
const CREDITO = 'credit';

/**
 * @param {object} args
 * @param {string} args.chargeId
 * @param {string|null} args.venueRecipientId  o recebedor da CASA
 * @param {number} args.paidAmountCents        o que a cobrança capturou
 * @param {Array} args.payables                de `listChargePayables`
 * @returns {{chargeId: string, ok: boolean, findings: Array}}
 */
function reconcilePayables({ chargeId, venueRecipientId, paidAmountCents, payables }) {
  const findings = [];
  const add = (severity, code, message, extra = {}) =>
    findings.push({ severity, code, message, chargeId, ...extra });

  const linhas = Array.isArray(payables) ? payables : [];

  if (!venueRecipientId) {
    // Sem saber quem é a casa, não há o que afirmar. Não é verde: é cego.
    add('high', 'payables_no_recipient',
      `cobrança ${chargeId}: a casa não tem recebedor conhecido — impossível conferir o destino`);
    return { chargeId, ok: false, findings };
  }

  if (linhas.length === 0) {
    /**
     * Cobrança paga e nenhum recebível. Pode ser latência (o recebível nasce
     * depois da liquidação) — então `info`, não crítico. O que não pode é
     * passar como conferido: silêncio não é prova.
     */
    add('info', 'payables_absent',
      `cobrança ${chargeId}: nenhum recebível ainda — não deu pra conferir o destino do dinheiro`);
    return { chargeId, ok: true, findings };
  }

  const creditos = linhas.filter((l) => l && (l.type || CREDITO) === CREDITO);
  const estranhos = creditos.filter((l) => l.recipientId && l.recipientId !== venueRecipientId);

  for (const l of estranhos) {
    /**
     * CRÍTICO, e por um motivo diferente de todos os outros críticos deste
     * arquivo: não é dinheiro que divergiu, é dinheiro que ficou com quem não
     * devia. Se o recebedor estranho é o nosso, a Racha está custodiando —
     * inegociável #4, e licenciamento BACEN. Se é de terceiro, é pior.
     */
    add('critical', 'custody_leak',
      `cobrança ${chargeId}: ${l.amountCents}¢ foram para o recebedor ${l.recipientId}, `
      + `não para a casa (${venueRecipientId}) — dinheiro fora da subconta do restaurante`,
      { recipientId: l.recipientId, amountCents: l.amountCents });
  }

  // E o que a casa recebeu tem que dar o capturado, BRUTO de taxa: a casa
  // banca a taxa da transação (`charge_processing_fee: true`), então o
  // recebível dela vem líquido — somar `amount + fee` desfaz isso.
  const daCasa = creditos.filter((l) => l.recipientId === venueRecipientId);
  const brutoDaCasa = daCasa.reduce((s, l) => s + l.amountCents + l.feeCents, 0);
  if (Number.isSafeInteger(paidAmountCents) && paidAmountCents > 0 && brutoDaCasa !== paidAmountCents) {
    const delta = paidAmountCents - brutoDaCasa;
    // Um centavo de arredondamento de taxa não é notícia; uma sobra inteira é.
    add(Math.abs(delta) <= 1 ? 'info' : 'critical', 'payable_amount_mismatch',
      `cobrança ${chargeId}: capturou ${paidAmountCents}¢ e a casa recebeu ${brutoDaCasa}¢ `
      + `bruto de taxa (Δ ${delta}¢)`,
      { paidAmountCents, venueGrossCents: brutoDaCasa, deltaCents: delta });
  }

  return {
    chargeId,
    ok: !findings.some((f) => f.severity === 'critical' || f.severity === 'high'),
    findings,
  };
}

module.exports = { reconcilePayables, CREDITO };
