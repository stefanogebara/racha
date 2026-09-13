'use strict';

const { documentoPublicavelDaCasa } = require('./br/documento.js');

/**
 * Os mercados: Brasil e Espanha.
 *
 * Um mercado não é "um idioma" nem "uma moeda". É um pacote de regras que
 * mudam JUNTAS — o trilho de pagamento, a moeda, o documento que o pagador
 * precisa dar, e se existe uma linha de serviço na conta. Trocar uma sem as
 * outras produz coisas erradas em silêncio: um Pix em euro, um CPF pedido a um
 * espanhol, ou 10% pré-marcados numa conta em Madrid.
 *
 * **Quem decide é o SERVIDOR.** O cliente recebe o pacote pronto em
 * `/api/check` e só desenha. Isso é a correção da revisão #37 aplicada de
 * novo: a UI não deve inferir uma regra de dinheiro a partir de um palpite
 * (foi assim que a demo abriu a folha de cartão real), e é também a lição da
 * #32 — uma segunda implementação das regras no cliente é uma divergência com
 * um comentário em cima.
 *
 * Tudo em centavos inteiros, nas duas moedas. `EUR` tem 2 casas como o `BRL`,
 * então a matemática de divisão é a MESMA — o motor não muda, só o rótulo.
 */

/**
 * Serviço/gorjeta: três modos, e a diferença entre eles é jurídica.
 *
 * - `preselected` (Brasil): os 10% podem vir marcados, e **têm** que ser
 *   removíveis (CDC; inegociável #3). O valor vai pra casa e é distribuído em
 *   folha (Lei 13.419 + STJ Tema 1102; inegociável #2).
 * - `none` (Espanha, hoje): a conta não tem linha de serviço. Em Espanha o
 *   preço já inclui o serviço e a gorjeta é discricionária — quase nunca
 *   lançada na conta. Acrescentar uma linha que o cliente não pediu, num
 *   mercado onde ela não é costume, é o oposto do padrão certo na UE.
 * - `optIn`: reservado pra uma propina voluntária, se o produto quiser — e
 *   então **desmarcada por padrão**, nunca pré-selecionada.
 *
 * Se a Espanha ganhar propina, ela segue o mesmo inegociável do Brasil: o
 * dinheiro entra na conta da empresa e sai por folha, nunca no bolso direto de
 * um garçom — em Espanha a gorjeta também é renda tributável do empregado.
 */
const MARKETS = Object.freeze({
  br: Object.freeze({
    code: 'br',
    currency: 'BRL',
    /** Idioma sugerido na primeira visita; a pessoa continua podendo trocar. */
    defaultLang: 'pt',
    /** Trilhos, na ordem em que a tela oferece. O primeiro é o principal. */
    rails: Object.freeze(['pix', 'card']),
    serviceCharge: Object.freeze({ mode: 'preselected', defaultBp: 1000 }),
    /**
     * O adquirente exige `customer.document` pra emitir a cobrança Pix —
     * confirmado na doc do Pagar.me (docs.pagar.me/reference/pix-2, 2026-09-07).
     * É por isso que o campo existe, e é a base legal dele (LGPD art. 6º III).
     */
    payerTaxId: Object.freeze({ required: true, kind: 'cpf', digits: [11] }),
    /** Limites por cobrança, em centavos. Pix não tem teto de esquema. */
    charge: Object.freeze({ minCents: 1, maxCents: null }),
  }),
  es: Object.freeze({
    code: 'es',
    currency: 'EUR',
    defaultLang: 'es',
    /**
     * Bizum é o trilho principal em Espanha: pagamento em tempo real entre
     * contas, 20–30% dos checkouts espanhóis. Roda pelo adaptador Stripe que
     * já existe, com Connect — então o fluxo de fundos continua PSP → conta do
     * restaurante, sem custódia nossa (inegociável #4).
     */
    rails: Object.freeze(['bizum', 'card']),
    serviceCharge: Object.freeze({ mode: 'none', defaultBp: 0 }),
    /**
     * O Bizum não pede documento do pagador: quem autentica é o banco dele,
     * no app dele. Pedir NIF/DNI aqui seria coletar dado sem necessidade —
     * GDPR art. 5(1)(c), minimização, que é a mesma regra do art. 6º III da
     * LGPD. O documento do RESTAURANTE continua sendo exigido (é requisito de
     * onboarding do Bizum na conta conectada), mas isso é cadastro, não checkout.
     */
    payerTaxId: Object.freeze({ required: false, kind: 'nif', digits: [9] }),
    /**
     * Limites do esquema Bizum na Stripe: mínimo 0,50 € e **máximo 5.000 €**
     * por cobrança. O teto é real e a conta de uma mesa grande pode encostar
     * nele, então a tela precisa dizer isso em vez de deixar o PSP recusar.
     */
    charge: Object.freeze({ minCents: 50, maxCents: 500000 }),
  }),
});

