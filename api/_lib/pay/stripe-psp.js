'use strict';

/** Limites do esquema Bizum, em centavos de euro (docs.stripe.com/payments/bizum). */
const { market } = require('../markets');

const BIZUM_MIN_CENTS = 50;
const BIZUM_MAX_CENTS = 500000;

/**
 * Stripe — o SEGUNDO rail do Racha, só pra CARTÃO / Apple Pay / Google Pay web.
 * O Pix continua no Pagar.me (na Stripe o Pix é invite-only pra empresa BR); a
 * camada de PSP roteia por método. Este adapter existe porque o Pagar.me NÃO
 * tem Apple Pay web (o token Apple Pay é criptografado e só um processador que
 * suporta decripta — Stripe/Adyen/etc. sim, Pagar.me não).
 *
 * MODELO DE FUNDOS (inegociável #4): DESTINATION CHARGE, e ela NÃO é a mesma
 * coisa que o split do Pagar.me.
 *
 * O PaymentIntent é criado NA PLATAFORMA e a Stripe transfere pra conta
 * conectada do restaurante (`transfer_data.destination = acct_...`); o Racha só
 * tira sua margem via `application_fee_amount` (0 por ora). Não há conta-bolsão
 * e a plataforma não saca — mas o dinheiro do consumidor TRANSITA pelo saldo da
 * plataforma antes da transferência, e isso é território do inegociável #4.
 *
 * Este parágrafo dizia "dinheiro nunca para na plataforma — mesma garantia do
 * split do Pagar.me". Era falso, e duzentas linhas abaixo, no mesmo arquivo, o
 * comentário do estorno já dizia o contrário ("dinheiro parado no saldo da
 * PLATAFORMA, que é território do inegociável #4"). A copy da tela do dono
 * seguiu ESTE, o errado, e prometeu "sem custódia nossa" por meses. É o
 * parágrafo que alguém lê antes de decidir se uma mudança é mudança de fluxo de
 * fundos — ou seja, antes de decidir se precisa do parecer que o inegociável #4
 * exige ANTES. Corrigido junto com a copy (compliance MEDIUM-A da rodada treze).
 *
 * ⚠️ CÓDIGO, NÃO FLUXO VIVO: nada aqui roteia dinheiro real até (a) existir uma
 * conta Stripe do Racha como plataforma Connect, (b) cada restaurante ter uma
 * conta conectada (`acct_`) via onboarding, e (c) o parecer do jurídico de
 * pagamentos (regra nº4). O deploy é gated; o adapter é a fundação testada.
 *
 * Contrato (compatível com o MockPsp/pagarme pro reconciliador/webhook-handler):
 *   createWalletCharge({ chargeRef, amountCents, tipCents, recipientId, wallet, ... })
 *     → { txid: 'pi_...', clientSecret, status }   (o front confirma com a sheet)
 *   getCharge(txid) → { txid, status, paid, amountCents, tipCents, method, kind, raw } | null
 *   verifyAndParseWebhook(rawBody, headers)
 *     → { kind, txid, amountCents, tipCents, method, raw }  (throws na assinatura ruim)
 *
 * Diferença de fluxo vs. Pagar.me (Google Pay): lá o front manda um `card_token`
 * e a cobrança fecha síncrona; aqui o backend cria o PaymentIntent e devolve o
 * `clientSecret` — o front confirma com o Apple Pay/Google Pay (Stripe Express
 * Checkout Element) e a confirmação chega por webhook `payment_intent.succeeded`.
 */

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

