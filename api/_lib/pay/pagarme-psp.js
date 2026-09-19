'use strict';

const crypto = require('crypto');
const { allocateUnderpayment } = require('../checks/split-engine');

/**
 * Pagar.me (Stone) — o PSP real do Racha. Implementa o MESMO contrato do
 * MockPsp (create-charge/webhook-handler não sabem qual PSP está atrás):
 *
 *   createPixCharge({ chargeRef, amountCents, tipCents, recipientId, description })
 *     → { txid, copiaECola, expiresAt }
 *   createWalletCharge({ chargeRef, amountCents, tipCents, recipientId, wallet, paymentToken })
 *     → { txid }
 *   verifyAndParseWebhook(rawBody, signatureOrHeaders)
 *     → Promise<{ kind, txid, amountCents, tipCents, method, raw }>
 *
 * Decisões de segurança:
 * - O webhook do Pagar.me v5 NÃO tem assinatura HMAC. Nunca confiamos no
 *   corpo: extraímos o charge id e RE-BUSCAMOS a cobrança na API com a
 *   secret key — a API é a verdade, o webhook é só um sino. Opcionalmente
 *   validamos o Basic Auth configurado no endpoint (PAGARME_WEBHOOK_AUTH).
 * - Split SEMPRE presente com o recebedor do restaurante (rp_...) — dinheiro
 *   nunca para na conta da plataforma (BACEN Res. 494). O restaurante é o
 *   merchant of record do seu recebedor.
 * - Gorjeta viaja na MESMA cobrança (total = consumo + serviço) e fica
 *   separada via metadata.tip_cents — o ledger lê de lá (Lei 13.419).
 *
 * Campos batem com docs.pagar.me core/v5 (orders); a ativação em test mode
 * valida na prática (checklist em docs/psp/README.md).
 */

const BASE_URL = 'https://api.pagar.me/core/v5';

/**
 * Falha de verificação de webhook. `name` explícito porque a camada HTTP mapeia
 * por nome pra 401 (uma subclasse de Error sozinha viraria 'Error' → 500).
 *
 * `code` explícito porque sem ele a MENSAGEM viajava.
 *
 * O `errorBody` suprime a mensagem interna só quando existe `code`, e esta
 * classe não punha nenhum — então um POST não autenticado em
 * `/api/webhooks/*` respondia com o texto da própria Stripe: "No signatures
 * found matching the expected signature for payload" contra "Timestamp outside
 * the tolerance zone" contra "Unable to extract timestamp and signatures from
 * header". Isso é um ORÁCULO DE ASSINATURA — diz a quem está tentando o que
 * ajustar na próxima. A correção de 2026-09-07 achava ter fechado isso; o teste
 * dela fabricava um `code` que nenhum caminho de produção produzia, então
 * provava o redator e não o buraco. Achado pela revisão de segurança de
 * 2026-09-08.
 */
class WebhookVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = 'webhook_invalid';
  }
}

/**
 * Os status em que O DINHEIRO CHEGOU.
 *
 * `paid` é o caso normal. `overpaid` e `underpaid` também são dinheiro na conta
 * do restaurante — o cliente pagou a mais ou a menos, e no Pix isso acontece
 * porque quem digita o valor é ele.
 *
 * Tratar os dois como "não pago" era o CRÍTICO da revisão de compliance de
 * 2026-09-08, e no trilho que carrega praticamente todo o volume brasileiro:
 * `overpaid` estava na lista de estados TERMINAIS ("esta cobrança nunca vai ser
 * paga") e `underpaid` não estava em lista nenhuma. Nos dois casos o dinheiro
 * estava no saldo da casa, o razão dizia que nada aconteceu, a conta continuava
 * aberta e a mesa era cobrada DE NOVO — com a conciliação verde, porque as duas
 * contagens concordavam que nada tinha acontecido.
 *
 * CDC art. 42 caput (cobrar dívida já quitada) e § único (repetição em dobro)
 * quando a pessoa paga a segunda vez. E o serviço dentro daquele pagamento
 * nunca chegava na folha (Lei 13.419).
 */
const PAID_STATUSES = new Set(['paid', 'overpaid', 'underpaid']);

/**
 * Uma cobrança da API vira o shape que o razão entende.
 *
 * O valor é o REALMENTE RECEBIDO (`paid_amount`), não o pedido: num
 * `underpaid` chegou menos, num `overpaid` chegou mais, e gravar o pedido
 * seria gravar uma ficção. Quando a API não manda `paid_amount` (cobrança
 * `paid` exata), o pedido É o recebido.
 *
 * A repartição entre consumo e gorjeta é PROPORCIONAL ao que foi pedido —
 * mesma decisão do estorno parcial, e pelo mesmo motivo: escolher quem recebe
 * primeiro é decidir sobre o salário de alguém.
 */
/**
 * Quanto dinheiro ENTROU nesta cobrança.
 *
 * Uma função só, porque a alternativa custou caro: eu ensinei o `parseCharge` a
 * ler `paid_amount` e deixei o ramo do ESTORNO lendo `charge.amount`, o valor
 * PEDIDO. Num Pix `underpaid` — a conta pedia 36,98, o cliente digitou 33,00 —
 * o estorno chegava dizendo que 36,98 tinham voltado, o razão recusava por
 * exceder o que foi pago, a rota devolvia 409, e a Pagar.me reenviava até
 * desabilitar o endpoint (o que derruba TODA confirmação de Pix, não só esta).
 * Enquanto isso os 33,00 tinham saído da conta da casa e os nossos dois
 * registros continuavam dizendo "pago". Achado pela revisão de compliance de
 * 2026-09-08.
 */