const DEFAULT_MARKET = 'br';

/**
 * A Espanha está CONSTRUÍDA e não LIGADA.
 *
 * A revisão de compliance da abertura (2026-09-07) barrou o portão em dois
 * pontos que não são código:
 *
 *  1. **Disputa.** O Bizum tem 120 dias de reclamação e a Stripe retém o valor
 *     disputado do saldo — numa destination charge, do saldo da PLATAFORMA.
 *     Recuperar exige reversão de transferência mais cláusula de regresso no
 *     contrato do restaurante. Não é conta-bolsão, mas MUDA quem fica sem o
 *     dinheiro, e o inegociável #4 diz que mudança de fluxo de fundos passa por
 *     parecer de advogado de pagamentos ANTES.
 *  2. **GDPR capítulo V.** O banco fica em São Paulo. Dado pessoal de titular
 *     europeu indo pro Brasil precisa de cláusulas-padrão e avaliação de
 *     transferência, ou de um projeto em região da UE.
 *
 * Então o trilho espanhol falha FECHADO: sem `RACHA_ES_ENABLED=true` nenhuma
 * cobrança sai, mesmo que alguém vire o `market` de uma venue no banco — que é
 * exatamente o caminho provável de um piloto às pressas. A apresentação
 * continua funcionando (a tela é revisável), o dinheiro não.
 *
 * É o mesmo desenho do `CRON_SECRET` na revisão #37: o estado "não configurado"
 * não é permissivo, é recusa.
 */
function esEnabled() {
  return process.env.RACHA_ES_ENABLED === 'true';
}

/**
 * O mercado pode COBRAR? Devolve `null` quando sim, ou um código.
 *
 * Separado do `supportsRail` de propósito: um trilho pode ser o certo pro
 * mercado e ainda assim não estar liberado pra rodar.
 */
function chargingAllowed(code) {
  if (market(code).code === 'es' && !esEnabled()) {
    return { code: 'market_not_live' };
  }
  return null;
}

/** Todos os códigos de mercado conhecidos. */
function marketCodes() {
  return Object.keys(MARKETS);
}

function isMarket(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(MARKETS, code);
}

/**
 * O pacote de regras de um mercado. Desconhecido ou ausente cai no Brasil —
 * toda venue que existia antes deste módulo é brasileira, e um default
 * silencioso aqui é melhor que uma venue sem moeda.
 */
function market(code) {
  return MARKETS[isMarket(code) ? code : DEFAULT_MARKET];
}

/**
 * O que o cliente recebe. Só regras de apresentação e de validação — nada de
 * credencial, nada de id de PSP.
 *
 * `serviceCharge.bp` sai do valor configurado na venue quando o mercado tem
 * linha de serviço, e é 0 quando não tem: o dono pode ter deixado 1000 no
 * cadastro e a conta em Madrid ainda assim não cobra serviço.
 */