function assertCents(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.secretKey       sk_… (ou rk_… restrita) da plataforma Racha
 * @param {string} [opts.webhookSecret] whsec_… do endpoint (verificação de assinatura)
 * @param {object} [opts.stripeClient]  injeção pra teste; default = require('stripe')(secretKey)
 */
function createStripePsp({ secretKey, webhookSecret = null, stripeClient = null } = {}) {
  // A guarda existe pra recusar uma chave PUBLICÁVEL (`pk_`) passada como
  // secreta — não pra listar todos os prefixos que a Stripe já inventou. Ela
  // recusava `rkcs_test_…`, que é o formato de chave restrita de um sandbox
  // reivindicável (achado ligando um sandbox de verdade em 2026-09-07): o
  // adaptador virava null e o caminho de cartão "não estava configurado", sem
  // dizer por quê.
  if (!secretKey || !/^(sk|rk|rkcs)_/.test(secretKey)) {
    throw new Error('createStripePsp: STRIPE_SECRET_KEY (sk_…, rk_… ou rkcs_…) é obrigatória');
  }
  // Lazy: só carrega o SDK se não veio um client injetado (testes injetam stub).
  const stripe = stripeClient || require('stripe')(secretKey);

  /** PaymentIntent → o shape parseado comum (mesmo do pagarme.getCharge). */
  function parseIntent(pi) {
    const totalCents = Number(pi.amount) || 0;
    const tipCents = Number((pi.metadata && pi.metadata.tip_cents) || 0) || 0;
    const amountCents = Math.max(0, totalCents - tipCents);
    return {
      txid: pi.id,
      status: pi.status,
      paid: pi.status === 'succeeded',
      /**
       * Houve uma TENTATIVA de pagamento neste intent?
       *
       * `requires_payment_method` é ambíguo e é o estado que importa: é o
       * estado INICIAL de um intent recém-criado E o estado em que ele volta a
       * cair quando o pagador recusa. Medido contra a API (2026-09-08): um
       * intent novo tem `last_payment_error` ausente e nenhuma cobrança; um
       * cancelado vai pra `canceled`, que já é terminal pra gente.
       *
       * Então quem separa "ninguém tentou ainda" de "tentou e não deu" é a
       * presença de um erro de pagamento ou de uma cobrança. Sem isso a
       * conciliação conta uma recusa como "ainda esperando" até a cobrança sair
       * da janela — e aí o silêncio é o resultado, que é o que o inegociável #8
       * existe pra proibir.
       *
       * Uma recusa de verdade não é reproduzível no modo de teste (o Bizum
       * autoriza sozinho em segundos), então isto está fundamentado na FORMA da
       * API e nos dois estados que deu pra alcançar, não numa recusa observada.
       * Está escrito assim de propósito.
       */
      attempted: Boolean(pi.last_payment_error || pi.latest_charge),
      kind: 'payment_confirmed',
      amountCents,
      tipCents,
      // O trilho REAL, não 'card' fixo. O `registerCharge` gravava 'bizum'
      // honestamente e o evento de confirmação sobrescrevia com 'card' — e o
      // log de eventos é a verdade. Isso contaminava a conciliação por método,
      // o painel e qualquer conversa de taxa com o restaurante.
      method: (pi.metadata && pi.metadata.rail)
        || ((pi.payment_method_types || [])[0] === 'bizum' ? 'bizum' : 'card'), // Apple/Google Pay web são cartões tokenizados
      raw: pi,
    };
  }

  return {
    provider: 'stripe',
    /** As moedas que este adaptador atende. Ver `currencies` no Pagar.me. */
    currencies: Object.freeze(['brl', 'eur']),

    /**
     * Cria o PaymentIntent (destination charge) e devolve o clientSecret pro
     * front confirmar com a carteira. recipientId = conta conectada do
     * restaurante (acct_…) — sem ela, recusa (regra de custódia).
     */
    async createWalletCharge({
      chargeRef, amountCents, tipCents = 0, recipientId,
      // `payerDocument` é ACEITO e deliberadamente NÃO ENVIADO.
      //
      // O portão compartilhado passa o mesmo objeto pros dois adquirentes, e o
      // Pagar.me precisa do CPF (a doc do Pix exige `customer.document`) — é
      // essa necessidade que dá base legal ao campo (LGPD art. 6º III). A
      // Stripe não exige nada disso pra um intent de cartão, e o `metadata` é
      // livre e não usado pela API: mandar o CPF pra lá era um documento
      // completo guardado por prazo indefinido no painel de um processador
      // estrangeiro, sem finalidade. Falha de minimização — e pior, enfraquece
      // o próprio argumento de necessidade que sustenta o campo no Pix.
      // Achado da revisão de compliance de 2026-09-07.
      //
      // Fica no destructuring, e não removido, pra que a decisão esteja
      // ESCRITA: um parâmetro que desaparece do argumento volta no próximo
      // "por que a Stripe não recebe o CPF?".
      wallet = null, payerDocument = null, applicationFeeCents = 0, currency,
    }) {
      void payerDocument;
      if (typeof recipientId !== 'string' || !/^acct_/.test(recipientId)) {
        throw new Error('stripe: conta conectada (acct_…) obrigatória — recusando custódia da plataforma');
      }
      if (typeof chargeRef !== 'string' || chargeRef.length === 0) {
        throw new TypeError('createWalletCharge: chargeRef required');
      }
      assertCents(amountCents, 'amountCents');
      assertCents(tipCents, 'tipCents');
      if (wallet !== null && !['apple_pay', 'google_pay'].includes(wallet)) {
        throw new TypeError(`createWalletCharge: unknown wallet ${wallet}`);
      }
      const total = amountCents + tipCents;
      if (total === 0) throw new TypeError('zero-value charge');
      /**
       * A TAXA DA PLATAFORMA NÃO INCIDE SOBRE A GORJETA.
       *
       * A faixa era `[0, total)` com `total = amountCents + tipCents`, e
       * ninguém passa taxa hoje. Mas no dia em que a margem sobre volume
       * ligar, uma taxa calculada sobre essa base tira um pedaço do serviço —
       * que não é receita da casa (STJ Tema 1102), é remuneração do empregado
       * pela Lei 13.419. Margem sobre folha alheia não é um erro que se corrige
       * depois: ele já teria acontecido no primeiro pagamento.
       *
       * A base é o CONSUMO. Fixado antes da primeira taxa existir, que é o
       * único momento em que isto é uma linha de código e não uma restituição.
       * Achado pela revisão de segurança de 2026-09-08.
       */
      if (!Number.isSafeInteger(applicationFeeCents) || applicationFeeCents < 0
          || applicationFeeCents >= Math.max(1, amountCents)) {
        throw new TypeError('applicationFeeCents fora de [0, amountCents) — a taxa não incide sobre a gorjeta');
      }

      // A MOEDA vem do mercado, e NÃO TEM PADRÃO.
      //
      // Era `'brl'` fixo, e a revisão de compliance mandou parametrizar: como
      // `MARKETS.es.rails` inclui 'card', um cliente espanhol devendo 24,50 €
      // seria cobrado 2450 centavos de REAL na conta conectada espanhola. Pior
      // que o erro, a conciliação compararia centavos de real com cêntimos de
      // euro e reportaria 0,00 de divergência — o inegociável #8 derrotado em
      // silêncio.
      //
      // Mas parametrizar com `currency = 'brl'` de padrão consertou metade: os
      // DOIS chamadores continuaram sem passar nada, então o literal seguiu
      // valendo, agora escondido atrás de um comentário que dizia o contrário.
      // É a forma exata do inegociável #7 — a guarda que nunca dispara.
      //
      // Medido contra a Stripe (2026-09-07): uma cobrança de CARTÃO em `brl`
      // é **aceita sem reclamação**. Ninguém abaixo de nós pega isto. (No
      // Bizum o esquema pega: `currency: 'brl'` é recusado com "Payments with
      // bizum support the following currencies: eur".) Então esta linha é a
      // única defesa que existe no trilho de cartão, e por isso ela não pode
      // ter um padrão simpático.
      if (currency !== 'brl' && currency !== 'eur') {
        throw new TypeError(`createWalletCharge: moeda obrigatória e vinda do mercado, veio ${JSON.stringify(currency)}`);
      }
      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency,
        // Apple/Google Pay entram pelo Payment/Express Checkout Element no front.
        automatic_payment_methods: { enabled: true },
        // DESTINATION CHARGE: a cobrança nasce na PLATAFORMA e a Stripe
        // transfere pra conta conectada do restaurante. Ver o cabeçalho — não é
        // o mesmo que o split do Pagar.me, e a diferença é do inegociável #4.
        transfer_data: { destination: recipientId },
        /**
         * E O COMERCIANTE QUE APARECE NA FATURA É O RESTAURANTE.
         *
         * A regra está escrita no cabeçalho do Bizum — "quem cobrou tem que ser
         * quem o cliente reconhece" — e estava aplicada só lá. Sem
         * `on_behalf_of`, numa destination charge, quem aparece no app do banco
         * de quem pagou é a PLATAFORMA: a pessoa jantou no Bar do Zé e vê
         * "Racha" na fatura do cartão. Isso é identificação errada do fornecedor
         * (CDC art. 6º III) e é justamente o traço que caracteriza quem está no
         * fluxo, que é o que o inegociável #4 governa (BACEN Res. 494/2025).
         *
         * Princípio escrito num método e ausente no outro — a mesma família das
         * três cópias divergentes do predicado de estorno. Achado pela revisão
         * de compliance da rodada catorze, e é uma linha.
         */
        on_behalf_of: recipientId,
        ...(applicationFeeCents > 0 ? { application_fee_amount: applicationFeeCents } : {}),
        // Gorjeta viaja na MESMA cobrança e fica rastreável (Lei 13.419) — o
        // ledger lê tip_cents daqui, igual ao Pagar.me.
        metadata: {
          charge_ref: chargeRef.slice(0, 200),
          tip_cents: String(tipCents),
          // O TRILHO, explícito. Só o Bizum marcava, e o `parseIntent` caía
          // num palpite pra todo o resto: `payment_method_types[0]`. Com
          // `automatic_payment_methods` numa conta espanhola que tem
          // `bizum_payments` ativa, 'bizum' PODE aparecer nessa lista, sem
          // ordem documentada — e a confirmação sobrescreveria como Bizum uma
          // cobrança de cartão gravada certa. Contaminaria a conciliação por
          // método, o painel e a conversa de taxa.
          rail: 'card',
          ...(wallet ? { wallet } : {}),
        },
      });
      return { txid: pi.id, clientSecret: pi.client_secret, status: pi.status };
    },

    /**
     * Bizum — o trilho principal da Espanha.
     *
     * É um pagamento em tempo real entre contas: o pagador põe o telefone que
     * tem registrado no Bizum e autoriza **no app do banco dele**. Por isso
     * não há código copia-e-cola como no Pix e não há CPF: quem autentica é o
     * banco, e o documento do pagador nunca passa por aqui.
     *
     * Três decisões que valem comentário:
     *
     * - `payment_method_types: ['bizum']`, explícito, em vez de
     *   `automatic_payment_methods`. O automático ofereceria tudo que a conta
     *   tem habilitado, e o Express Checkout Element **não suporta Bizum** —
     *   então o front precisa do Payment Element e o intent precisa dizer qual
     *   é o trilho.
     * - `on_behalf_of: recipientId` junto do `transfer_data`. Numa destination
     *   charge sem isso, o comerciante que aparece no app do banco do cliente é
     *   a PLATAFORMA; com ele, é o restaurante. Quem cobrou tem que ser quem o
     *   cliente reconhece — e é também o que a Stripe documenta pro descritor.
     * - Os limites do esquema são conferidos AQUI, não só na tela. Um adaptador
     *   que confia no chamador é a guarda que nunca dispara (inegociável #7).
     */
    async createBizumCharge({
      chargeRef, amountCents, tipCents = 0, recipientId, applicationFeeCents = 0,
    }) {
      if (typeof recipientId !== 'string' || !/^acct_/.test(recipientId)) {
        throw new Error('stripe: conta conectada (acct_…) obrigatória — recusando custódia da plataforma');
      }
      if (typeof chargeRef !== 'string' || chargeRef.length === 0) {
        throw new TypeError('createBizumCharge: chargeRef required');
      }
      assertCents(amountCents, 'amountCents');
      assertCents(tipCents, 'tipCents');
      const total = amountCents + tipCents;
      if (total === 0) throw new TypeError('zero-value charge');
      // Limites do esquema Bizum: 0,50 € a 5.000 € por cobrança.
      if (total < BIZUM_MIN_CENTS) throw new TypeError(`bizum: abaixo do mínimo (${BIZUM_MIN_CENTS} centavos)`);
      if (total > BIZUM_MAX_CENTS) throw new TypeError(`bizum: acima do máximo (${BIZUM_MAX_CENTS} centavos)`);
      /**
       * A TAXA DA PLATAFORMA NÃO INCIDE SOBRE A GORJETA.
       *
       * A faixa era `[0, total)` com `total = amountCents + tipCents`, e
       * ninguém passa taxa hoje. Mas no dia em que a margem sobre volume
       * ligar, uma taxa calculada sobre essa base tira um pedaço do serviço —
       * que não é receita da casa (STJ Tema 1102), é remuneração do empregado
       * pela Lei 13.419. Margem sobre folha alheia não é um erro que se corrige
       * depois: ele já teria acontecido no primeiro pagamento.
       *
       * A base é o CONSUMO. Fixado antes da primeira taxa existir, que é o
       * único momento em que isto é uma linha de código e não uma restituição.
       * Achado pela revisão de segurança de 2026-09-08.
       */
      if (!Number.isSafeInteger(applicationFeeCents) || applicationFeeCents < 0
          || applicationFeeCents >= Math.max(1, amountCents)) {
        throw new TypeError('applicationFeeCents fora de [0, amountCents) — a taxa não incide sobre a gorjeta');
      }

      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency: 'eur',
        payment_method_types: ['bizum'],
        transfer_data: { destination: recipientId },
        on_behalf_of: recipientId,
        ...(applicationFeeCents > 0 ? { application_fee_amount: applicationFeeCents } : {}),
        metadata: {
          charge_ref: chargeRef.slice(0, 200),
          tip_cents: String(tipCents),
          rail: 'bizum',
        },
      });
      return { txid: pi.id, clientSecret: pi.client_secret, status: pi.status };
    },

    /**
     * Estado de um PaymentIntent — a verdade pra reconciliação ativa (mesmo
     * papel do pagarme.getCharge). null pra id fora do padrão / inexistente;
     * relança erro transitório pro próximo tick.
     */
    async getCharge(txid) {
      if (typeof txid !== 'string' || !/^pi_/.test(txid)) return null;
      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(txid);
      } catch (err) {
        if (err && (err.statusCode === 404 || err.code === 'resource_missing')) return null;
        throw err; // 5xx/rede: transitório
      }
      if (!pi || !pi.id) return null;
      return parseIntent(pi);
    },

    /**
     * Cria a conta CONECTADA do restaurante (Connect Express) — o análogo do
     * recebedor do Pagar.me. Onboarding (link de KYC) é passo separado no admin;
     * aqui só o esqueleto. Dados bancários/KYC vêm do restaurante, nunca daqui.
     */
    /**
     * `marketCode` decide o PAÍS e as capacidades. Era 'BR' fixo, e os
     * business locations do Bizum não incluem o Brasil — então nenhuma casa
     * espanhola podia ser cadastrada, e a capacidade `bizum_payments` (que
     * precisa estar ativa na plataforma E na conta conectada) nunca era nem
     * pedida. Achado da revisão de compliance.
     */
    async createConnectedAccount({ email = null, businessName = null, cnpj = null, marketCode = 'br' } = {}) {
      const m = market(marketCode);
      const country = m.code === 'es' ? 'ES' : 'BR';
      const acct = await stripe.accounts.create({
        type: 'express',
        country,
        ...(email ? { email } : {}),
        // `business_type` é uma SUPOSIÇÃO em Espanha, e está anotada como
        // pendência em vez de escondida: uma parte grande dos bares espanhóis
        // é de autónomo (pessoa física), pra quem o certo é
        // `business_type: 'individual'` e o NIF é o DNI da pessoa. Enviar
        // 'company' pra um autónomo produz um KYC que não verifica.
        //
        // Não é adivinhável daqui: depende da forma jurídica da casa, que o
        // cadastro não pergunta. Fica na lista de bloqueios da Espanha
        // (docs/markets/README.md) — e a Espanha não está no ar.
        business_type: 'company',
        ...(businessName || cnpj ? {
          company: {
            ...(businessName ? { name: String(businessName).slice(0, 128) } : {}),
            // O documento vai na FORMA DO PAÍS.
            //
            // Era `replace(/\D/g, '')` sempre, que está certo pro CNPJ
            // (12.345.678/0001-99 → 12345678000199) e destrói um NIF
            // espanhol: "B12345674" chegava na Stripe como "12345674", e um
            // documento que não valida trava a verificação da conta que
            // RECEBE o dinheiro. Achado pela revisão de segurança.
            ...(cnpj ? { tax_id: m.code === 'br' ? String(cnpj).replace(/\D/g, '') : String(cnpj).trim().toUpperCase() } : {}),
          },
        } : {}),
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
          // Bizum só cobra depois que a Stripe verifica o onboarding do
          // esquema; fica `pending` até lá, e sem pedir nunca sai de inativo.
          ...(m.rails.includes('bizum') ? { bizum_payments: { requested: true } } : {}),
        },
      });
      return { recipientId: acct.id, status: acct.charges_enabled ? 'active' : 'registration' };
    },

    /**
     * Link de ONBOARDING (KYC) da conta conectada — o dono abre, preenche os
     * dados bancários/KYC na hosted page da Stripe (nada disso passa por nós) e
     * volta pro admin. Expira; gera de novo se preciso.
     */
    async createAccountLink({ accountId, refreshUrl, returnUrl }) {
      if (!/^acct_/.test(accountId || '')) throw new Error('createAccountLink: accountId (acct_…) obrigatório');
      if (!refreshUrl || !returnUrl) throw new TypeError('createAccountLink: refreshUrl e returnUrl obrigatórios');
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });
      return { url: link.url };
    },

    /** Status da conta conectada — a prova de que o restaurante pode receber. */
    async getConnectedAccount(accountId) {
      if (!/^acct_/.test(accountId || '')) return null;
      let a;
      try {
        a = await stripe.accounts.retrieve(accountId);
      } catch (err) {
        if (err && (err.statusCode === 404 || err.code === 'resource_missing')) return null;
        throw err;
      }
      const chargesEnabled = a.charges_enabled === true;
      return {
        recipientId: a.id,
        chargesEnabled,
        payoutsEnabled: a.payouts_enabled === true,
        // 'active' só quando dá pra cobrar; 'pending' se enviou dados mas ainda
        // em análise; 'registration' se nem começou o onboarding.
        status: chargesEnabled ? 'active' : (a.details_submitted ? 'pending' : 'registration'),
      };
    },

    /**
     * Webhook: verifica a assinatura Stripe (constructEvent) e devolve o shape
     * parseado comum. O corpo CRU é obrigatório (a assinatura é sobre os bytes).
     */
    async verifyAndParseWebhook(rawBody, signatureOrHeaders) {
      if (!webhookSecret) throw new WebhookVerificationError('STRIPE_WEBHOOK_SECRET não configurado');
      const headers = (signatureOrHeaders && typeof signatureOrHeaders === 'object') ? signatureOrHeaders : {};
      const sig = headers['stripe-signature'] || headers['Stripe-Signature']
        || (typeof signatureOrHeaders === 'string' ? signatureOrHeaders : null);
      if (!sig) throw new WebhookVerificationError('sem header stripe-signature');

      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      } catch (err) {
        throw new WebhookVerificationError(`assinatura Stripe inválida: ${String(err.message).slice(0, 120)}`);
      }

      /**
       * O MODO do evento tem que casar com o modo da chave.
       *
       * A assinatura só prova que o corpo veio de quem tem o `whsec_`. Ela não
       * diz nada sobre modo: um segredo de webhook de TESTE emparelhado com uma
       * chave LIVE — exatamente o desvio de configuração em que esta sessão
       * viveu, com `rkcs_test_` e `stripe listen` — fazia um
       * `payment_intent.succeeded` de teste virar confirmação de pagamento
       * válida no razão de produção. Dinheiro de mentira fechando mesa de
       * verdade. Achado pela revisão de segurança de 2026-09-08.
       *
       * O modo da chave é legível no prefixo. Divergência é 401 alto, não um
       * evento processado por engano.
       */
      const chaveDeTeste = /_test_/.test(String(secretKey));
      // AUSÊNCIA é falsificação, não dispensa.
      //
      // A primeira versão desta guarda era `typeof event.livemode === 'boolean'
      // && event.livemode === chaveDeTeste` — a forma `if (coisa && !ok)` de
      // novo, e desta vez o modelo de ameaça que motivou a guarda era
      // exatamente o que a derrotava. Ela existe porque um `whsec_` de TESTE
      // pode estar emparelhado com uma `sk_live_`, e segredos de teste são os
      // que vazam: saem em `stripe listen`, em CI, em print de tela, nesta
      // sessão. Quem tivesse um `whsec_` de teste assinava um corpo que
      // simplesmente OMITIA `livemode` e passava.
      //
      // Verificado contra o adaptador de verdade: um evento forjado sem o
      // campo virava `payment_confirmed` de R$ 5.000,00 no razão de produção,
      // conta marcada `paga`, write-back fechando a mesa. E o teste escrito
      // passava ao lado do desvio, porque ele mandava `livemode: false`.
      //
      // A Stripe põe `livemode` em todo evento v1. Não existe evento legítimo
      // sem ele. Achado pela revisão de segurança de 2026-09-08.
      if (event.livemode !== !chaveDeTeste) {
        throw new WebhookVerificationError(
          `modo do evento (livemode=${JSON.stringify(event.livemode)}) não casa com o modo da chave`,
        );
      }

      const type = event.type;
      /**
       * O ID DO EVENTO viaja com tudo.
       *
       * É a chave de idempotência de verdade: `evt_…` é único por entrega
       * lógica, e a Stripe manda a MESMA `evt_` de novo num reenvio. O append
       * confere dentro do lock (migração 0018), então duas entregas
       * simultâneas do mesmo evento não conseguem mais somar duas vezes.
       *
       * Isso é necessário porque uma falha de estorno chega em DOIS eventos
       * diferentes — `refund.failed` e `refund.updated` com status `failed` —
       * e os dois viram `refund_failed`. Não é reenvio: é a entrega normal.
       */
      const eventId = typeof event.id === 'string' ? event.id : null;
      if (type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        return { ...parseIntent(pi), kind: 'payment_confirmed', eventId };
      }
      if (type === 'charge.refunded') {
        // `charge.refunded` dispara em estorno PARCIAL também, e
        // `amount_refunded` é ACUMULADO — não é o valor deste estorno, é o
        // total já devolvido nessa cobrança. O código antigo tratava o
        // acumulado como se fosse o valor novo, então o segundo estorno parcial
        // reapresentava o total, o `validateEvent` recusava ("refund exceeds
        // paid amount"), a rota devolvia 409, a Stripe reenviava e depois
        // DESABILITAVA o endpoint — levando um `refund.failed` junto. Achado
        // pela revisão de compliance de 2026-09-08.
        //
        // Então o adaptador devolve o ACUMULADO e diz que é acumulado. Quem
        // sabe quanto já foi estornado é o razão, e é lá que o delta é
        // calculado (ver `applyConfirmedPayment`). De brinde isso é idempotente
        // de graça: um reenvio traz o mesmo acumulado, o delta dá zero, nada
        // acontece.
        //
        // E o RATEIO entre consumo e gorjeta saiu daqui. Era
        // `Math.min(tipCents, refunded)`, que devolvia a gorjeta inteira
        // primeiro — decisão sobre o salário de alguém tomada por ordem de
        // subtração. Agora é proporcional, no `allocateRefund`, com o split que
        // o RAZÃO gravou na confirmação, que é a fonte autoritativa (o
        // metadata do PI era uma segunda cópia, e exigia uma chamada extra à
        // API quando a charge não vinha expandida).
        const charge = event.data.object;
        const txid = charge.payment_intent;
        if (typeof txid !== 'string') throw new WebhookVerificationError('refund sem payment_intent');
        return {
          kind: 'refund', txid, eventId,
          cumulativeRefundedCents: Number(charge.amount_refunded) || 0,
          method: (charge.payment_method_details && charge.payment_method_details.type) === 'bizum'
            ? 'bizum' : 'card',
          raw: charge,
        };
      }
      /**
       * A FAMÍLIA da disputa, inteira.
       *
       * Antes só `created` e `closed`+`lost` eram lidos, e o resto caía em
       * `ignored`. Cada omissão custava algo concreto (revisão de compliance,
       * 2026-09-08):
       *
       *  - o `due_by` era JOGADO FORA. O Bizum dá 40 dias corridos pra
       *    apresentar prova, e perder o prazo é perder o dinheiro por inação.
       *    A defesa inteira desse prazo era uma notificação best-effort.
       *  - `dispute.updated` é o evento que carrega mudança de prazo e envio
       *    de prova. Ignorado, o prazo nunca era atualizado.
       *  - `funds_withdrawn` / `funds_reinstated` são dinheiro SAINDO e
       *    VOLTANDO do saldo. Ignorados, e o job diário não tem perna de
       *    razão do PSP, então nada mais pegava.
       *  - `closed` com `won` era ignorado, então a anomalia de disputa nunca
       *    era resolvida e a conta ficava VERMELHA pra sempre. Um canário que
       *    grita sem parar é o modo de falha que o inegociável #8 descreve.
       */
      if (String(type).startsWith('charge.dispute.')) {
        const d = event.data.object;
        const txid = d.payment_intent;
        if (typeof txid !== 'string') {
          // Dinheiro de verdade que não sabemos endereçar. Não é `ignored` —
          // ignorar é dizer "não me interessa".
          return { kind: 'unusable_money_event', type, status: d.status || null, raw: d, eventId };
        }
        const dueBy = Number.isFinite(Number(d.evidence_details && d.evidence_details.due_by))
          ? new Date(Number(d.evidence_details.due_by) * 1000).toISOString()
          : null;
        const base = {
          txid,
          // O id da disputa (`dp_…`) é a chave de idempotência do chargeback:
          // duas disputas na mesma cobrança são dois eventos legítimos.
          disputeId: typeof d.id === 'string' ? d.id : null,
          amountCents: Number(d.amount) || 0,
          reason: typeof d.reason === 'string' ? d.reason : null,
          status: typeof d.status === 'string' ? d.status : null,
          dueBy,
          raw: d,
        };

        if (type === 'charge.dispute.created') return { kind: 'dispute_opened', ...base, eventId };

        if (type === 'charge.dispute.funds_withdrawn' || type === 'charge.dispute.funds_reinstated') {
          return {
            kind: 'dispute_funds', eventId,
            direction: type.endsWith('withdrawn') ? 'withdrawn' : 'reinstated',
            ...base,
          };
        }

        if (type === 'charge.dispute.closed') {
          // PERDIDA: aí sim o dinheiro foi, e vira estorno de verdade. O valor
          // vai como delta pra ser rateado entre consumo e gorjeta no razão —
          // um chargeback leva a gorjeta junto, e deixá-la nos livros como
          // "paga" mentiria pra folha (Lei 13.419).
          if (d.status === 'lost') {
            return { kind: 'dispute_lost', refundDeltaCents: base.amountCents, method: 'dispute', ...base, eventId };
          }
          // GANHA (ou aviso encerrado sem virar disputa): o dinheiro fica.
          // Precisa de evento pra LIMPAR a marca — sem isso a conta fica
          // vermelha pra sempre.
          if (d.status === 'won' || d.status === 'warning_closed') {
            return { kind: 'dispute_won', ...base, eventId };
          }
          // Qualquer outro encerramento é mudança de estado, não desfecho.
          return { kind: 'dispute_updated', ...base, eventId };
        }

        // `updated`, `warning_needs_response`, `warning_under_review`…
        return { kind: 'dispute_updated', ...base, eventId };
      }
      // Reembolso que FALHOU. O dinheiro voltou pro saldo do restaurante e o
      // cliente continua sem receber — e ninguém descobre isso sozinho. Não
      // move o ledger (o estorno não aconteceu), mas tem que gritar.
      // `charge.refund.updated` é o nome DEPRECADO do mesmo evento.
      //
      // Os eventos `refund.*` só chegaram na versão 2024-10-28 (`acacia`) da
      // API; endpoint em versão anterior recebe `charge.refund.updated` no
      // lugar. Sem o sinônimo, um estorno que FALHOU caía no `ignored` → 200,
      // em cima de um razão que já dizia "estornado" — cliente sem dinheiro,
      // nós achando que devolvemos, e nada gritando. Depender de uma versão de
      // API configurada no painel é a forma do inegociável #7: uma
      // configuração invisível decidindo se o dinheiro é rastreado.
      if (type === 'refund.failed' || type === 'refund.updated' || type === 'charge.refund.updated') {
        const r = event.data.object;
        const txid = r.payment_intent;
        if (typeof txid !== 'string') {
          // Estorno de verdade que não sabemos endereçar. `Refund.payment_intent`
          // é NULÁVEL (cobrança criada pela API de Charges, e algumas entregas
          // de Connect). Ignorar isso é 200 pra dinheiro que se moveu.
          return { kind: 'unusable_money_event', type, status: r.status || null, raw: r, eventId };
        }
        return {
          kind: r.status === 'failed' ? 'refund_failed' : 'refund_progress',
          eventId,
          // O `re_` É A IDENTIDADE do estorno, e a mesma falha chega em DOIS
          // eventos (`refund.failed` e `refund.updated` com status `failed`),
          // com `evt_` diferentes — nem a chave do evento nem o índice único os
          // separam. Sem este id, a segunda entrega revertia de novo: o razão
          // apagava um estorno que SAIU, o telefone voltava a anunciar a dívida
          // e a casa pagava duas vezes (segurança HIGH-1 de 11a0904).
          refundId: typeof r.id === 'string' ? r.id : null,
          txid, amountCents: Number(r.amount) || 0, status: r.status || null, raw: r,
        };
      }

      /**
       * O pagamento que FALHOU.
       *
       * No Bizum é a pessoa recusando no app do banco. Era `ignored`, e o custo
       * era concreto: a linha de cobrança ficava `pendente` até sair da janela
       * de conciliação, e o razão nunca soube que aquela mesa tentou pagar e
       * não conseguiu. Achado da revisão de compliance de 2026-09-08 (H3).
       *
       * NÃO move o razão — nenhum dinheiro se moveu, então não há lançamento a
       * fazer nem a desfazer. O que muda é o ESTADO da cobrança: ela vira
       * `expirado`, status que o esquema já tem desde a primeira migração.
       */
      if (type === 'payment_intent.payment_failed' || type === 'payment_intent.canceled') {
        const pi = event.data.object;
        if (typeof pi.id !== 'string') return { kind: 'ignored', type, raw: pi, eventId };
        return {
          kind: 'payment_failed',
          eventId,
          txid: pi.id,
          amountCents: Number(pi.amount) || 0,
          status: pi.status || null,
          reason: (pi.last_payment_error && pi.last_payment_error.code) || pi.cancellation_reason || null,
          raw: pi,
        };
      }

      /**
       * Eventos de CONTA e de REPASSE: não movem o razão de nenhuma mesa, mas
       * cada um é uma promessa nossa quebrando em silêncio se ninguém vê.
       *
       *  - `payout.failed`: o dinheiro do restaurante NÃO chegou na conta dele.
       *    "Repasse automático diário" é argumento de venda.
       *  - `capability.updated` / `account.updated`: `bizum_payments` ou
       *    `transfers` virando inativo significa o trilho falhando na mesa, ou
       *    uma destination charge cujo transfer não sai — dinheiro parado no
       *    saldo da PLATAFORMA, que é território do inegociável #4.
       *  - `radar.early_fraud_warning.created`: o único evento em que estornar
       *    no mesmo dia evita a disputa inteira, e com ela os 40 dias de prazo.
       *
       * Espécie própria, não `ignored`: quem trata é o chamador, e o nome diz
       * o que é. Achados da revisão de compliance de 2026-09-08.
       */
      if (type === 'payout.failed' || type === 'payout.canceled'
          || type === 'capability.updated' || type === 'account.updated'
          || type === 'radar.early_fraud_warning.created') {
        const o = event.data.object || {};
        return {
          kind: 'account_alert',
          eventId,
          type,
          txid: typeof o.payment_intent === 'string' ? o.payment_intent : null,
          amountCents: Number(o.amount) || 0,
          status: typeof o.status === 'string' ? o.status : null,
          accountId: typeof event.account === 'string' ? event.account : null,
          raw: o,
        };
      }
      // Outros eventos não movem o nosso ledger — mas ignorar é 200, não 401.
      // Antes isto lançava `WebhookVerificationError`, que a rota mapeia pra
      // 401: a Stripe reenvia, depois DESABILITA o endpoint, e aí um
      // `refund.failed` (dinheiro de volta no saldo do restaurante, cliente
      // sem reembolso) se perde junto com todo o resto. A assinatura ESTAVA
      // válida; o evento é que não nos interessa. Achado da revisão.
      return { kind: 'ignored', type, raw: event.data && event.data.object, eventId };
    },
  };
}

module.exports = { createStripePsp, WebhookVerificationError };