function receivedCents(charge) {
  const pedido = Number(charge.amount) || 0;
  /**
   * AUSENTE cai no pedido; ZERO é zero.
   *
   * O teste era `pago > 0`, então um `paid_amount: 0` num status de dinheiro
   * recebido voltava pro valor PEDIDO — inventando dinheiro que a API disse
   * não ter chegado. Ausência é versão de API mais velha; zero é uma
   * afirmação. Achado pela revisão de segurança de 2026-09-08.
   */
  if (charge.paid_amount === undefined || charge.paid_amount === null) return pedido;
  const pago = Number(charge.paid_amount);
  if (!Number.isFinite(pago) || pago < 0) return pedido;
  return pago;
}

function parseCharge(charge, eventId = null) {
  const pedidoTotal = Number(charge.amount) || 0;
  const tipPedido = Number((charge.metadata && charge.metadata.tip_cents) || 0) || 0;
  const consumoPedido = Math.max(0, pedidoTotal - tipPedido);
  const recebido = receivedCents(charge);
  assertCents(pedidoTotal, 'charge.amount');
  assertCents(recebido, 'charge.paid_amount');
  assertCents(tipPedido, 'metadata.tip_cents');
  // Pagou menos: o SERVIÇO é o resíduo (ver `allocateUnderpayment` — quem
  // digita menos está recusando a linha opcional, não devendo comida).
  const partes = recebido === pedidoTotal
    ? { amountCents: consumoPedido, tipCents: tipPedido }
    : allocateUnderpayment(consumoPedido, tipPedido, Math.min(recebido, pedidoTotal));
  // Pagou MAIS do que a conta pedia: o excedente vai pro consumo, e o redutor
  // marca `overpaidCents` na conta. A gorjeta não infla sozinha.
  const excedente = Math.max(0, recebido - pedidoTotal);
  // As partes SOMAM o recebido, sempre (inegociável #5). O rateio garante isso
  // por construção, mas a garantia tem que ser afirmada aqui: uma
  // `metadata.tip_cents` corrompida (maior que a cobrança) sairia calada.
  if (partes.amountCents + excedente + partes.tipCents !== recebido) {
    throw new Error(`parseCharge: partes não somam o recebido (${partes.amountCents}+${excedente}+${partes.tipCents} ≠ ${recebido})`);
  }
  return {
    txid: charge.id,
    /**
     * O `code` DO PEDIDO — e nele vai o id da conta.
     *
     * `baseOrder` manda `code: chargeRef`, e `chargeRef` começa com o
     * `checkId`. Quer dizer que uma cobrança que capturou e cuja linha de
     * `payments` não existe AINDA É RASTREÁVEL: o dinheiro sabe de que conta
     * veio, mesmo quando o nosso lado não sabe. Sem carregar isto pra frente, um
     * órfão viraria um txid solto e um valor, e alguém teria que abrir o painel
     * do adquirente pra descobrir a mesa.
     */
    orderCode: (charge.order && charge.order.code) || null,
    /**
     * O TIPO DO EVENTO, que ninguém preenchia.
     *
     * `money_without_check` grava `event_type` a partir daqui, e ele saía SEMPRE
     * nulo — então o operador não distinguia um `charge.paid` de um
     * `charge.overpaid` sem abrir o painel do adquirente, que é justamente o
     * passo que o registro existe pra poupar. Achado pela quarta revisão de
     * segurança de 2026-09-16 (LOW-1).
     */
    type: charge.status ? `charge.${charge.status}` : null,
    // O id do evento vem de FORA: a conciliação lê a cobrança pela API e não
    // tem evento nenhum (null, e o índice parcial da 0018 ignora nulos), o
    // webhook tem. O campo existe nos dois pra ninguém esquecer de passá-lo.
    eventId,
    status: charge.status,
    paid: PAID_STATUSES.has(charge.status),
    kind: 'payment_confirmed',
    amountCents: partes.amountCents + excedente,
    tipCents: partes.tipCents,
    // QUANTO deste pagamento era excedente. Vai pro razão porque a devolução
    // precisa saber de qual pagamento o excedente veio: numa conta rachada, a
    // sobra de quem pagou a mais não pode reger o estorno de quem pagou
    // exato. Ver `alocarDevolucao`.
    excessCents: excedente,
    method: charge.payment_method === 'pix' ? 'pix' : 'card',
    raw: charge,
  };
}

/**
 * O DESCRITOR DA FATURA — o nome que aparece no app do banco de quem pagou.
 *
 * Era `'RACHA'` cravado: a pessoa jantava no Bar do Zé, pagava com Google Pay, e
 * a fatura dizia RACHA. Identificação errada do fornecedor (CDC art. 6º III) e
 * motor de contestação "não reconheço a compra" — e o cabeçalho deste mesmo
 * arquivo afirma que "o restaurante é o merchant of record do seu recebedor".
 * O princípio já estava escrito no adaptador da Stripe ("quem cobrou tem que ser
 * quem o cliente reconhece") e não tinha atravessado pra cá, que é o adquirente
 * de produção (compliance MEDIUM-1 da rodada quinze).
 *
 * A Pagar.me limita o campo a 13 caracteres e não aceita acento nem pontuação,
 * então o nome é normalizado AQUI e não pelo chamador — um descritor recusado
 * derruba a cobrança inteira. Sem nome, e só sem nome, cai no nosso.
 */
