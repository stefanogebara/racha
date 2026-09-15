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
/**
 * O PRAZO DE CADA TRILHO, em dias, contados da transação original.
 *
 *  · Pix: 90 dias — Regulamento do Pix (Res. BCB nº 1/2020, alterada pela Res.
 *    BCB nº 103/2021): toda devolução tem de ser INICIADA nesse prazo.
 *  · Cartão: 180 dias, que é o limite do adquirente (Stripe). A versão
 *    anterior dizia "no cartão o trilho segue aberto por muito mais tempo" e
 *    não punha prazo NENHUM — então, passados os 180 dias, `trilhoImpossivel`
 *    era falso pra sempre e a devolução legítima não tinha como ser registrada:
 *    a marca virava `critical` eterna, o mesmo desfecho da ordem de cliques,
 *    alcançado pela passagem do tempo (segurança/compliance MEDIUM-3 de
 *    ec86b37). Um estorno RECUSADO na criação não gera objeto de estorno, logo
 *    não gera `refund.failed`, logo não havia outra saída.
 */
const PRAZO_DO_TRILHO_DIAS = { pix: 90, card: 180 };
const DIA_MS = 24 * 60 * 60 * 1000;

/** `credit_card` e `card` são o mesmo trilho. */
function trilhoDoMeio(meio) {
  if (meio === 'credit_card' || meio === 'card') return 'card';
  return meio || null;
}

