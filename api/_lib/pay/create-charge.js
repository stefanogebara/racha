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
    const gate = marketGate(venue.market, { rail, amountCents, tipCents });
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
      throw badRequest('venue has no settlement recipient configured');
    }

    const state = reduce(await store.loadEvents(checkId));
    if (!state) throw badRequest('check has no events');
    if (state.status === 'fechada') throw badRequest('check is closed');
    const remaining = remainingCents(state);
    if (amountCents > remaining) {
      throw badRequest(`amount exceeds remaining (${remaining} centavos)`);
    }

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
  };
}

module.exports = { createChargeService };
