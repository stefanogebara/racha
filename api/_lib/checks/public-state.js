'use strict';

/**
 * O estado da conta como o TELEFONE DA MESA pode vê-lo.
 *
 * `/api/check` é público: quem tem o QR da mesa lê, sem login. O token viaja em
 * link compartilhado e em foto de QR, e não gira sozinho. E a rota devolvia o
 * estado reduzido INTEIRO — o mesmo objeto que a casa vê.
 *
 * O que passou a viajar nele nesta série de mudanças:
 *
 *  - `disputeStatus`, `disputeDueBy`, `disputedAmountCents` por pagamento:
 *    conta pra qualquer cliente da mesa que a casa está brigando um chargeback
 *    e até quando ela tem pra apresentar prova;
 *  - o texto das anomalias, que inclui o MOTIVO da disputa vindo do esquema
 *    ("fraudulent") e o prazo;
 *  - e a `note` de `PAYMENT_ISSUE_RESOLVED`: 200 caracteres de texto livre que
 *    o dono escreve pra limpar uma pendência. O caso realista é ele registrar
 *    "reembolsei o Pedro no Pix 11 98765-4321" — dado pessoal de um terceiro,
 *    servido a todo mundo que sentar naquela mesa depois.
 *
 * LGPD art. 6º III (necessidade) e GDPR art. 5(1)(c): o telefone da mesa
 * precisa saber quanto falta pagar. Não precisa de nada disso.
 *
 * A projeção é uma LISTA BRANCA: campo novo no redutor não vaza sozinho, tem
 * que ser acrescentado aqui de propósito. Achado pela revisão de segurança de
 * 2026-09-08.
 */

/**
 * @param {object} state estado reduzido (check-state.js)
 * @returns {object} o subconjunto público
 */
function publicCheckState(state) {
  if (!state || typeof state !== 'object') return state;
  const pagamentos = state.payments && typeof state.payments === 'object' ? state.payments : {};
  return {
    status: state.status,
    totalCents: state.totalCents,
    paidCents: state.paidCents,
    tipCents: state.tipCents,
    overpaidCents: state.overpaidCents,
    /**
     * Os pagamentos, sem a família da disputa e SEM O ID DO ADQUIRENTE.
     *
     * O valor, a gorjeta, o que já voltou. É o que uma tela de "quem já pagou"
     * precisa — e `payerLabel` não vem daqui, ele nunca esteve no razão.
     *
     * A chave é um ordinal da própria conta (`p1`, `p2`), não o `ch_…`/`pi_…`.
     * Conhecer o id de uma cobrança foi o que habilitou o caminho de estorno
     * forjado que fechamos hoje de manhã (o corpo do webhook não é a verdade;
     * a API é). Com a autenticação do webhook fechando por padrão o caminho
     * morreu, mas um token de mesa que viaja em link compartilhado e em foto
     * de QR não é lugar pra identificador interno de adquirente. LGPD art. 6º,
     * III: a mesa precisa saber QUANTO foi pago, não com que id.
     *
     * Ordinal pela ordem do razão: estável entre leituras, e não diz nada.
     */
    payments: Object.fromEntries(Object.entries(pagamentos).map(([, p], i) => [`p${i + 1}`, {
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      refundedAmountCents: p.refundedAmountCents,
      refundedTipCents: p.refundedTipCents,
      late: p.late === true,
    }])),
    /**
     * A CONTAGEM, não o texto.
     *
     * A tela do cliente só precisa saber que há algo em aberto naquela conta —
     * e hoje nem isso ela usa. O texto é operacional, e é onde mora o dado
     * pessoal.
     */
    anomalies: Array.isArray(state.anomalies) ? state.anomalies.length : 0,
    notices: dinerNotices(state),
  };
}

/**
 * O que a MESA precisa saber sobre o próprio dinheiro — em código estável.
 *
 * Tirar o texto operacional do payload público fechou um vazamento (a nota de
 * texto livre do dono, o motivo da disputa vindo do esquema, o prazo de
 * prova). Mas duas dessas situações são, sim, do cliente que pagou, e ficar em
 * silêncio sobre elas é o outro lado do problema — CDC art. 6º, III:
 *
 *  - `refund_reversed`: o estorno FALHOU. O dinheiro voltou pro restaurante e
 *    quem pagou continua a receber, por outro caminho. Sem isto o cliente vê
 *    o valor estornado voltar pra zero e nada explica.
 *  - `overpaid_pending_restitution`: entrou mais dinheiro do que a conta
 *    pedia. Quem recebeu o indevido tem que restituir (CC art. 876), e a
 *    obrigação não espera o cliente perceber.
 *
 * CÓDIGO e CENTAVOS, nunca frase pronta: quem traduz e formata é o cliente,
 * que sabe o idioma do leitor (acordo de trabalho do CLAUDE.md). E nada da
 * postura da casa entra aqui — status de disputa, prazo, motivo e nota do dono
 * ficam do lado do painel.
 */
function dinerNotices(state) {
  const avisos = [];
  if (state.overpaidCents > 0) {
    avisos.push({ code: 'overpaid_pending_restitution', amountCents: state.overpaidCents });
  }
  for (const a of Array.isArray(state.anomalies) ? state.anomalies : []) {
    if (a && a.type === 'PAYMENT_REFUND_REVERSED') {
      // O valor é o do ESTORNO QUE FALHOU, que a anomalia carrega. Derivar do
      // saldo não-estornado do pagamento dava outro número — o do pagamento
      // inteiro num estorno parcial — e mandava a pessoa cobrar o dobro no
      // caixa. Sem o valor (anomalia antiga), o aviso não sai: dizer "você tem
      // algo a receber, não sei quanto" não ajuda ninguém, e a marca continua
      // no painel da casa.
      if (Number.isSafeInteger(a.amountCents) && a.amountCents > 0) {
        avisos.push({ code: 'refund_reversed', amountCents: a.amountCents });
      }
    }
  }
  return avisos;
}

module.exports = { publicCheckState };
