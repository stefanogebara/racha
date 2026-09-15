'use strict';

const { marketGate, pspCurrency } = require('../markets');

/**
 * Create a Pix charge for a share of a check — the money-out gate.
 *
 * Rules enforced HERE (not in the UI, which is advisory):
 * - the venue must have a psp_recipient_id (no platform-custody charges);
 * - consumption amount cannot exceed remaining-to-pay AT CHARGE TIME
 *   (overpay window shrinks to webhook-race size; the reducer flags any
 *   residual overpay rather than losing it);
 * - tips ride the same charge but are tracked separately end-to-end
 *   (Lei 13.419: they are employee remuneration, not revenue);
 * - serviço percentage comes from the VENUE config, never a default.
 */

const { reduce, remainingCents } = require('../checks/check-state');

/**
 * `code` opcional porque o servidor NÃO manda texto de tela (CLAUDE.md): quem
 * traduz é o cliente, que sabe o idioma do leitor. A mensagem continua indo,
 * como reserva pra um cliente mais velho que não conheça o código.
 */
function badRequest(msg, code, vars) {
  const err = new Error(msg);
  err.statusCode = 400;
  if (code) err.code = code;
  // Os `vars` do limite de esquema (mín./máx. em centavos) viajam com o erro:
  // quem formata "5.000,00 €" é o cliente, que sabe a moeda e o idioma.
  if (vars) err.vars = vars;
  return err;
}

/**
 * O TETO DE COBRANÇAS VIVAS POR CONTA — e esta é a TERCEIRA forma dele.
 *
 * O PROBLEMA. O teto de VALOR existe (`amount_over`) e não limita a CONTAGEM:
 * o `remainingCents` é `totalCents - paidCents`, `paidCents` conta evento
 * CONFIRMADO, e o `registerCharge` grava linha pendente sem lançar evento —
 * então N cobranças pendentes podem ser cada uma pelo valor INTEIRO que falta.
 * E o `chargeRef`, apesar de determinístico, não é idempotência no adquirente:
 * quem deriva o `txid` dele é só o MockPsp (por isso o corpo de testes era
 * cego); a Pagar.me o recebe como referência de comerciante. Um token de mesa
 * — que viaja em QR fotografado — emitia BR Codes sem limite.
 *
 * AS DUAS FORMAS ANTERIORES, ambas medidas ao contrário pela revisão de
 * segurança de 2026-09-15, e é por isso que esta mora no BANCO:
 *
 *  · contar pendentes e comparar. Não atômico — a janela entre ler e gravar é
 *    uma ida inteira ao PSP: trezentos pedidos simultâneos, trezentas
 *    cobranças, zero recusas. E sessenta cobranças de um centavo trancavam a
 *    mesa inteira;
 *  · um balde por ORIGEM na memória da função, mais uma reserva "em voo"
 *    local. O balde vivia por instância (três instâncias e um IP trancavam a
 *    mesa), tinha janela de dez minutos contra quinze de vida da cobrança
 *    (uma origem atravessava três janelas), contava pedido INVÁLIDO (noventa
 *    corpos lixo do wi-fi do salão trancavam a mesa com zero cobrança criada)
 *    — e a reserva não era atômica nem dentro da instância.
 *
 * ESTA: `store.claimSlots`, que no Postgres é a RPC `claim_slots` (0033) —
 * contar e reservar numa instrução só, sob trava consultiva, com janela
 * DESLIZANTE, no único lugar que todas as instâncias compartilham. É chamada
 * DEPOIS de toda a validação e logo antes do PSP, então pedido inválido não
 * ocupa vaga. A vaga fica quando um código PAGÁVEL chega ao cliente, e volta em
 * todos os outros casos — inclusive o PSP que estourou depois de aceitar o
 * pedido (o timeout de 15 s da Pagar.me) e o registro que estourou depois do
 * PSP: em nenhum deles alguém segura um código que dá pra pagar. Isto é, a
 * vaga mede códigos pagáveis nas mãos de alguém, que é o que o teto limita.
 *
 * É um teto de RITMO DE CRIAÇÃO, não de cobranças "vivas": conta as criadas nos
 * últimos quinze minutos, inclusive as já pagas, e os intents da Stripe que
 * vivem mais que isso saem da conta aos quinze. (Revisão de compliance, LOW-2.)
 *
 * O NÚMERO. Uma mesa legítima gasta no máximo vinte pessoas (o passo a passo
 * da divisão para em vinte) vezes três tentativas: sessenta cobranças criadas
 * em quinze minutos. Duzentos deixa mais que o triplo de folga — toque duplo,
 * troca de trilho, tirar o serviço — e continua sendo um teto que importa.
 *
 * O QUE CONTINUA ABERTO, dito de frente:
 *
 *  · numa rota de token portador, qualquer recurso por conta é esgotável por
 *    quem tem o token — e com a janela deslizante, por TEMPO INDETERMINADO: um
 *    script que repõe cada vaga ao vencer (a de um centavo basta) tranca a mesa
 *    enquanto rodar. A primeira versão desta prosa, a da tela e a do censo de
 *    saída diziam "até quinze minutos", e as duas revisões de 2026-09-15
 *    mediram que era falso. O que existe contra isso: a chave leva a GERAÇÃO
 *    do QR (`geracaoDoQr`), então girar o QR da mesa corta o token do atacante
 *    E começa um balde novo na hora; e o primeiro 429 de cada conta PAGINA o
 *    operador, uma vez por janela (`avisarTetoDisparado` no router). A tela não
 *    promete prazo: diz pra tentar mais tarde ou fechar no caixa, que sempre
 *    funciona. Separar o atacante da mesa por ORIGEM exigiria guardar uma chave
 *    de rede no banco, e ela não funcionaria onde importa: no wi-fi do salão o
 *    atacante e a mesa são o mesmo NAT, e no NAT das operadoras móveis um IP
 *    novo sai no modo avião (revisão de compliance);
 *  · não é idempotência: pedidos idênticos criam cobranças distintas até o
 *    teto. Fundir pela FORMA (mesmo valor, mesma gorjeta) seria pior: numa
 *    divisão igual duas pessoas pedem o mesmo valor ao mesmo tempo, e o mesmo
 *    BR Code pras duas faria a segunda ser recusada pelo banco depois de a
 *    nossa tela dizer que deu certo. Idempotência de verdade precisa de chave
 *    vinda do cliente.
 */
