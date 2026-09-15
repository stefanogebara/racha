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
 * O TETO DE COBRANÇAS PENDENTES VIVAS POR CONTA — o que faltava ao portão.
 *
 * O teto de VALOR existe (`amount_over`) e não limita a CONTAGEM: o
 * `remainingCents` é `totalCents - paidCents`, `paidCents` conta evento
 * CONFIRMADO, e o `registerCharge` grava linha pendente sem lançar evento
 * nenhum. Então N cobranças pendentes podem ser cada uma pelo valor INTEIRO que
 * falta. E o `chargeRef`, apesar de determinístico, NÃO é idempotência no
 * adquirente: quem deriva o `txid` dele é o MockPsp; a Pagar.me o recebe como
 * `code`/`metadata` — referência de comerciante — sem cabeçalho de idempotência
 * e com e-mail único por chamada, de propósito. Em produção cada POST idêntico
 * cria um pedido novo e um BR Code vivo novo.
 *
 * Somando: um chamador com um token de mesa — que viaja em QR fotografado e em
 * link compartilhado — emitia BR Codes de 15 minutos sem limite, cada um pelo
 * valor cheio da conta, e a pilha ainda realimentava o
 * `/api/cron/reconcile-pending`, que faz uma chamada ao adquirente por cobrança
 * pendente. Achado pela revisão de segurança de 2026-09-15 (HIGH-4), declarado
 * naquela rodada e fechado nesta.
 *
 * A CONTA DO TETO, e a primeira versão dela era um PALPITE que se descrevia
 * como medida — o defeito que este repositório passou três rodadas removendo da
 * prosa dos outros, cometido aqui.
 *
 * Ela dizia "o pior caso legítimo é uma mesa de dez pessoas em que cada uma erra
 * uma vez: vinte". Mas o produto não afere dez: o passo a passo da divisão vai
 * até VINTE pessoas (`apps/web/src/App.tsx`, `Math.min(20, people + 1)`). Com
 * teto vinte, uma mesa cheia de vinte que divide igual consome as vinte vagas
 * só em primeira tentativa, e a primeira pessoa que precisar de um SEGUNDO
 * código — tirou o serviço, trocou de "por item" pra "igual", a tela dormiu, o
 * wi-fi do salão engoliu o pedido — leva 429 e não consegue pagar a própria
 * conta. Zero folga. Achado pela revisão de compliance de 2026-09-15 (HIGH-1),
 * que foi ler a UI que eu não tinha lido.
 *
 * Agora o número é DERIVADO, e um teste o prende ao passo a passo: se o produto
 * passar a dividir entre trinta, o teste falha e alguém decide de novo.
 *
 *   · a janela é a validade do Pix, 15 minutos — a mesma do `mock-psp` e do
 *     `expires_in: 900` do Pagar.me. Cobrança vencida não ocupa vaga, senão uma
 *     mesa que tentou algumas vezes ao longo da noite ficava trancada;
 *   · o pior caso legítimo é a mesa CHEIA que o produto permite (vinte) em que
 *     cada pessoa precisa de até três tentativas dentro da mesma janela de
 *     quinze minutos. Três, e não duas, porque a segunda tentativa costuma ser
 *     o próprio conserto (tirar o serviço) e a terceira é a margem de quem
 *     tropeçou no caminho;
 *   · sessenta continua sendo um teto que importa: sem ele o número é
 *     ilimitado, e é o tamanho da pilha que realimenta o
 *     `/api/cron/reconcile-pending`, uma chamada ao adquirente por pendente.
 *
 * Por CONTA, não por IP: um salão inteiro é um IP só atrás do NAT do
 * restaurante, e o abuso que importa é contra UMA conta — é ela que tem o
 * token, e é o recebedor daquela casa que paga a conta do tráfego.
 */