function descritorDaFatura(venueName) {
  const cru = String(venueName || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 13)
    .trim();
  return cru || 'RACHA';
}

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  }
}

function createPagarmePsp({
  secretKey,
  webhookBasicAuth = null,
  fetchImpl = fetch,
  // Escape hatch SÓ DE TESTE: contas novas têm o Split desabilitado até o
  // suporte liberar (não dá nem pra criar recebedor). Com este flag E chave
  // sk_test_, cobranças sem rp_ saem SEM split (caem no saldo da conta de
  // teste) pra bateria de aceite rodar. Com sk_live_ o flag é IGNORADO —
  // a regra de custódia (split obrigatório) é absoluta em produção.
  allowNoSplitInTest = process.env.PAGARME_ALLOW_NO_SPLIT === 'true',
} = {}) {
  if (!secretKey || !/^sk_/.test(secretKey)) {
    throw new Error('createPagarmePsp: PAGARME_SECRET_KEY (sk_...) é obrigatória');
  }
  const isTestKey = /^sk_test_/.test(secretKey);
  const noSplitOk = allowNoSplitInTest && isTestKey;
  const authHeader = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

  async function api(method, path, body, timeoutMs = 15000) {
    let res;
    try {
      res = await fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        // Um gateway pendurado nunca pode pendurar o chamador (o confirm-on-read
        // roda no /api/check público). Timeout → 502 (transitório), jamais 4xx.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (netErr) {
      const e = new Error(`pagarme ${method} ${path}: ${netErr.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : netErr.message}`);
      e.statusCode = 502;
      e.httpStatus = 0; // rede/timeout — nunca "recusa" nem "inexistente"
      throw e;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const msg = (json && (json.message || JSON.stringify(json.errors || json))) || `HTTP ${res.status}`;
      const err = new Error(`pagarme ${method} ${path}: ${msg}`);
      // 4xx do gateway em cobrança = recusa (402 pro diner), não bug nosso.
      err.statusCode = res.status >= 400 && res.status < 500 ? 402 : 502;
      err.httpStatus = res.status; // status exato — getCharge precisa separar 404 de 401/403
      throw err;
    }
    return json;
  }

  /** Corpo comum do pedido: total = consumo + gorjeta, split integral pro venue. */
  function baseOrder({ chargeRef, amountCents, tipCents, recipientId, description, payerDocument = null }) {
    // Pagar.me devolve o id do recebedor com prefixo re_ (confirmado na API,
    // 21/07); rp_ é aceito também por causa do mock e de venues legados.
    const hasRecipient = typeof recipientId === 'string' && /^r[ep]_/.test(recipientId);
    if (!hasRecipient && !noSplitOk) {
      throw new Error('pagarme: recipientId (re_...) é obrigatório — recusando cobrança de custódia da plataforma');
    }
    assertCents(amountCents, 'amountCents');
    assertCents(tipCents, 'tipCents');
    const total = amountCents + tipCents;
    if (total === 0) throw new TypeError('zero-value charge');
    return {
      code: chargeRef.slice(0, 64),
      items: [{ description: (description || 'Racha').slice(0, 64), amount: total, quantity: 1, code: 'racha' }],
      // O gateway exige documento e telefone do pagador ("The customer
      // Document/phone is required") — em cartão E em Pix: a doc lista
      // name/email/document/phones como obrigatórios pro Pix
      // (docs.pagar.me/reference/pix-2, conferido 2026-09-07). Por isso o
      // checkout pede CPF nos dois trilhos, e não é coleta a mais. O telefone
      // é placeholder da plataforma por ora — se o modo LIVE exigir o real, o
      // checkout ganha o campo (decisão anotada no runbook).
      customer: {
        name: 'Cliente Racha', type: 'individual',
        // E-mail único por cobrança: o gateway deduplica customer por e-mail
        // e reutiliza o registro antigo (sem telefone/documento) — cada
        // cobrança leva o snapshot completo.
        email: `cliente+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@racha.app`,
        ...(payerDocument ? { document: payerDocument } : {}),
        phones: { mobile_phone: { country_code: '55', area_code: '11', number: '987654321' } },
      },
      metadata: {
        charge_ref: chargeRef,
        tip_cents: String(tipCents),
        ...(hasRecipient ? {} : { split_mode: 'none_test' }), // rastreável no extrato
      },
      // 100% pro recebedor do restaurante; taxas do gateway saem dele
      // (repasse comercial é assunto do contrato, não do fluxo de fundos).
      ...(hasRecipient ? {
        split: [{
          recipient_id: recipientId,
          amount: total,
          type: 'flat',
          options: { charge_processing_fee: true, charge_remainder_fee: true, liable: true },
        }],
      } : {}),
    };
  }

  return {
    provider: 'pagarme',
    /**
     * As moedas que este adquirente atende. Declarado, não suposto.
     *
     * O portão de dinheiro compartilhado confere isto antes de chamar: sem a
     * declaração, `createWalletCharge` recebia `currency` e IGNORAVA (não
     * estava nem no destructuring), então a correção de moeda do mercado era
     * um no-op no PSP de produção — achado da revisão de compliance de
     * 2026-09-07. Uma mesa espanhola no trilho de carteira viraria uma ordem
     * Pagar.me em REAL.
     */
    currencies: Object.freeze(['brl']),

    async createPixCharge({ chargeRef, amountCents, tipCents = 0, recipientId, description = '', payerDocument = null }) {
      const order = await api('POST', '/orders', {
        ...baseOrder({ chargeRef, amountCents, tipCents, recipientId, description, payerDocument }),
        payments: [{
          payment_method: 'pix',
          pix: { expires_in: 900 }, // 15 min, igual ao mock
        }],
      });
      const charge = order.charges && order.charges[0];
      const tx = (charge && charge.last_transaction) || {};
      if (!charge || !tx.qr_code) {
        // O motivo real (ex.: Pix não habilitado na conta) mora no
        // gateway_response — sem ele o erro é inacionável.
        const gw = tx.gateway_response || {};
        const reason = (Array.isArray(gw.errors) && gw.errors.map((e) => e.message || e).join('; '))
          || gw.code || tx.status || (charge && charge.status) || 'sem detalhe';
        throw new Error(`pagarme: cobrança Pix sem qr_code (${String(reason).slice(0, 140)})`);
      }
      return {
        txid: charge.id, // ch_... — chave de idempotência do webhook
        copiaECola: tx.qr_code,
        expiresAt: tx.expires_at || new Date(Date.now() + 900 * 1000).toISOString(),
      };
    },

    async createWalletCharge({
      chargeRef, amountCents, tipCents = 0, recipientId, wallet, paymentToken,
      payerDocument = null, currency, venueName = null,
    }) {
      // Defesa em profundidade, do mesmo tipo da do adaptador da Stripe: o
      // portão compartilhado já confere `currencies`, e ainda assim quem emite
      // recusa uma moeda que não sabe emitir. O que este `if` pega é o
      // chamador NOVO que não passou pelo portão.
      // Sem padrão: um chamador que esquece a moeda tem que quebrar, não
      // herdar a única moeda que este adquirente por acaso atende.
      if (currency !== 'brl') {
        throw new TypeError(`pagarme: moeda obrigatória e este adquirente é BRL, veio ${JSON.stringify(currency)}`);
      }
      if (!['apple_pay', 'google_pay'].includes(wallet)) {
        throw new TypeError(`createWalletCharge: unknown wallet ${wallet}`);
      }
      if (typeof paymentToken !== 'string' || paymentToken.length < 8) {
        const err = new Error('cartão recusado — token de pagamento inválido');
        err.statusCode = 402;
        err.code = 'card_declined';
        throw err;
      }
      const order = await api('POST', '/orders', {
        ...baseOrder({ chargeRef, amountCents, tipCents, recipientId, description: `Racha ${wallet}`, payerDocument }),
        payments: [{
          payment_method: 'credit_card',
          credit_card: {
            installments: 1,
            // O DESCRITOR É A CASA, não nós. Ver `descritorDaFatura`.
            statement_descriptor: descritorDaFatura(venueName),
            // Token do Google Pay via gateway tokenization (docs: Google Pay™
            // guide — gatewayMerchantId = acc_...). Apple Pay: fase 2.
            card_token: paymentToken,
            // billing_address é obrigatório em cartão; o diner não digita
            // endereço na mesa — vai o do estabelecimento (é onde a compra
            // acontece de fato). Se o antifraude LIVE exigir o do titular,
            // o checkout ganha o campo (runbook).
            card: {
              billing_address: {
                line_1: 'Av. Paulista, 1000',
                zip_code: '01310100',
                city: 'São Paulo',
                state: 'SP',
                country: 'BR',
              },
            },
          },
        }],
      });
      const charge = order.charges && order.charges[0];
      if (!charge) throw new Error('pagarme: resposta sem charge — cobrança de cartão não criada');
      const status = charge.status;
      if (status === 'failed' || status === 'canceled') {
        // O motivo real do gateway vai no erro — "recusado" seco não ajuda
        // nem o diner nem o debug (acquirer_message/gateway_response).
        const tx = charge.last_transaction || {};
        const gw = tx.gateway_response || {};
        const reason = tx.acquirer_message
          || (Array.isArray(gw.errors) && gw.errors.map((e) => e.message || e).join('; '))
          || gw.code || tx.status || status;
        /**
         * CÓDIGO, e não a frase do adquirente.
         *
         * Sem `code`, o `errorBody` cai no ramo `<500` sem nada pra suprimir e
         * manda `err.message` — que carrega até 140 caracteres de
         * `acquirer_message` cru. O cliente então cai na última linha do
         * `tError` ("servidor antigo, sem código: o texto cru é melhor que
         * nada") e desenha a frase EM PORTUGUÊS pra quem escolheu inglês ou
         * espanhol, com texto de terceiro dentro.
         *
         * Isso quebra o acordo do CLAUDE.md ao pé da letra — "o servidor nunca
         * manda texto de tela; manda um `code` estável" — e estava inalcançável
         * em produção só porque o interruptor da carteira não tinha posição
         * ligado. Consertar o interruptor tornou isto alcançável junto (sétima
         * revisão de segurança, 2026-09-19, MEDIUM-5).
         *
         * O motivo do adquirente continua indo pro stderr, que é onde ele
         * serve: quem está de plantão lê, o cliente não.
         */
        process.stderr.write(`[pagarme] cartão recusado: ${String(reason).slice(0, 140)}\n`);
        const err = new Error('cartão recusado pelo emissor');
        err.statusCode = 402;
        err.code = 'card_declined';
        throw err;
      }
      return { txid: charge.id };
    },

    /**
     * Cria o recebedor do restaurante (o passo com LATÊNCIA do onboarding —
     * análise KYC do Pagar.me). Exige a conta em modo marketplace (senão o
     * gateway recusa: "verifique a configuração da funcionalidade Split").
     * Dados vêm do formulário do DONO no admin; nada é inventado aqui.
     */
    async createRecipient({ name, email, document, type = 'individual', bank }) {
      if (!name || !document || !bank) throw new TypeError('createRecipient: name, document e bank são obrigatórios');
      // O DOCUMENTO com as letras: o CNPJ alfanumérico (IN RFB 2.229/2024, desde
      // julho de 2026) tem letras nas doze primeiras posições, e `\D` as
      // apagava — o recebedor saía com um documento que não é o da casa
      // (auditoria de onboarding, C1). A aceitação do alfanumérico pelo
      // Pagar.me precisa ser confirmada numa chamada de sandbox.
      const doc = String(document).toUpperCase().replace(/[^0-9A-Z]/g, '');
      const body = {
        name: String(name).slice(0, 128),
        email: email || undefined,
        document: doc,
        type: doc.length === 14 ? 'company' : (type || 'individual'),
        default_bank_account: {
          holder_name: String(bank.holderName || name).slice(0, 30),
          holder_type: doc.length === 14 ? 'company' : 'individual',
          holder_document: doc,
          bank: String(bank.code),
          branch_number: String(bank.agencia),
          ...(bank.agenciaDv ? { branch_check_digit: String(bank.agenciaDv) } : {}),
          account_number: String(bank.conta),
          account_check_digit: String(bank.contaDv),
          type: bank.type === 'savings' ? 'savings' : 'checking',
        },
        // Repasse automático diário — o "nunca atrasaram o repasse" da Meep
        // é argumento de venda; D+1 automático é o nosso.
        transfer_settings: { transfer_enabled: true, transfer_interval: 'Daily', transfer_day: 0 },
      };
      const r = await api('POST', '/recipients', body);
      if (!r || !/^r[ep]_/.test(r.id || '')) throw new Error('pagarme: resposta sem id de recebedor (re_...) — não criado');
      return { recipientId: r.id, status: r.status || 'registration' };
    },

    /** Status atual do recebedor (análise KYC: registration → active). */
    async getRecipient(recipientId) {
      if (!/^r[ep]_/.test(recipientId || '')) return null;
      const r = await api('GET', `/recipients/${recipientId}`);
      return { recipientId: r.id, status: r.status, name: r.name };
    },

    /**
     * Os RECEBÍVEIS de uma cobrança — o razão do próprio adquirente.
     *
     * `GET /payables?charge_id=…` devolve uma linha por recebedor e por
     * parcela, com `recipient_id`, `amount`, `fee` e `type`. É a única fonte
     * que diz PARA QUEM o dinheiro daquela cobrança foi de fato — a cobrança
     * em si não reporta o split aplicado.
     *
     * Por que isso passou a importar: o split que a gente monta é `flat` pelo
     * valor PEDIDO, e desde que `overpaid` virou dinheiro recebido, o
     * capturado pode passar da soma das regras. Quem fica com a diferença é
     * decisão da Pagar.me — e se ficar com a gente é conta-bolsão, o que o
     * inegociável #4 proíbe (e a tela do cliente estaria nomeando o
     * restaurante como devedor de um valor que está com a plataforma).
     *
     * A documentação diz que `options.charge_remainder_fee` faz o recebedor da
     * regra "receber o restante dos recebíveis após uma divisão", e a gente
     * manda `true`. Mas ler a documentação não é medir: isto aqui mede, em
     * produção, a cada cobrança. Ver `reconcile-payables.js`.
     *
     * @returns {Promise<Array<{recipientId, amountCents, feeCents, type, status, chargeId}>>}
     */
    async listChargePayables(chargeId) {
      /**
       * "NÃO É COBRANÇA DO ADQUIRENTE" ≠ "AINDA NÃO LIQUIDOU".
       *
       * Isto devolvia `[]` — a mesma resposta de uma cobrança real cujo
       * recebível ainda não nasceu. A perna traduzia o `[]` em
       * `payables_absent`, `info`, "nenhum recebível AINDA", e a string que o
       * dono lê diz "yet". Pra um txid `mock*` isso é falso na direção que
       * custa: não há "ainda", porque essa cobrança nunca passou por adquirente
       * nenhum. Medido em produção em 2026-09-10: 11 dos 15 achados da primeira
       * varredura real eram esse falso benigno, e o agregado
       * (`payables_never_verified`) teve que carregar o achado sozinho.
       *
       * Devolve um marcador em vez de `[]`, e quem chama decide. Achado pela
       * revisão de compliance de 2026-09-10 (HIGH-3).
       */
      if (typeof chargeId !== 'string' || !/^ch_/.test(chargeId)) return { notFromAcquirer: true };
      const r = await api('GET', `/payables?charge_id=${encodeURIComponent(chargeId)}&size=1000`);
      const linhas = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);
      // `|| 0` era coerção silenciosa: um `amount` ausente virava zero DENTRO
      // da soma que decide `custody_leak` (inegociável #5 — centavo inteiro,
      // nunca coagido). Valor impossível vira `null`, e o módulo puro trata a
      // linha como forma inválida em vez de somar um zero inventado.
      //
      // E o `Number(v)` ainda coagia: medido, `null → 0`, `'' → 0`,
      // `false → 0`, `[] → 0`, `'1e3' → 1000`. Um `"amount": null` no JSON
      // virava um crédito VÁLIDO de 0¢, passava pelo `Number.isSafeInteger` do
      // módulo puro (não era forma inválida), entrava no bruto da casa e
      // produzia um `payable_amount_mismatch` CRÍTICO falso — "capturou 23710¢
      // e a casa recebeu 0¢" — na perna cuja única função é decidir custódia.
      // Número tem que CHEGAR número (MEDIUM-4, revisão de 2026-09-09).
      const centavos = (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
      return linhas.map((x) => ({
        recipientId: x.recipient_id || null,
        amountCents: centavos(x.amount),
        // A taxa AUSENTE não é taxa zero: zero faz o líquido parecer melhor do
        // que é, e é o líquido que decide `payable_net_negative`.
        feeCents: centavos(x.fee),
        type: x.type || null,
        status: x.status || null,
        chargeId: x.charge_id || chargeId,
      }));
    },

    /**
     * Saldo do recebedor — a PROVA do repasse do split. Um pagamento dividido
     * pinga aqui (waiting_funds → available conforme liquida). Valores em
     * centavos, direto da API. Read-only; o dono vê "quanto já caiu".
     */
    async getRecipientBalance(recipientId) {
      if (!/^r[ep]_/.test(recipientId || '')) return null;
      const r = await api('GET', `/recipients/${recipientId}/balance`);
      return {
        currency: r.currency || 'BRL',
        availableCents: Number(r.available_amount ?? 0) || 0,
        waitingCents: Number(r.waiting_funds_amount ?? 0) || 0,
        transferredCents: Number(r.transferred_amount ?? 0) || 0,
      };
    },

    /**
     * Estado atual de UMA cobrança, direto da API (a mesma verdade que o
     * webhook consulta). Usado pela reconciliação ativa: quando o webhook não
     * chega (best-effort), o servidor re-pergunta "essa cobrança foi paga?" e
     * confirma a que já está `paid`. Retorna null pra id fora do padrão ou 4xx
     * (cobrança inexistente/não-acionável); relança 5xx pra retry no próximo
     * tick — um soluço do gateway não pode virar "não pago".
     * @returns {Promise<null|{txid,status,paid,kind,amountCents,tipCents,method,raw}>}
     */
    async getCharge(chargeId) {
      if (typeof chargeId !== 'string' || !/^ch_/.test(chargeId)) return null;
      let charge;
      try {
        charge = await api('GET', `/charges/${chargeId}`, null, 4000);
      } catch (err) {
        // SÓ 404 (cobrança inexistente/estranha) vira null e é pulada. 401/403
        // (chave revogada), 422, 5xx e timeout RELANÇAM — a reconciliação
        // contabiliza como erro e o cron alerta. Engolir um 4xx de auth como
        // "desconhecida" derrubaria a rede de segurança inteira sem sinal.
        if (err.httpStatus === 404) return null;
        throw err;
      }
      if (!charge || !charge.id) return null;
      /**
       * `partial_canceled` no caminho da CONCILIAÇÃO.
       *
       * O ramo do webhook sabe lidar com isso (estorno normal quando a API diz
       * `canceled_amount`, anomalia durável quando não diz). O `getCharge` não
       * sabia, e o status não estava em `PAID_STATUSES` nem em nenhuma lista de
       * terminal — então a cobrança saía como `stillPending`, sem lançamento,
       * sem anomalia, sem órfão, e depois de 24h saía da janela pra sempre. Os
       * dois registros concordavam que nada aconteceu e o canário ficava verde
       * por cima de dinheiro que saiu da conta.
       *
       * E este caminho é o ÚNICO quando o webhook não chega — que é exatamente
       * o cenário de um `PAGARME_WEBHOOK_AUTH` com typo, já que a verificação
       * falha fechado. Achado pela revisão de compliance de 2026-09-08.
       */
      if (charge.status === 'partial_canceled') {
        const canceladoCents = Number(charge.canceled_amount);
        const recebido = receivedCents(charge);
        if (Number.isSafeInteger(canceladoCents) && canceladoCents > 0
            && canceladoCents <= recebido) {
          return {
            txid: charge.id, eventId: null, status: charge.status,
            // `paid: true` porque o dinheiro ENTROU: a conciliação tem que
            // levar isso ao razão, não contar como abandono.
            paid: true,
            kind: 'refund', cumulativeRefundedCents: canceladoCents,
            method: charge.payment_method === 'pix' ? 'pix' : 'card',
            raw: charge,
          };
        }
        return {
          txid: charge.id, eventId: null, status: charge.status, paid: false,
          kind: 'unusable_money_event', raw: charge,
        };
      }
      try {
        return parseCharge(charge);
      } catch (e) {
        // Valor impossível: dinheiro que se moveu e não dá pra medir. Mesmo
        // desfecho do webhook — evento não lançável, nunca um 500 em laço.
        process.stderr.write(`[pagarme] cobrança ${charge.id} com valor impossível: ${String(e.message).slice(0, 120)}\n`);
        return {
          txid: charge.id, eventId: null, status: charge.status, paid: false,
          kind: 'unusable_money_event', raw: charge,
        };
      }
    },

    /**
     * Webhook: valida o Basic Auth do endpoint (se configurado) e RE-BUSCA a
     * cobrança na API — o corpo do POST nunca é a fonte de verdade.
     */
    async verifyAndParseWebhook(rawBody, signatureOrHeaders) {
      // FALHA FECHADO. Sem credencial configurada, ninguém entra.
      //
      // Era `if (webhookBasicAuth) { …confere… }` — a forma exata do
      // inegociável #7, no trilho de PRODUÇÃO do Brasil. Com
      // `PAGARME_WEBHOOK_AUTH` ausente (e o router passa `null` por padrão),
      // `/api/webhooks/psp` aceitava corpo NÃO AUTENTICADO.
      //
      // O que isso permitia, junto com o ramo de reembolso que não conferia
      // status: o `/api/pay` devolve o `txid` no corpo da resposta, então o
      // cliente conhece o `ch_` da própria cobrança. Um POST sem cabeçalho
      // nenhum com `{"type":"charge.refunded","data":{"id":"ch_…"}}` fazia o
      // razão gravar um PAYMENT_REFUNDED do valor inteiro: a conta
      // "desquitava" e reabria pra quem já tinha pagado, e a conciliação do dia
      // divergia pelo ticket todo. Qualquer terceiro que descobrisse um `ch_`
      // — print compartilhado, ticket de suporte — fazia o mesmo em qualquer
      // mesa. Achado pela revisão de segurança de 2026-09-08.
      //
      // O adaptador da Stripe já falhava fechado. Este não. É a metade
      // esquecida da mesma correção.
      //
      // CONFIRMADO NO PAINEL (2026-09-08): o webhook de produção estava com
      // `authentication_type: "none"`. O buraco não era teórico — estava
      // aberto. Ver docs/runbooks/pagarme-webhook-auth.md pra ordem de
      // aplicação: a credencial entra no painel ANTES do deploy, senão a
      // confirmação de Pix cai.
      if (!webhookBasicAuth) {
        throw new WebhookVerificationError('webhook auth não configurado — recusando corpo não autenticado');
      }
      {
        const headers = (signatureOrHeaders && typeof signatureOrHeaders === 'object')
          ? signatureOrHeaders : {};
        const got = headers.authorization || headers.Authorization || '';
        const want = `Basic ${Buffer.from(webhookBasicAuth).toString('base64')}`;
        // Comparação em TEMPO CONSTANTE: `!==` sai no primeiro byte diferente,
        // e isso é medível num segredo compartilhado no caminho do dinheiro. O
        // `length` primeiro porque `timingSafeEqual` estoura em tamanhos
        // diferentes — e o tamanho aqui não é segredo (é base64 de uma
        // credencial de formato conhecido).
        const a = Buffer.from(got);
        const b = Buffer.from(want);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          throw new WebhookVerificationError('webhook basic auth mismatch');
        }
      }
      let event;
      try { event = JSON.parse(rawBody); } catch {
        throw new WebhookVerificationError('body is not JSON');
      }
      /**
       * O ID DO EVENTO, que este adaptador não carregava.
       *
       * A idempotência da migração 0018 é por `psp_event_id` único, e o índice
       * ignora nulos — então, sem isto, a defesa inteira existia só pra Stripe
       * (Espanha, desligada) e estava AUSENTE no trilho que carrega o dinheiro.
       *
       * O que ficava aberto: duas entregas simultâneas do mesmo
       * `charge.refunded` liam o mesmo estado velho, calculavam o mesmo delta e
       * gravavam as duas. Uma conta de R$ 33,90 acabava com R$ 67,80
       * estornados, `paidCents` negativo, e quem pagou aparecendo como devendo.
       * Achado pela revisão de compliance de 2026-09-08.
       */
      const eventId = typeof (event && event.id) === 'string' ? event.id : null;
      const type = event && event.type; // ex.: charge.paid, charge.refunded
      const chargeId = event && event.data && (event.data.id || (event.data.charge && event.data.charge.id));
      if (!type || typeof chargeId !== 'string' || !/^ch_/.test(chargeId)) {
        throw new WebhookVerificationError(`webhook sem charge id (type=${type})`);
      }
      // `partial_canceled` SAIU da lista: ele chegava aqui e era tratado como
      // reembolso TOTAL (ver o ramo de reembolso abaixo), então um cancelamento
      // de R$ 5 numa cobrança de R$ 200 gravava R$ 200 de estorno. O
      // `validateEvent` não pega: o estorno é igual ao valor pago, então passa.
      // A conta reabre, o cliente é chamado pra pagar de novo, e a conciliação
      // mostra R$ 195 de divergência sem explicação.
      /**
       * OS TIPOS que a Pagar.me emite pra cobrança, conferidos na
       * documentação de webhooks em 2026-09-08: `charge.paid`,
       * `charge.payment_failed`, `charge.pending` e `charge.refunded`.
       *
       * `charge.refunded` cobre estorno TOTAL e PARCIAL — a documentação não
       * separa os dois no nível do evento. Isso importa porque o runbook manda
       * o operador *cancelar pelo valor parcial* no painel do adquirente, e a
       * revisão perguntou se o evento resultante chegaria: chega por aqui, e o
       * ramo que lê `canceled_amount` é alcançável. Sem essa conferência o
       * caminho prescrito pra quitar uma dívida com o consumidor podia nunca
       * virar lançamento, em silêncio.
       *
       * `overpaid`/`underpaid` ficam na lista porque são STATUS de cobrança
       * (não tipos de evento documentados) e a API é a verdade: se um dia
       * vierem como tipo, entram; se vierem só como status num
       * `charge.paid`, o ramo de pagamento já os aceita.
       */
      if (!/^charge\.(paid|refunded|overpaid|underpaid)$/.test(type)) {
        // Evento que não move o nosso razão é IGNORADO, não recusado.
        //
        // Era `throw`, que a rota mapeia pra 401: a Pagar.me reenvia e depois
        // DESABILITA o endpoint, e aí um `charge.refunded` de verdade se perde
        // junto com todo o resto. `order.paid`, `charge.created` e
        // `charge.antifraud_*` chegam a toda hora e davam 401 cada um.
        //
        // É a mesma correção que o adaptador da Stripe já tinha recebido, na
        // metade esquecida — o outro adquirente.
        return { kind: 'ignored', type, raw: event && event.data, eventId };
      }

      // A VERDADE: estado atual da cobrança direto da API.
      const charge = await api('GET', `/charges/${chargeId}`);
      // O TETO do estorno é o que ENTROU, não o que a conta pediu. Ver
      // `receivedCents`: são números diferentes num Pix `underpaid`/`overpaid`,
      // e o razão recusa — com razão — um estorno maior que o pagamento.
      const totalCents = receivedCents(charge);
      const method = charge.payment_method === 'pix' ? 'pix' : 'card';

      if (type === 'charge.paid' || type === 'charge.overpaid' || type === 'charge.underpaid') {
        // A API é a verdade, e ela tem TRÊS status em que o dinheiro chegou.
        // `underpaid` é o cliente digitando menos no app do banco; `overpaid`,
        // mais. Nos dois o dinheiro está na conta da casa.
        if (!PAID_STATUSES.has(charge.status)) {
          throw new WebhookVerificationError(`webhook diz ${type} mas API diz ${charge.status}`);
        }
        try {
          return parseCharge(charge, eventId);
        } catch (e) {
          /**
           * Valor que não é centavo inteiro, ou partes que não somam.
           *
           * É dinheiro que se moveu e a gente não consegue MEDIR — que é a
           * definição de `unusable_money_event`: anomalia durável e alerta. Sem
           * isto virava `TypeError` → 500 → a Pagar.me reenvia em laço e acaba
           * desabilitando o endpoint, o que derruba toda confirmação de Pix
           * por causa de uma cobrança. Achado pela revisão de segurança de
           * 2026-09-08.
           */
          process.stderr.write(`[pagarme] cobrança ${charge.id} com valor impossível: ${String(e.message).slice(0, 120)}\n`);
          return {
            kind: 'unusable_money_event', type, txid: charge.id,
            status: charge.status, raw: charge, eventId,
          };
        }
      }
      // REEMBOLSO, e o status da API manda — igual ao ramo de `paid` acima.
      //
      // Este ramo não conferia NADA: devolvia estorno total pra qualquer
      // cobrança, inclusive uma que a API reporta como `paid`. Era a segunda
      // metade do buraco de autenticação: com o corpo não autenticado aceito,
      // um `charge.refunded` forjado desquitava uma conta paga de verdade.
      const REEMBOLSADO = new Set(['canceled', 'refunded']);
      if (REEMBOLSADO.has(charge.status)) {
        // ACUMULADO, como na Stripe: estorno total devolve tudo, então o
        // acumulado é o valor da cobrança. Quem calcula o delta e rateia entre
        // consumo e gorjeta é o razão — um só lugar pros dois adquirentes.
        return {
          kind: 'refund', txid: charge.id, eventId,
          cumulativeRefundedCents: totalCents,
          method, raw: charge,
        };
      }
      if (charge.status === 'partial_canceled') {
        // Cancelamento PARCIAL: se a API disser QUANTO, é um estorno normal.
        //
        // `canceled_amount` fica na COBRANÇA (não em `last_transaction`), e o
        // `DELETE /charges/{id}` aceita um `amount` parcial — conferido na
        // documentação do cancelamento em 2026-09-08, porque eu tinha afirmado
        // isso antes sem fonte e o resumo do schema do GET não lista o campo.
        //
        // Com ele, isto deixa de ser "saiu dinheiro e não sabemos quanto" e
        // passa a ser o mesmo acumulado dos outros — o razão calcula o delta e
        // rateia. Sem ele, segue evento de dinheiro NÃO LANÇÁVEL: anomalia
        // durável e alerta, nunca um 200 calado.
        const canceladoCents = Number(charge.canceled_amount);
        if (Number.isSafeInteger(canceladoCents) && canceladoCents > 0
            && canceladoCents <= totalCents) {
          return {
            kind: 'refund', txid: charge.id, eventId,
            cumulativeRefundedCents: canceladoCents,
            method, raw: charge,
          };
        }
        return { kind: 'unusable_money_event', type, txid: charge.id, status: charge.status, raw: charge, eventId };
      }
      // O corpo diz reembolso e a API diz outra coisa: contradição, alto.
      throw new WebhookVerificationError(`webhook diz ${type} mas API diz ${charge.status}`);
    },
  };
}

module.exports = { createPagarmePsp, WebhookVerificationError };
