'use strict';

const crypto = require('crypto');

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
/**
 * A MARCA do pagamento pra quem o criou: sha256 do txid, doze hex.
 *
 * O telefone de quem pagou avançava pro ✓ quando o `paidCents` da MESA subia —
 * qualquer pagamento servia. Quatro amigos, quatro Pix; a Ana paga, o telefone
 * do Bruno diz "Pagamento confirmado — você pagou R$ 55", o Pix dele segue em
 * aberto, e ele vai embora (auditoria de fluxo, CRITICAL-1). Agora o telefone
 * compara ESTA marca com a da própria cobrança (`apps/web/src/pagamento-ref.ts`,
 * mesma conta) e só avança quando a dele cai.
 *
 * O id do adquirente continua fora: doze hex de um hash não levam de volta a
 * ele, e não servem pra nada além de "este é o meu".
 */
function refDoPagamento(txid) {
  return crypto.createHash('sha256').update(String(txid)).digest('hex').slice(0, 12);
}

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
    payments: Object.fromEntries(Object.entries(pagamentos).map(([txid, p], i) => [`p${i + 1}`, {
      ref: refDoPagamento(txid),
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
  /**
   * O ESTORNO QUE FALHOU sai do FATO, não da anomalia.
   *
   * Duas coisas estavam erradas, e as duas custam dinheiro à mesa:
   *
   *  · o aviso nunca se apagava. Ele vinha da lista de anomalias, e a anomalia
   *    só sai por `PAYMENT_ISSUE_RESOLVED` SEM escopo — que nenhuma tela manda
   *    (o botão do painel manda sempre com escopo). Depois de a casa devolver
   *    por fora, o razão dizia que não devia nada e o telefone de quem tem o QR
   *    seguia dizendo "ainda é devido, fale com a equipe": a mesa cobrando de
   *    novo o que já recebeu (segurança HIGH-2 de 95f72a9). O saldo revertido em
   *    aberto (`reversedOpenCents`) é o fato, e ele se abate sozinho;
   *  · os mesmos centavos saíam DUAS vezes — como sobra da conta e como estorno
   *    a receber. Desde que a sobra criada por uma reversão passou a pertencer a
   *    quem perdeu o estorno, os dois números descrevem o mesmo dinheiro por
   *    construção: R$ 120,00 anunciados sobre R$ 60,00 de dívida (CDC art. 6º
   *    III). A sobra que já tem endereço numa testemunha não é anunciada de novo.
   */
  const revertidoEmAberto = Object.values(state.payments || {})
    .reduce((soma, p) => soma + Math.max(0, p.reversedOpenCents || 0), 0);
  const sobra = Math.max(0, (state.overpaidCents || 0) - revertidoEmAberto);
  if (sobra > 0) avisos.push({ code: 'overpaid_pending_restitution', amountCents: sobra });
  if (revertidoEmAberto > 0) avisos.push({ code: 'refund_reversed', amountCents: revertidoEmAberto });
  return avisos;
}

module.exports = { publicCheckState };
