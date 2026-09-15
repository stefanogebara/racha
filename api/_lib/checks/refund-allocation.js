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
 *  2. O SERVIÇO DEVIDO de um pagamento atrasado, da gorjeta, INTEIRO. É o caso
 *     em que o RAZÃO já mostrava a conta quitada e um atrasado entrou por cima:
 *     os 10% sobre a parte duplicada nunca foram serviço prestado a ninguém —
 *     são do cliente. Proporcional, este balde saía errado, e o erro fica na
 *     BASE DA FOLHA do garçom (Lei 13.419/2017 e STJ Tema 1102 — o serviço é
 *     remuneração, distribuída por folha). Devolver R$ 110 de uma duplicação de
 *     R$ 100 + R$ 10 tem de deixar a gorjeta menor em exatamente R$ 10.
 *
 *     O texto anterior dizia "quando a mesa já havia pagado no caixa", e isso é
 *     FALSO sobre o código: o Racha não registra o caixa, então a duplicação de
 *     caixa não produz sobra nenhuma e este balde fica zerado nela (compliance
 *     MEDIUM-1 de ec86b37). Quem cuida daquele caso é o balde 3.
 *  3. O RESTO. Num pagamento ATRASADO ainda sem resposta, sai do CONSUMO
 *     primeiro e só depois da gorjeta; em qualquer outro, é estorno comum e vai
 *     proporcional.
 *
 *     Por quê: devolver 100 de um atrasado de 100 + 10 pelo proporcional
 *     devolvia 90,91 de consumo e 9,09 de gorjeta — sobrava consumo pago, a
 *     marca não fechava, e ficavam 0,91 de serviço na folha sobre um
 *     atendimento que talvez nunca tenha existido (compliance MEDIUM-2 de
 *     ec86b37). Consumo primeiro devolve o principal inteiro e deixa a marca
 *     valendo exatamente o serviço que ainda não voltou — visível no painel, em
 *     vez de diluído.
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
 * @param {{forcada?: boolean}} [opcoes] `forcada` quando o dinheiro foi TIRADO
 *   (chargeback/disputa perdida) em vez de devolvido por escolha da casa.
 */
function alocarDevolucaoDoPagamento(estado, txid, pg, valor, opcoes = {}) {
  const consumo = Math.max(0, pg.amountCents - (pg.refundedAmountCents || 0));
  const gorjeta = Math.max(0, (pg.tipCents || 0) - (pg.refundedTipCents || 0));
  const excedente = Math.min(
    Math.max(0, (pg.excessCents || 0) - (pg.refundedAmountCents || 0)),
    consumo,
  );
  const devido = Math.min(servicoDevidoDoAtrasado(estado, txid), gorjeta);
  // Sem serviço devido E fora de um atrasado em aberto, nada muda: as duas
  // regras antigas, intactas.
  if (devido === 0 && !consumoPrimeiro(pg, opcoes)) {
    return excedente > 0
      ? allocateRestitution(consumo, gorjeta, valor, excedente)
      : allocateRefund(consumo, gorjeta, valor);
  }
  return tresBaldes(consumo, gorjeta, excedente, devido, valor, consumoPrimeiro(pg, opcoes));
}

/**
 * O consumo volta antes da gorjeta só numa devolução ESCOLHIDA por quem devolve.
 *
 * Num CHARGEBACK ninguém escolheu nada: a rede tirou o dinheiro, e o razão está
 * registrando de onde ele saiu — aí a verdade é o proporcional. Mandar a gorjeta
 * inteira ficar nos livros enquanto a rede levou parte do dinheiro mentiria pra
 * folha, que é exatamente o que o comentário do `webhook-handler` já dizia sobre
 * o chargeback levar a gorjeta junto (compliance MEDIUM-2 de d7f2683).
 */
function consumoPrimeiro(pg, opcoes) {
  if (opcoes && opcoes.forcada) return false;
  return pg.late === true && pg.lateResolved !== true;
}

function tresBaldes(consumo, gorjeta, excedente, devido, valor, consumoPrimeiro) {
  const doExcedente = Math.min(valor, excedente);
  let resto = valor - doExcedente;
  const daGorjetaDevida = Math.min(resto, devido);
  resto -= daGorjetaDevida;
  if (resto === 0) return { amountCents: doExcedente, tipCents: daGorjetaDevida };
  const consumoQueSobra = consumo - doExcedente;
  const gorjetaQueSobra = gorjeta - daGorjetaDevida;
  if (consumoPrimeiro) {
    const doConsumo = Math.min(resto, consumoQueSobra);
    return { amountCents: doExcedente + doConsumo, tipCents: daGorjetaDevida + (resto - doConsumo) };
  }
  const p = allocateProportional(consumoQueSobra, gorjetaQueSobra, resto);
  return { amountCents: doExcedente + p.amountCents, tipCents: daGorjetaDevida + p.tipCents };
}

module.exports = { alocarDevolucaoDoPagamento, servicoDevidoDoAtrasado };