const JANELA_VIVA_MS = 15 * 60 * 1000;
/** O máximo de pessoas que o passo a passo da divisão permite. Ver o teste. */
const MAX_PESSOAS_NA_DIVISAO = 20;
const TENTATIVAS_POR_PESSOA = 3;
/**
 * DUAS CAMADAS, porque uma só foi medida ao contrário.
 *
 * A primeira versão tinha UM teto por conta, e a revisão de segurança de
 * 2026-09-15 (HIGH-1, HIGH-2) mediu o que ele fazia contra um atacante de
 * verdade: NÃO parava um script concorrente (300 pedidos simultâneos, 300
 * cobranças criadas, zero recusadas — a janela entre ler e gravar é uma ida
 * inteira ao PSP), e DAVA a um script serial uma negação de serviço: sessenta
 * cobranças de um centavo — R$ 1,83 que ninguém paga — e a mesa inteira
 * levava 429 pra pagar a própria conta. Reproduzido aqui antes de mexer. Antes
 * do teto um atacante gastava o tempo do adquirente; depois dele, podia impedir
 * a mesa de pagar. Numa rota de token portador, qualquer recurso compartilhado
 * por conta é esgotável por quem tem o token — o que se pode fazer é tornar
 * esgotá-lo CARO e limitado, não fingir que é impossível.
 *
 *  · POR ORIGEM (conta × IP), no router: o que uma mesa legítima gasta. É a
 *    derivação de sempre — vinte pessoas, três tentativas — mais metade, porque
 *    ali se contam TENTATIVAS, e os outros portões recusam algumas (o erro mais
 *    comum da mesa é `amount_over`, duas pessoas tocando "pagar" ao mesmo
 *    tempo). Uma mesa inteira atrás do wi-fi do salão é uma origem só, e cabe;
 *  · POR CONTA, aqui: o teto de ESTOQUE, alto o bastante pra que UMA origem não
 *    o encha. Numa janela viva de quinze minutos o balde de dez minutos da
 *    origem pode virar uma vez, então uma origem cria no máximo o dobro do seu
 *    teto; o da conta fica acima disso. Encher a conta passa a exigir várias
 *    origens.
 */
const TETO_POR_ORIGEM = (MAX_PESSOAS_NA_DIVISAO * TENTATIVAS_POR_PESSOA * 3) / 2;
const TETO_PENDENTES = 200;

/**
 * Há vaga pra mais uma cobrança nesta conta?
 *
 * Mora aqui e é EXPORTADA porque há dois sítios que criam cobrança de conta: o
 * `createCharge` e a rota `/api/pay/stripe-intent`, que monta a cobrança
 * sozinha. Um teste estrutural exige que toda chamada de `create*Charge` seja
 * precedida por esta — a forma "chamador esquecido" já custou a validação do
 * `payerLabel` e o portão de mercado do `/api/house/load`.
 *
 * ANTES da chamada ao PSP, sempre: o ponto do teto é não falar com o
 * adquirente. Depois seria contar o estrago.
 *
 * O QUE ESTE TETO NÃO É, dito de frente:
 *
 *  · não é ATÔMICO. Duas requisições simultâneas podem ler dezenove e passar
 *    as duas — o teto é de ESTOQUE, não invariante de dinheiro, e ultrapassar
 *    por duas ou três sob concorrência não perde centavo nenhum. O inegociável
 *    #7 exige RPC atômico pra reivindicação condicional que MOVE dinheiro;
 *    esta não move: ela recusa trabalho. Trocar por RPC custaria uma migração e
 *    um caminho novo no banco pra ganhar precisão que a contenção não precisa;
 *  · não limita o FLUXO, só o estoque. Quem esperar as vivas vencerem abre mais
 *    vinte. O que ele fecha é o tamanho da pilha — que é o que realimenta o
 *    `/api/cron/reconcile-pending`, uma chamada ao adquirente por pendente — e
 *    o número de BR Codes vivos ao mesmo tempo pela conta cheia;
 *  · não é idempotência. Pedidos idênticos continuam criando cobranças
 *    distintas até o teto, porque a Pagar.me não recebe cabeçalho de
 *    idempotência nenhum. Fundir cobranças pela FORMA (mesmo valor, mesma
 *    gorjeta) seria pior: numa divisão igual duas pessoas pedem o mesmo valor
 *    ao mesmo tempo, e devolver a mesma cobrança às duas faria as duas
 *    pensarem que pagaram enquanto só uma cobrança existe — conta subpaga com
 *    dois clientes tranquilos. Idempotência de verdade precisa de chave vinda
 *    do cliente, e é decisão de contrato, não de guarda.
 */
