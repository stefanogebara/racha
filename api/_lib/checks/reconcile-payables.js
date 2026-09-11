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

  /**
   * O adaptador diz que o id não é de cobrança do adquirente. Isso não é
   * latência de liquidação: é uma cobrança que nunca passou por adquirente
   * nenhum, e chamá-la de "nenhum recebível ainda" é afirmar um estado em que o
   * sistema não está. (HIGH-3 da revisão de compliance de 2026-09-10.)
   */
  if (payables && payables.notFromAcquirer === true) {
    add('high', 'charge_not_from_acquirer',
      `cobrança ${chargeId}: não é uma cobrança do adquirente — não existe recebível a conferir,`
      + ' e o destino deste dinheiro não é conferível por aqui');
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

  /**
   * CONJUNTO FECHADO de tipos, e recebedor ausente não é "tudo bem".
   *
   * `(l.type || CREDITO) === CREDITO` fazia tipo ausente ou desconhecido virar
   * crédito por padrão: uma linha de `refund` sem tipo (valor negativo)
   * envenenava a soma e produzia um crítico falso. E
   * `l.recipientId && l.recipientId !== casa` é a forma `if (coisa && !ok)` —
   * um recebível sem recebedor passava justo pela conferência que NOMEIA a
   * conta que ficou com o dinheiro. Achado pela revisão de segurança de
   * 2026-09-08.
   */
  const NAO_CREDITO = new Set(['refund', 'chargeback', 'chargeback_refund', 'refund_reversal',
    'block', 'unblock']);
  // Tipo AUSENTE conta como desconhecido, não como crédito. O comentário acima
  // dizia "tipo ausente ou desconhecido" e só a segunda metade tinha pousado:
  // uma linha de `refund` sem tipo (valor negativo) seguia entrando na soma e
  // podia produzir um `payable_amount_mismatch` CRÍTICO falso — o cenário que
  // o comentário dizia estar fechado. Achado pela revisão de segurança de
  // 2026-09-09 (LOW-2).
  const desconhecidos = linhas.filter((l) => l && l.type !== CREDITO
    && !NAO_CREDITO.has(l.type));
  for (const l of desconhecidos) {
    add('high', 'payable_type_unknown',
      `cobrança ${chargeId}: recebível de tipo desconhecido (${l.type}) — não sei se move dinheiro`,
      { type: l.type, amountCents: l.amountCents });
  }
  // Forma inválida é achado, não zero somado. Ver `centavos()` no adaptador.
  //
  // A TAXA conta como forma: `feeCents` deixou de virar `0` quando o adquirente
  // omite `fee`, porque taxa ausente fazia o LÍQUIDO parecer melhor do que é —
  // e é o líquido que decide `payable_net_negative`. Sem ela aqui, `amountCents
  // - feeCents` daria `NaN` e a soma inteira da casa viraria `NaN` calada.
  //
  // E a TAXA só é exigida de quem entra na soma: um `refund`/`chargeback` sem
  // `fee` não some em lugar nenhum, e exigi-la dele fazia toda cobrança
  // estornada virar `high` E cega ao mesmo tempo (MEDIUM-1 da compliance).
  const somaEsta = (l) => l.type === CREDITO;
  const formaOk = (l) => Number.isSafeInteger(l.amountCents)
    && (!somaEsta(l) || Number.isSafeInteger(l.feeCents));
  const invalidos = linhas.filter((l) => l && !formaOk(l));
  for (const l of invalidos) {
    /**
     * O DESTINO é legível mesmo quando o VALOR não é — e custódia se decide
     * pelo destino.
     *
     * A linha de forma inválida saía de `creditos`, então `estranhos` nunca a
     * via, então o `custody_leak` não podia disparar: um crédito de valor
     * ilegível para um recebedor que NÃO é a casa virava `payable_shape_invalid`
     * (`high`) em vez de crítico. Exatamente "um vazamento de verdade
     * reportado como problema de forma". Mas o `recipient_id` atravessa o
     * adaptador intacto — dá pra nomear pra quem foi, mesmo sem saber quanto.
     *
     * Inegociável #4 e BACEN Res. 494/2025. Achado pela revisão de compliance
     * de 2026-09-09 (HIGH-2).
     */
    if (somaEsta(l) && l.recipientId && l.recipientId !== venueRecipientId) {
      add('critical', 'custody_leak_unreadable',
        `cobrança ${chargeId}: recebível de valor ILEGÍVEL destinado a ${l.recipientId}, `
        + 'que não é a casa — não sei quanto, sei pra quem',
        { recipientId: l.recipientId });
      continue;
    }
    add('high', 'payable_shape_invalid',
      // NÃO diz mais "não entra na soma": quando o ilegível é um CRÉDITO, a
      // soma nem é feita (ver a suspensão abaixo). Afirmar verificação parcial
      // onde não houve verificação nenhuma é o erro que a suspensão evitou.
      `cobrança ${chargeId}: recebível com valor ilegível — não deu pra conferir o destino desta cobrança`,
      { recipientId: l.recipientId || null });
  }
  const creditos = linhas.filter((l) => l && l.type === CREDITO && formaOk(l));
  const semRecebedor = creditos.filter((l) => !l.recipientId);
  for (const l of semRecebedor) {
    add('high', 'payable_no_recipient_field',
      `cobrança ${chargeId}: recebível de ${l.amountCents}¢ sem recebedor — destino não nomeável`,
      { amountCents: l.amountCents });
  }
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

  /**
   * `amount` do recebível JÁ É O BRUTO. A taxa é desconto, não parcela.
   *
   * Eu tinha escrito `amount + fee` — reconstruindo um bruto que já estava
   * ali. A documentação do recebível é explícita: `amount` é "valor em centavos
   * que foi pago" e `fee` é "valor em centavos que foi cobrado (taxa)"; o
   * recebedor fica com `amount - fee`. Somar dobrava a taxa.
   *
   * O efeito era pior que um número errado. A conferência do destino
   * (`custody_leak`) estava inalcançável por outro defeito — a casa chegava
   * aqui sem recebedor conhecido — e este saía antes deste ponto. Consertar só
   * aquele teria ligado ESTE: `critical` em toda cobrança saudável, toda
   * noite, em toda casa. Os dois defeitos se escondiam um atrás do outro.
   * Achado pela revisão de segurança de 2026-09-08.
   */
  const daCasa = creditos.filter((l) => l.recipientId === venueRecipientId);
  const brutoDaCasa = daCasa.reduce((s, l) => s + l.amountCents, 0);
  const liquidoDaCasa = daCasa.reduce((s, l) => s + l.amountCents - l.feeCents, 0);
  /**
   * LINHA ILEGÍVEL SUSPENDE A SOMA — cego não é vazado.
   *
   * Com uma linha de forma inválida ela sai de `creditos`, e o bruto da casa
   * caía pro que restou. No caso de UMA linha só, isso virava "capturou 23710¢
   * e a casa recebeu 0¢" — um `custody_leak` por vizinhança, CRÍTICO, contando
   * uma história falsa numa perna cuja única função é decidir custódia. Não
   * poder LER o razão do adquirente é "não sei", e "não sei" já tem o seu
   * achado (`payable_shape_invalid`, `high`). Afirmar que o dinheiro não chegou
   * é uma afirmação diferente, e não é esta que os dados sustentam.
   */
  // Só CRÉDITO ilegível suspende: a soma é feita de créditos, e um `refund`
  // malformado não a torna incerta (MEDIUM-1 da compliance de 2026-09-09).
  const ilegivel = linhas.some((l) => l && somaEsta(l) && !formaOk(l));
  if (!ilegivel
      && Number.isSafeInteger(paidAmountCents) && paidAmountCents > 0 && brutoDaCasa !== paidAmountCents) {
    const delta = paidAmountCents - brutoDaCasa;
    // Um centavo é arredondamento; uma sobra inteira é dinheiro em outro lugar.
    add(Math.abs(delta) <= 1 ? 'info' : 'critical', 'payable_amount_mismatch',
      `cobrança ${chargeId}: capturou ${paidAmountCents}¢ e a casa recebeu ${brutoDaCasa}¢ `
      + `bruto (Δ ${delta}¢)`,
      { paidAmountCents, venueGrossCents: brutoDaCasa, venueNetCents: liquidoDaCasa, deltaCents: delta });
  }
  // Taxa maior que o recebível é impossível, e um líquido negativo viraria
  // faturamento negativo silencioso lá na frente.
  if (liquidoDaCasa < 0) {
    add('critical', 'payable_net_negative',
      `cobrança ${chargeId}: a taxa passou do recebível — líquido ${liquidoDaCasa}¢`,
      { venueNetCents: liquidoDaCasa });
  }

  return {
    chargeId,
    ok: !findings.some((f) => f.severity === 'critical' || f.severity === 'high'),
    findings,
  };
}

module.exports = { reconcilePayables, CREDITO };