const JANELA_VIVA_MS = 15 * 60 * 1000;
/** O máximo de pessoas que o passo a passo da divisão permite. Ver o teste. */
const MAX_PESSOAS_NA_DIVISAO = 20;
const TENTATIVAS_POR_PESSOA = 3;
const TETO_PENDENTES = 200;

/**
 * Reivindica uma vaga pra uma cobrança nova desta conta e devolve a função que
 * a DEVOLVE — o chamador a chama se nenhum código pagável chegou ao cliente.
 *
 * Mora aqui e é EXPORTADA porque há dois sítios que criam cobrança de conta: o
 * `createCharge` e a rota `/api/pay/stripe-intent`, que monta a cobrança
 * sozinha. Um teste estrutural exige que toda criação de cobrança seja
 * precedida por esta — a forma "chamador esquecido" já custou a validação do
 * `payerLabel` e o portão de mercado dessa mesma rota.
 */
async function assertChargeSlot(store, checkId, qrGeneration = null) {
  // Por conta E pela geração do QR — ver `geracaoDoQr`.
  const chave = qrGeneration ? `check:${checkId}:${qrGeneration}` : `check:${checkId}`;
  const r = await store.claimSlots({
    keys: [chave], limits: [TETO_PENDENTES], windowMs: JANELA_VIVA_MS,
  });
  if (r.claimId === null) {
    // UM GUARDA QUE NINGUÉM VÊ É CARACTERIZADO EM PRODUÇÃO, por um cliente de
    // pé na mesa. Uma mesa legítima não chega a duzentas: se isto dispara, é
    // ataque, e a linha tem que existir. Id da conta e mais nada.
    process.stderr.write(`[teto] cobranças vivas check=${checkId} ocupadas=${r.counts[0]} teto=${TETO_PENDENTES}\n`);
    const err = new Error(`too many live pending charges for this check (${r.counts[0]})`);
    // 429, não 400: o pedido está bem formado e a resposta é "agora não".
    err.statusCode = 429;
    err.code = 'too_many_pending_charges';
    // Pro aviso ao operador (router, `avisarTetoDisparado`). NÃO vai pro
    // corpo: o `errorBody` só serializa `code` e `vars`.
    err.checkId = checkId;
    // Números crus — quem formata é o cliente.
    err.vars = { limit: TETO_PENDENTES, windowMinutes: JANELA_VIVA_MS / 60000 };
    throw err;
  }
  let devolvida = false;
  return async function devolver() {
    if (devolvida) return;
    devolvida = true;
    try {
      await store.releaseSlots(r.claimId);
    } catch (e) {
      // Falhar em DEVOLVER é falhar fechado: a vaga fica ocupada até a janela
      // passar. Loga e segue — o erro que importa é o do PSP, que já subiu.
      process.stderr.write(`[teto] vaga não devolvida claim=${r.claimId}: ${String(e && e.message).slice(0, 80)}\n`);
    }
  };
}

