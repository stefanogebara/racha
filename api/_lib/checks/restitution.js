'use strict';

/**
 * As regras da DEVOLUÇÃO REGISTRADA pelo dono e da RESPOSTA ao
 * pago-depois-de-fechar — puras, testáveis sem HTTP. As rotas
 * `/api/checks/record-restitution` e `/api/checks/resolve-issue` só as chamam.
 *
 * Moram aqui porque a rota era o ÚNICO escritor da resposta escopada e nada a
 * testava: tirar o `scope` do payload deixava as suítes verdes e fazia o botão
 * do painel apagar a falha de um estorno (segurança LOW-1 de 57c0d2e).
 */

const { paidAfterClose } = require('./check-state');

/**
 * Quem registrou: o ID do usuário, não o e-mail. O razão é só-de-acréscimo e
 * não tem ferramenta de apagar; o id basta pra saber quem agiu (minimização,
 * LGPD art. 6º III — compliance LOW-F de 57c0d2e).
 */
function autorDoRegistro(user) {
  return user && user.id ? String(user.id) : 'dono';
}

/**
 * Quanto o dono pode registrar como devolvido FORA do trilho, neste pagamento.
 *
 * `excesso`: a sobra deste pagamento que a conta ainda deve — o teto de
 * sempre (ver o comentário longo na rota).
 *
 * `tardio`: o que o pago-depois-de-fechar marca neste pagamento. Sem ele, um
 * atrasado estornado pelo adquirente com FALHA, ou um Pix além dos 90 dias da
 * devolução, não tinha jeito verdadeiro de fechar: a rota recusava
 * (`nothing_to_restitute`) e só sobrava responder "não pagou no caixa" — falso,
 * e com o serviço na base da folha (compliance MEDIUM-A de 57c0d2e).
 *
 * `teto`: a soma, limitada ao que o pagamento tem de líquido.
 */
const NOVENTA_DIAS_MS = 90 * 24 * 60 * 60 * 1000;

function tetoDaRestituicao(estado, txid, opcoes = {}) {
  const pg = estado && estado.payments ? estado.payments[txid] : null;
  if (!pg) return null;
  const excesso = Math.min(
    Math.max(0, (pg.excessCents || 0) - (pg.refundedAmountCents || 0)),
    Math.max(0, estado.overpaidCents || 0),
  );
  // O TARDIO SÓ QUANDO O TRILHO É IMPOSSÍVEL: o estorno pelo adquirente falhou
  // e voltou (`PAYMENT_REFUND_REVERSED` ainda em aberto), ou o Pix passou dos 90
  // dias da devolução. São as duas situações do passo 6 do runbook — e sem
  // exigi-las, um dono podia declarar a devolução de um atrasado qualquer e
  // tirar o serviço da base da folha por atestação, sem o adquirente de
  // testemunha (segurança MEDIUM-2 e compliance MEDIUM-1 de 3eea5f3; Lei
  // 13.419 e STJ Tema 1102).
  const estornoFalhou = (estado.anomalies || [])
    .some((a) => a && a.type === 'PAYMENT_REFUND_REVERSED' && a.txid === txid);
  // Só o PIX tem os 90 dias: no cartão, o trilho do adquirente segue aberto por
  // muito mais tempo, e chamar de impossível o que é só demorado devolveria a
  // brecha pelo outro lado.
  const quando = Date.parse((opcoes && opcoes.confirmedAt) || '');
  const foraDoPrazoDoPix = (opcoes && opcoes.method) === 'pix'
    && Number.isFinite(quando) && (Date.now() - quando) > NOVENTA_DIAS_MS;
  const trilhoImpossivel = estornoFalhou || foraDoPrazoDoPix;
  const tardio = trilhoImpossivel
    ? paidAfterClose(estado).filter((x) => x.txid === txid).reduce((soma, x) => soma + x.amountCents, 0)
    : 0;
  const liquido = Math.max(0, pg.amountCents - (pg.refundedAmountCents || 0))
    + Math.max(0, (pg.tipCents || 0) - (pg.refundedTipCents || 0));
  return { excesso, tardio, trilhoImpossivel, teto: Math.min(liquido, excesso + tardio) };
}

/**
 * O payload do `PAYMENT_ISSUE_RESOLVED` que a rota grava.
 *
 * ESCOPADO (`scope: 'paid_after_close'`), com texto FIXO escrito aqui: o razão
 * é só-de-acréscimo, e texto livre de quem opera o caixa ficaria nele pra
 * sempre (compliance MEDIUM-3 de 41d1244). Sem escopo, é a resposta à falha de
 * um estorno — com a nota de quem chama.
 */
function payloadDaResolucao(corpo, user) {
  const c = corpo || {};
  const escopo = c.scope === 'paid_after_close' ? 'paid_after_close' : undefined;
  const note = escopo ? 'a mesa não pagou no caixa' : String(c.note || '').trim().slice(0, 200);
  return {
    txid: String(c.txid),
    note,
    by: autorDoRegistro(user),
    ...(escopo ? { scope: escopo } : {}),
  };
}

module.exports = { autorDoRegistro, tetoDaRestituicao, payloadDaResolucao };