/**
 * Cobranças entre a conferência e o registro, NESTA instância.
 *
 * É o que faz o teto amarrar contra um script concorrente: a janela entre ler
 * a contagem e gravar a linha é uma ida inteira ao PSP (150 a 800 ms contra a
 * Pagar.me), e todo pedido que chegava nesse intervalo já tinha passado. Com a
 * reserva, a conta é "vivas no banco + em voo aqui", e ler-e-reservar é
 * síncrono — em JS nada intercala entre o `await` que devolveu a contagem e o
 * `set` —, então é atômico DENTRO da instância.
 *
 * O que continua aberto, e está dito: entre instâncias o teto vira
 * `teto × instâncias servindo aquela conta ao mesmo tempo`. Fechar isso exige
 * um RPC que conte e reserve numa instrução só no Postgres — migração nova.
 * O inegociável #7 exige RPC pra reivindicação condicional que MOVE dinheiro;
 * esta recusa trabalho, e a camada por origem já amarra o caso de uma origem só.
 */
const emVoo = new Map();

/**
 * Há vaga pra mais uma cobrança nesta conta? Se houver, RESERVA e devolve a
 * função que libera — o chamador a chama num `finally`, depois do registro.
 *
 * Mora aqui e é EXPORTADA porque há dois sítios que criam cobrança de conta: o
 * `createCharge` e a rota `/api/pay/stripe-intent`, que monta a cobrança
 * sozinha. Um teste estrutural exige que toda criação de cobrança seja
 * precedida por esta — a forma "chamador esquecido" já custou a validação do
 * `payerLabel` e o portão de mercado dessa mesma rota.
 *
 * ANTES da chamada ao PSP, sempre: o ponto do teto é não falar com o
 * adquirente. Depois seria contar o estrago.
 */
async function assertChargeSlot(store, checkId) {
  const vivas = await store.countPendingCharges({ checkId, windowMs: JANELA_VIVA_MS });
  // Síncrono daqui até o `set`. Ver `emVoo`.
  const ocupadas = vivas + (emVoo.get(checkId) || 0);
  if (ocupadas >= TETO_PENDENTES) {
    // UM GUARDA QUE NINGUÉM VÊ É CARACTERIZADO EM PRODUÇÃO, por um cliente de
    // pé na mesa. O router só loga status >= 500. Uma linha por recusa, com o
    // id da conta e mais nada — nome de pagador não entra em log.
    process.stderr.write(`[teto] cobranças vivas check=${checkId} ocupadas=${ocupadas} teto=${TETO_PENDENTES}\n`);
    const err = new Error(`too many live pending charges for this check (${ocupadas})`);
    // 429, não 400: o pedido está bem formado e a resposta é "agora não".
    err.statusCode = 429;
    err.code = 'too_many_pending_charges';
    // Números crus — quem formata é o cliente.
    err.vars = { limit: TETO_PENDENTES, windowMinutes: JANELA_VIVA_MS / 60000 };
    throw err;
  }
  emVoo.set(checkId, (emVoo.get(checkId) || 0) + 1);
  let liberada = false;
  return function liberar() {
    if (liberada) return;
    liberada = true;
    const n = (emVoo.get(checkId) || 1) - 1;
    if (n <= 0) emVoo.delete(checkId); else emVoo.set(checkId, n);
  };
}

const WALLETS = Object.freeze(['apple_pay', 'google_pay']);

function createChargeService({ store, psp }) {
  if (!store || !psp) throw new Error('createChargeService: missing dependencies');

  /**
   * @param {object} args
   * @param {'pix'|'apple_pay'|'google_pay'} [args.wallet]  omitted → Pix.
   * @param {string} [args.paymentToken]  wallet-sheet token (required for wallets)
   */
  return async function createCharge({ checkId, amountCents, tipCents = 0, payerLabel = null, wallet = null, paymentToken = null, payerDocument = null, rail: requestedRail = 'pix' }) {
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
    if (payerLabel !== null && (typeof payerLabel !== 'string' || payerLabel.length > 60)) {
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

    const liberar = await assertChargeSlot(store, checkId);
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

    return {
      txid: charge.txid,
      copiaECola: charge.copiaECola ?? null, // wallets have no BR Code
      expiresAt: charge.expiresAt ?? null,
      amountCents, tipCents,
      method: rail,
      wallet: wallet ?? null,
    };
    } finally {
      // Depois do registro, a linha já está no banco e a reserva sai; se o PSP
      // ou o registro estourarem, a vaga volta. Entre o registro e esta linha a
      // cobrança conta duas vezes — do lado de recusar, que é o lado certo.
      liberar();
    }
  };
}

module.exports = {
  createChargeService, assertChargeSlot, TETO_PENDENTES, TETO_POR_ORIGEM, JANELA_VIVA_MS,
  MAX_PESSOAS_NA_DIVISAO, TENTATIVAS_POR_PESSOA,
};