/**
 * A GERAÇÃO DO QR DA MESA — a chave que faz o giro do QR ser um remédio.
 *
 * O teto é esgotável por quem tem o token da mesa, e com a janela deslizante
 * um script que repõe cada vaga ao vencer tranca a mesa pelo tempo que quiser
 * (as duas revisões de 2026-09-15 mediram). O dono já tem o remédio certo —
 * girar o QR (`/api/tables/rotate`) corta o token do atacante —, mas a conta
 * continuava a mesma e as duzentas vagas dele continuavam ocupando o balde.
 * Com a geração na chave, o QR novo começa um balde novo NA HORA, e o atacante
 * sem o token novo não alcança ele. Hash de um token aleatório de alta
 * entropia: não volta a ser o token.
 */
function geracaoDoQr(token) {
  if (typeof token !== 'string' || !token) return null;
  return require('node:crypto').createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * O rótulo do pagador: string de até 60, ou ausente. UM sítio, chamado pelos
 * dois caminhos que cobram — a rota do intent da Stripe conferia só depois de a
 * Stripe já ter criado o intent, gastando uma vaga e deixando um PaymentIntent
 * órfão (revisão de compliance de 2026-09-15, MEDIUM-1).
 */
function payerLabelValido(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.length <= 60);
}

const WALLETS = Object.freeze(['apple_pay', 'google_pay']);