function publicMarketView(code, { servicoBp = 0, cnpj = null } = {}) {
  const m = market(code);
  // A LINHA DE SERVIÇO SÓ APARECE ONDE PODE SER COBRADA.
  //
  // O `marketGate` recusa a gorjeta sem documento de empresa provado — e a
  // tela seguia oferecendo: o cliente via o serviço pré-selecionado, somado
  // no total, tocava em pagar e levava a recusa. A cobrança não acontece,
  // então não é oferta descumprida; mas é um total mostrado que a casa não
  // pode receber, e um beco sem saída no caminho PADRÃO é como um piloto
  // conclui que o produto está quebrado. Mesma regra, mesmo lugar: quem não
  // pode cobrar não oferece. Achado pela revisão de compliance de 2026-09-13.
  const podeCobrarServico = !!documentoPublicavelDaCasa(code, cnpj, true);
  const hasService = m.serviceCharge.mode !== 'none' && podeCobrarServico;
  return {
    // `servicoBp` cru NÃO viaja: mandar 1000 ao lado de `serviceCharge.bp: 0`
    // são duas verdades no mesmo payload, e o próximo cliente que ler o campo
    // errado cobra 10% em Madrid. Quem quer a taxa lê `serviceCharge.bp`.
    servicoBp: hasService ? Number(servicoBp) || 0 : 0,
    market: m.code,
    currency: m.currency,
    defaultLang: m.defaultLang,
    rails: [...m.rails],
    serviceCharge: {
      mode: m.serviceCharge.mode,
      bp: hasService ? Number(servicoBp) || 0 : 0,
    },
    payerTaxId: { required: m.payerTaxId.required, kind: m.payerTaxId.kind },
    charge: { minCents: m.charge.minCents, maxCents: m.charge.maxCents },
  };
}

/**
 * Um valor cabe numa cobrança deste mercado?
 *
 * Devolve `null` quando cabe, ou um CÓDIGO de erro — nunca uma frase: quem
 * sabe o idioma do leitor é o cliente (CLAUDE.md). `amount_under_min` e
 * `amount_over_max` levam o limite nos `vars`, pra tela poder formatar na
 * moeda certa.
 */
function checkChargeLimits(code, amountCents) {
  const m = market(code);
  if (!Number.isInteger(amountCents)) return { code: 'amount_invalid' };
  if (amountCents < m.charge.minCents) {
    return { code: 'amount_under_min', vars: { minCents: m.charge.minCents } };
  }
  if (m.charge.maxCents !== null && amountCents > m.charge.maxCents) {
    return { code: 'amount_over_max', vars: { maxCents: m.charge.maxCents } };
  }
  return null;
}

/**
 * O documento da CASA pode aparecer na tela do cliente neste mercado?
 *
 * No Brasil, sim, e é o certo: o CNPJ é identificação de empresa, está na porta
 * e em toda nota, e sem ele o comprovante não identifica quem vendeu.
 *
 * Em Espanha, NÃO — por enquanto. A mesma coluna guarda o NIF, e uma parte
 * grande dos bares espanhóis é de **autónomo**: pessoa física, cujo NIF É o
 * número do DNI dela. Publicar isso pra qualquer um que tenha o token de uma
 * mesa — e tokens viajam em links compartilhados e QRs fotografados — é expor
 * o identificador nacional de uma pessoa física. É o mesmo argumento de
 * minimização (GDPR art. 5(1)(c)) que tirou o CPF do pagador do metadata da
 * Stripe, apontado pro outro lado. Achado pela revisão de segurança de
 * 2026-09-07.
 *
 * O que destrava: o cadastro passar a saber a forma jurídica da casa
 * (sociedade ou autónomo). Aí sociedade mostra e autónomo não, que é a regra
 * certa. Enquanto não se sabe, não mostra — e a Espanha não está no ar, então
 * isto não tira nada de ninguém hoje.
 */
function showsVenueTaxId(code) {
  return market(code).code === 'br';
}

