'use strict';

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
function publicMarketView(code, { servicoBp = 0 } = {}) {
  const m = market(code);
  const hasService = m.serviceCharge.mode !== 'none';
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
  pspCurrency,
  esEnabled,
  chargingAllowed,
};