function createChargeService({ store, psp }) {
  if (!store || !psp) throw new Error('createChargeService: missing dependencies');

  /**
   * @param {object} args
   * @param {'pix'|'apple_pay'|'google_pay'} [args.wallet]  omitted → Pix.
   * @param {string} [args.paymentToken]  wallet-sheet token (required for wallets)
   */
  return async function createCharge({ checkId, amountCents, tipCents = 0, payerLabel = null, wallet = null, paymentToken = null, payerDocument = null, rail: requestedRail = 'pix', qrGeneration = null }) {
    if (typeof checkId !== 'string' || !checkId) throw badRequest('checkId required');
    // Documento do pagador. Exigido no Pix (o gateway pede `customer.document`)
    // e ausente no Bizum, onde quem autentica é o banco do pagador.
    //
    // String VAZIA conta como ausente. Antes contava como inválida, e o
    // resultado foi uma mesa espanhola respondendo "CPF inválido (11 dígitos)"
    // — em português, num campo que a tela nem mostra. Um campo opcional não
    // enviado não é um campo mal preenchido.
    if (payerDocument !== null && String(payerDocument).trim() !== '') {
      payerDocument = String(payerDocument).replace(/\D/g, '');
      if (!/^\d{11}$/.test(payerDocument)) throw badRequest('CPF inválido (11 dígitos)', 'tax_id_invalid');
    } else {
      payerDocument = null;
    }
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw badRequest('amountCents must be a non-negative integer');
    if (!Number.isSafeInteger(tipCents) || tipCents < 0) throw badRequest('tipCents must be a non-negative integer');
    if (amountCents + tipCents === 0) throw badRequest('zero-value charge');
    if (!payerLabelValido(payerLabel)) {
      throw badRequest('payerLabel must be a string of at most 60 chars');
    }
    if (wallet !== null && !WALLETS.includes(wallet)) throw badRequest(`carteira desconhecida: ${wallet}`);

    const venue = await store.getVenueForCheck(checkId);
    if (!venue) throw badRequest('unknown check');
    // O MERCADO manda, e a conferência é AQUI — no portão de dinheiro
    // compartilhado, não só na rota. A revisão de compliance apontou que
    // `/api/pay` chegava ao `createPixCharge` sem nenhuma conferência de
    // mercado, e que a única coisa impedindo um Pix em real numa mesa de
    // Madrid era um campo por acaso vazio: virar o `market` de uma venue
    // brasileira que JÁ tem recebedor era o caminho provável do piloto.
    //
    // Duas regras, as duas do mercado:
    //  1. o mercado tem que estar NO AR (falha fechado — disputa e residência
    //     de dado são pendências de parecer, não de código);
    //  2. o trilho tem que ser servido por ele (Pix não atende a Espanha);
    //  3. não se cobra serviço onde não existe linha de serviço;
    //  4. o valor tem que caber nos limites do esquema.
    //
    // As quatro moram no `marketGate`, e não soltas aqui, porque soltas elas
    // já divergiram: esta função tinha três e a rota do Stripe tinha duas
    // outras. Uma função é uma linha de esquecer; quatro regras são quatro.
    const rail = wallet ? 'card' : requestedRail;
    const gate = marketGate(venue.market, { rail, amountCents, tipCents, venue });
    if (gate) throw badRequest(`market ${venue.market}: ${gate.code}`, gate.code, gate.vars);

    // O PSP injetado atende ESTE mercado e ESTE trilho?
    //
    // Duas perguntas que ninguém fazia, e as duas viraram achados: o
    // `createWalletCharge` do Pagar.me nem tinha `currency` no destructuring,
    // então passar a moeda do mercado era um no-op no adquirente de produção;
    // e `createBizumCharge` não existe nele, então um `rail: 'bizum'` chegava
    // a um `undefined(...)` e saía como 500 `internal` em vez de um código
    // estável que a tela sabe traduzir.
    //
    // A pergunta é do PORTÃO, não do adaptador: o adaptador é a segunda linha
    // de defesa, e aqui é onde ainda dá pra responder com um código.
    const currency = pspCurrency(venue.market);
    // FALHA FECHADO: adaptador sem `currencies` declarado é configuração
    // errada, não passe livre.
    //
    // A primeira versão desta guarda era `if (Array.isArray(psp.currencies) &&
    // !psp.currencies.includes(...))` — um adaptador que esquecesse de declarar
    // passava calado. Uma guarda escrita NESTA rodada, pra fechar um achado do
    // inegociável #7, com a forma do inegociável #7 dentro. A revisão pegou.
    //
    // Vale reparar na assimetria que tornava isso fácil de não ver: a guarda
    // irmã logo abaixo (`typeof psp[creator] !== 'function'`) já falhava
    // fechada. Duas linhas vizinhas, dois comportamentos opostos.
    if (!Array.isArray(psp.currencies) || !psp.currencies.includes(currency)) {
      throw badRequest(`psp ${psp.provider || '?'} não emite em ${currency}`, 'psp_market_mismatch');
    }
    const creator = wallet ? 'createWalletCharge' : rail === 'bizum' ? 'createBizumCharge' : 'createPixCharge';
    if (typeof psp[creator] !== 'function') {
      throw badRequest(`psp ${psp.provider || '?'} não serve o trilho ${rail}`, 'rail_unsupported');
    }
    if (!venue.pspRecipientId) {
      // Compliance gate: without a settlement recipient the funds would land
      // on the platform account (BACEN Res. 494 custody territory).
      // COM código: sem ele o `errorBody` deixa a frase interna viajar, e ela
      // descreve o cadastro da casa pra qualquer um com o QR da mesa. O
      // `http-error.js` cita esta frase como o exemplo do que não pode sair —
      // e era a própria que saía. Achado da revisão de compliance de 2026-09-10.
      throw badRequest('venue has no settlement recipient configured', 'venue_no_recipient');
    }

    // A gorjeta sem documento de empresa é recusada pelo `marketGate`, logo
    // acima (código `venue_no_tip_document`). Estava AQUI e só aqui, e por
    // isso não valia no `POST /api/pay/stripe-intent`, que monta a cobrança
    // sozinho — mesma casa, mesma gorjeta, duas respostas conforme o trilho.
    // Uma regra, um lugar: ver `api/_lib/markets.js`.

    const state = reduce(await store.loadEvents(checkId));
    if (!state) throw badRequest('check has no events', 'check_not_found');
    if (state.status === 'fechada') throw badRequest('check is closed', 'check_closed');
    const remaining = remainingCents(state);
    if (amountCents > remaining) {
      // O erro MAIS COMUM da mesa: duas pessoas tocam "pagar" ao mesmo tempo e
      // a segunda pede mais do que sobrou. O trilho de cartão já devolvia
      // `amount_over` com `leftCents`, e a tela já sabe desenhar isso ("falta
      // R$ 23,00"); este caminho — o do Pix, que é o trilho principal —
      // devolvia uma frase em inglês sem código nenhum.
      //
      // Ficou invisível porque a rota `/api/pay` tinha a checagem duplicada.
      // Ela saiu, e a diferença apareceu. Achado pela revisão de compliance.
      throw badRequest(`amount exceeds remaining (${remaining} centavos)`,
        'amount_over', { leftCents: remaining });
    }

    const devolverVaga = await assertChargeSlot(store, checkId, qrGeneration);
    let cobrancaCriada = false;
    try {
    const chargeRef = `${checkId}:${state.paidCents}:${amountCents}:${tipCents}`;
    let charge;
    if (wallet) {
      // Apple/Google Pay = tokenized CARD charge. Same money gates as Pix;
      // tips ride along exactly the same (Lei 13.419 tracking downstream).
      charge = await psp.createWalletCharge({
        chargeRef, amountCents, tipCents,
        recipientId: venue.pspRecipientId,
        wallet, paymentToken, payerDocument,
        // A moeda é do MERCADO. Este argumento faltava, e o adaptador tinha
        // 'brl' de padrão: uma mesa espanhola no trilho de cartão cobrava em
        // real. A Stripe aceita isso sem reclamar (medido) — a defesa é aqui.
        currency,
      });
    } else if (rail === 'bizum') {
      // Bizum não leva documento do pagador: quem autentica é o banco dele.
      charge = await psp.createBizumCharge({
        chargeRef, amountCents, tipCents,
        recipientId: venue.pspRecipientId,
      });
    } else {
      charge = await psp.createPixCharge({
        chargeRef, amountCents, tipCents,
        recipientId: venue.pspRecipientId,
        description: payerLabel ? `Racha ${payerLabel}` : 'Racha',
        payerDocument,
      });
    }

    await store.registerCharge({
      checkId, txid: charge.txid, amountCents, tipCents, payerLabel,
      method: rail,
    });

    // SÓ AQUI um código pagável chega a quem pediu, e só daqui a vaga fica.
    cobrancaCriada = true;
    return {
      txid: charge.txid,
      copiaECola: charge.copiaECola ?? null, // wallets have no BR Code
      expiresAt: charge.expiresAt ?? null,
      amountCents, tipCents,
      method: rail,
      wallet: wallet ?? null,
    };
    } finally {
      // A vaga volta se nenhum código pagável chegou ao cliente — ver `assertChargeSlot`.
      if (!cobrancaCriada) await devolverVaga();
    }
  };
}

module.exports = {
  createChargeService, assertChargeSlot, geracaoDoQr, payerLabelValido,
  TETO_PENDENTES, JANELA_VIVA_MS, MAX_PESSOAS_NA_DIVISAO, TENTATIVAS_POR_PESSOA,
};