/**
 * TODOS os portões de mercado de uma cobrança, num só lugar.
 *
 * Devolve `null` quando pode cobrar, ou `{ code, vars? }`.
 *
 * **Por que existe.** As quatro conferências moravam soltas, e a revisão de
 * compliance de 2026-09-07 achou o resultado previsível: o `create-charge`
 * tinha três delas, a rota `/api/pay/stripe-intent` tinha duas OUTRAS, e a
 * rota é justamente a única que cria cobrança de Bizum. Faltava lá o
 * `chargingAllowed` — o interruptor que segura a Espanha inteira — e o portão
 * de gorjeta. Com `STRIPE_SECRET_KEY` no ambiente, virar o `market` de uma
 * venue no banco fazia sair uma cobrança espanhola de verdade, antes do parecer
 * sobre disputa e antes da papelada do GDPR.
 *
 * Quatro regras copiadas em dois lugares é a forma de um deles ficar com três.
 * Agora é uma função: quem cobra chama ela, e esquecer uma regra deixou de ser
 * possível — só esquecer a função, que é uma linha e não quatro.
 *
 * A ordem importa: o interruptor do mercado vem PRIMEIRO. Um mercado que não
 * está no ar não deve nem explicar que o trilho está errado.
 */
function marketGate(code, { rail, amountCents, tipCents = 0, venue = null } = {}) {
  const live = chargingAllowed(code);
  if (live) return live;
  if (!supportsRail(code, rail)) return { code: 'rail_unsupported' };
  // Gorjeta onde não há linha de serviço: um bug de tela ou um POST forjado
  // criaria um valor que ninguém pode distribuir legalmente (em Espanha a
  // gorjeta também é renda tributável do empregado, e não há folha nossa).
  if (market(code).serviceCharge.mode === 'none' && tipCents > 0) {
    return { code: 'tip_not_supported' };
  }
  // ── SERVIÇO SÓ ONDE HÁ PESSOA JURÍDICA PRA DISTRIBUIR ────────────────────
  //
  // Mora AQUI, e não no `create-charge`, porque `create-charge` não é o funil
  // — é UM dos funis. O `POST /api/pay/stripe-intent` monta a cobrança sozinho
  // e chama o adaptador direto, então a regra posta lá valia no Pix e na
  // carteira Pagar.me e não valia no cartão: a mesma casa, a mesma gorjeta,
  // duas respostas, com o trilho escolhido por quem se cansou do QR.
  //
  // O comentário desta função já contava essa história de 2026-09-07 — quatro
  // regras copiadas em dois lugares e uma ficou pra trás — e a quinta regra
  // nasceu solta do mesmo jeito. Aqui passa todo mundo.
  // `venue == null` RECUSA, não libera. Era `tipCents > 0 && venue && !doc` —
  // a forma `if (thing && !ok)` que o inegociável #7 nomeia, dentro da função
  // escrita pra fechar o #7. Com gorjeta e sem venue não há o que conferir, e
  // a resposta certa pra "não sei" é não. Achado pelas duas revisões.
  if (tipCents > 0 && !documentoPublicavelDaCasa(venue?.market || code, venue?.cnpj, true)) {
    return { code: 'venue_no_tip_document' };
  }
  return checkChargeLimits(code, amountCents + tipCents);
}

/**
 * A moeda do mercado no formato que os PSPs querem: minúscula, ISO-4217.
 *
 * Existe pra que nenhum chamador escreva `'brl'` na mão nem um
 * `.toLowerCase()` solto. Os dois chamadores do `createWalletCharge` tinham
 * ESQUECIDO de passar moeda, e o padrão do adaptador cobria o esquecimento com
 * reais — numa mesa em Madrid.
 */
function pspCurrency(code) {
  return market(code).currency.toLowerCase();
}

/** O trilho pedido é servido por este mercado? */
function supportsRail(code, rail) {
  return market(code).rails.includes(rail);
}

module.exports = {
  MARKETS,
  DEFAULT_MARKET,
  marketCodes,
  isMarket,
  market,
  publicMarketView,
  checkChargeLimits,
  supportsRail,
  marketGate,
  showsVenueTaxId,
  pspCurrency,
  esEnabled,
  chargingAllowed,
};