function tetoDaRestituicao(estado, txid, opcoes = {}) {
  const pg = estado && estado.payments ? estado.payments[txid] : null;
  if (!pg) return null;
  const excesso = Math.min(
    Math.max(0, (pg.excessCents || 0) - (pg.refundedAmountCents || 0)),
    Math.max(0, estado.overpaidCents || 0),
  );
  // O TARDIO SÓ QUANDO O TRILHO É IMPOSSÍVEL: o estorno pelo adquirente falhou
  // e voltou, ou o prazo do trilho acabou. São as duas situações do passo 6 do
  // runbook — e sem exigi-las, um dono podia declarar a devolução de um
  // atrasado qualquer e tirar o serviço da base da folha por atestação, sem o
  // adquirente de testemunha (segurança MEDIUM-2 e compliance MEDIUM-1 de
  // 3eea5f3; Lei 13.419 e STJ Tema 1102).
  //
  // O ESTORNO QUE FALHOU sai do PAGAMENTO, não da lista de anomalias: a anomalia
  // é projeção e some quando alguém resolve a pendência — e resolver primeiro
  // trancava a devolução pra sempre (compliance HIGH-1 de ec86b37).
  const estornoFalhou = (pg.reversedOpenCents || 0) > 0;
  // O MEIO vem do RAZÃO; a linha de `payments` é só o reserva, porque ela é
  // melhor-esforço (MEDIUM-4). A DATA só existe na linha — e não saber a data
  // não é o mesmo que estar no prazo: quem decide isso é `codigoDaRecusa`.
  const meio = trilhoDoMeio(pg.method || (opcoes && opcoes.method) || null);
  // TRILHO SEM PRAZO CADASTRADO não é trilho aberto pra sempre: é trilho que
  // esta regra não sabe julgar. O `bizum` caía aí — o mercado está construído e
  // desligado, e a devolução legítima não teria como ser registrada NUNCA, que
  // é o MEDIUM-3 desta série sobrevivendo no outro mercado (compliance MEDIUM-5
  // de d7f2683). Quem responde por "não sei" é o `codigoDaRecusa`.
  const prazoDias = Object.prototype.hasOwnProperty.call(PRAZO_DO_TRILHO_DIAS, meio)
    ? PRAZO_DO_TRILHO_DIAS[meio] : null;
  const prazoConhecido = prazoDias !== null;
  /**
   * A DATA, pela MAIS ANTIGA das duas fontes.
   *
   * O razão carrega o `created_at` do evento (imutável) e a linha de `payments`
   * carrega o `confirmed_at`, que o reparo preserva com `coalesce` e por isso
   * pode ser ANTERIOR — a conciliação que confirma um pagamento tarde grava o
   * evento hoje sobre um dinheiro que entrou semana passada. Os 90 dias do Pix
   * correm da TRANSAÇÃO (Res. BCB nº 1/2020 c/c 103/2021), então a mais antiga é
   * a mais próxima da verdade — e é a que fecha o trilho mais cedo, que é o lado
   * seguro: fechar cedo custa uma devolução pelo adquirente; abrir tarde
   * autoriza atestação sem testemunha.
   */
  const candidatas = [Date.parse(pg.confirmedAt || ''), Date.parse((opcoes && opcoes.confirmedAt) || '')]
    .filter((n) => Number.isFinite(n));
  const quando = candidatas.length ? Math.min(...candidatas) : NaN;
  const dataConhecida = Number.isFinite(quando);
  const foraDoPrazo = prazoDias !== null && dataConhecida
    && (Date.now() - quando) > prazoDias * DIA_MS;
  const trilhoImpossivel = estornoFalhou || foraDoPrazo;
  // POR QUE ele é impossível entra no razão junto com a devolução: uma
  // auditoria trabalhista tem de distinguir a devolução TESTEMUNHADA pelo
  // adquirente da que o dono atestou (compliance MEDIUM-5 de ec86b37).
  // O PRAZO vencido fecha o trilho INTEIRO; o estorno que falhou vale só o que
  // ele deixou de devolver.
  const motivo = foraDoPrazo ? `${meio}_${prazoDias}d`
    : (estornoFalhou ? 'refund_reversed' : null);
  const marca = paidAfterClose(estado)
    .filter((x) => x.txid === txid)
    .reduce((soma, x) => soma + x.amountCents, 0);
  /**
   * E A TESTEMUNHA TEM TAMANHO.
   *
   * `reversedOpenCents` ganhou valor na rodada passada, mas quem o lia ainda o
   * tratava como sim/não: dez centavos de estorno que falharam autorizavam o
   * dono a declarar a marca INTEIRA como devolvida por fora — R$ 109,10 de
   * atestação em cima de dez centavos de testemunha do adquirente, com o trilho
   * do Pix aberto pro resto (compliance HIGH-2 e segurança MEDIUM-1 de
   * 41b188a). O teto agora vale o que o adquirente de fato deixou de devolver.
   */
  const tardio = foraDoPrazo ? marca
    : (estornoFalhou ? Math.min(marca, Math.max(0, pg.reversedOpenCents || 0)) : 0);
  const liquido = Math.max(0, pg.amountCents - (pg.refundedAmountCents || 0))
    + Math.max(0, (pg.tipCents || 0) - (pg.refundedTipCents || 0));
  return {
    excesso, tardio, trilhoImpossivel, motivo, dataConhecida, prazoConhecido,
    teto: Math.min(liquido, excesso + tardio),
  };
}

/**
 * A RECUSA, quando não há nada a registrar — e ela tem de dizer QUAL não-há.
 *
 * Mora aqui, pura, porque a versão anterior era uma expressão dentro da rota e
 * o teste dela era uma REGEX CONTRA O FONTE do router — o falso invariante que
 * este repositório já documenta em `br/documento.js`: um refactor que preserve
 * a string e inverta a condição passa verde (segurança LOW-3 de ec86b37).
 *
 *  · `nothing_to_restitute` — não há marca nem sobra: nada é devido.
 *  · `payment_age_unknown` — há marca, o trilho pode ter vencido, e a linha do
 *    pagamento (única fonte da data) não veio. Não sabemos, e dizer "use o
 *    adquirente" seria mandar a casa a um trilho que pode estar fechado.
 *  · `use_acquirer_refund` — há marca e o trilho está ABERTO: é por ele.
 */
function codigoDaRecusa(estado, txid, limites) {
  if (!limites || limites.teto > 0) return null;
  const temMarca = paidAfterClose(estado).some((x) => x.txid === txid);
  if (!temMarca) return 'nothing_to_restitute';
  if (!limites.dataConhecida || !limites.prazoConhecido) return 'payment_age_unknown';
  return 'use_acquirer_refund';
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

module.exports = { autorDoRegistro, tetoDaRestituicao, payloadDaResolucao, codigoDaRecusa };
