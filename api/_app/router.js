'use strict';

/**
 * Shared HTTP router — the single source of API behavior, used by BOTH the
 * local dev-server (node dev-server.js) and the Vercel serverless function
 * (api/[...path].js). Store/psp/auth are module-level singletons: in Fluid
 * Compute they're created once and reused across requests.
 *
 * Diner endpoints are public (no login). Owner endpoints are gated by a
 * Supabase access token + venue ownership. Money paths are unchanged from the
 * reviewed core.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Minimal .env loader (local only; Vercel injects env directly).
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const { createMemoryStore } = require('../_lib/store/memory');
const { normalizarDocumentoDaCasa, decidirDocumentoDoRecebedor, documentoPublicavelDaCasa } = require('../_lib/br/documento.js');
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler, applyConfirmedPayment, NON_LEDGER_KINDS } = require('../_lib/pay/webhook-handler');
const { appendValidated } = require('../_lib/checks/append-validated');
const { tetoDaRestituicao, payloadDaResolucao, autorDoRegistro, codigoDaRecusa } = require('../_lib/checks/restitution');
const { classificarFalhaDoRecebedor, classificarFalhaNaCriacao, temRecebedorReal, podeCriarRecebedor } = require('../_lib/pay/recebedor');

/**
 * O rateio de uma devolução registrada à mão é o MESMO do estorno que vem do
 * PSP: `checks/refund-allocation.js`, três baldes. Não é uma segunda regra de
 * dinheiro — e quando era uma cópia, as duas divergiram.
 */
const { alocarDevolucaoDoPagamento } = require('../_lib/checks/refund-allocation');
const { createNonLedgerHandler, needsRetry, SEM_ALARDE } = require('../_lib/pay/non-ledger');
const { publicCheckState } = require('../_lib/checks/public-state');
const { createChargeReconciler } = require('../_lib/checks/reconcile-charges');
const { createStripePsp } = require('../_lib/pay/stripe-psp');
const { reduce, remainingCents, paidAfterClose } = require('../_lib/checks/check-state');
const {
  createChargeService, assertChargeSlot, geracaoDoQr, payerLabelValido, JANELA_VIVA_MS,
} = require('../_lib/pay/create-charge');
const { escolherPsp } = require('../_lib/pay/psp-indisponivel');
const { errorStatus, errorBody } = require('../_lib/http-error');
const { readBody } = require('../_lib/read-body');
const { notifyOwnerRecipientStatus, notifyFounderActivationRadar, notifyPreviaBeacon,
        notifyFounderReconcile, notifyFounderMoneyEvent } = require('../_lib/notify');
const { waitUntil } = require('@vercel/functions');
const { IMPRESSAO_0033 } = require('../_lib/store/impressao-0033');
const { montarRadar } = require('../_lib/activation/radar');
const { isTerminalRecipientStatus } = require('../_lib/recipient-status');
const { createCheckService } = require('../_lib/checks/check-service');
const { createHouseService } = require('../_lib/house/house-service');
const { reconcileVenue, reconcileVenueHouse, desfechoDoLancamento, podeSerReentrega } = require('../_lib/checks/reconcile');
const { reconcileAllVenues, reconcileOneVenue, formatReconcileAlert,
  formatReconcileHeartbeat } = require('../_lib/checks/reconcile-daily');
const { vigiarRetencao } = require('../_lib/checks/retention-watch');
const { resolvePosAdapter } = require('../_lib/pos/adapter');
const { createAuth } = require('../_lib/auth');

// AS ENVS, NORMALIZADAS UMA VEZ SÓ — e é a única leitura delas no `api/`.
//
// A rodada anterior pôs `.trim()` no PORTÃO e deixou o `buildPsp` comparando
// cru. Trimar só de um lado faz o portão ser MAIS PERMISSIVO que aquilo que ele
// guarda, e a fresta falha ABERTA: `RACHA_PSP="pagarme "` (um espaço colado no
// painel da Vercel) dava portão verde, cron calado, deploy aprovado — e casa de
// verdade servindo BR Code do mock, que banco nenhum honra. A revisão de
// segurança de ec86b37 mediu os três casos (CRITICAL-1). É o incidente C1
// inteiro, de novo, agora com o alarme dizendo que está tudo bem.
//
// Uma constante, lida em todo lugar: portão e consumidor não têm como divergir.
const RACHA_STORE = (process.env.RACHA_STORE || '').trim();
const RACHA_PSP = (process.env.RACHA_PSP || '').trim();
const useSupabase = RACHA_STORE === 'supabase';
const store = useSupabase
  ? require('../_lib/store/supabase').createSupabaseStore()
  : createMemoryStore();

// PRODUÇÃO NÃO COBRA EM MODO DE DEMO. Sem `RACHA_STORE=supabase` o store é o
// mapa em memória de UMA instância: a cobrança Pix de verdade seria gravada
// numa instância e o webhook, noutra, receberia "txid desconhecido" — o
// dinheiro chegava na casa e o razão nunca sabia. Sem `RACHA_PSP=pagarme`, casa
// de verdade entregava BR Code de mentira. Nada no código nem no deploy
// impedia (auditoria de backend C1). Em produção, faltando qualquer um, as rotas
// de dinheiro recusam com código, e o cron de quinze minutos pagina.
// É PRODUÇÃO? PELO SILÊNCIO, SIM.
//
// A versão anterior tentava fechar o buraco com `VERCEL === '1'` quando
// `VERCEL_ENV` faltasse — e as duas variáveis saem da MESMA chave do projeto
// ("Enable access to System Environment Variables"). Com ela desligada não
// existe nenhuma das duas, e a cláusula nova nunca podia disparar: ela só era
// avaliada quando `VERCEL_ENV` já estava lá, caso que a primeira metade já
// tratava. O buraco que o comentário descrevia continuava aberto, com um
// guarda escrito em cima dele (segurança HIGH-1 de ec86b37).
//
// Agora o ambiente é NOSSO (`RACHA_ENV`, que o `deploy.mjs` exige junto das
// outras), e o DESCONHECIDO conta como produção: um deploy feito pelo painel,
// um rollback ou um push que não passe pelo nosso script cai do lado seguro.
// A única saída do silêncio é o processo dizer que é teste — e um `RACHA_ENV`
// explícito de produção vence até isso, pra suíte poder exercitar o portão.
const AMBIENTE = (process.env.VERCEL_ENV || process.env.RACHA_ENV || '').trim();
// SÓ o `JEST_WORKER_ID`, que é a suíte que põe e ninguém mais. `NODE_ENV` é um
// campo que uma pessoa digita num painel — e com a lista de recusa, ele passou a
// poder derrubar a produção pra QUALQUER grafia que não seja `production`
// exata. Escape de teste não pode estar ao alcance de quem configura a produção
// (segurança LOW-1 de 41b188a).
const EM_TESTE = !!process.env.JEST_WORKER_ID;
/**
 * SÓ SAI DA PRODUÇÃO QUEM DIZ, COM UMA DAS DUAS PALAVRAS.
 *
 * A versão anterior era `AMBIENTE === 'production' || (AMBIENTE === '' &&
 * !EM_TESTE)` — uma LISTA DE PERMISSÃO — com um comentário em cima dizendo que
 * o desconhecido contava como produção. O comentário era a intenção; o código
 * fazia o contrário: só a string VAZIA caía do lado seguro, e qualquer outro
 * valor que não fosse exatamente `production` saía da produção.
 *
 * E o valor deixou de vir da Vercel (conjunto FECHADO: production/preview/
 * development) pra vir de um campo que uma pessoa digita. Alguém escreve
 * `prod`, ou `Production`, e uma casa de verdade passa a servir BR Code do
 * mock, com o razão num mapa em memória e o cron devolvendo 200 verde — o
 * incidente C1 inteiro, embaixo do guarda escrito pra impedi-lo. Medido pela
 * revisão de segurança de d7f2683 (HIGH-1), que provou os seis valores.
 *
 * Agora é lista de RECUSA: `preview` e `development` saem; todo o resto —
 * inclusive o que ninguém previu — é produção e falha fechada. O `deploy.mjs`
 * exige `RACHA_ENV=production` exato, mas ele não cobre deploy pelo painel,
 * rollback, nem push pela integração de git: o portão do runtime é o que
 * precisa estar certo sozinho.
 */
const FORA_DA_PRODUCAO = ['preview', 'development'];
const EM_PRODUCAO = AMBIENTE === 'production'
  || (!FORA_DA_PRODUCAO.includes(AMBIENTE) && !EM_TESTE);
const CONFIG_DE_PRODUCAO_FALTANDO = EM_PRODUCAO
  ? [!useSupabase && 'RACHA_STORE=supabase',
    RACHA_PSP !== 'pagarme' && 'RACHA_PSP=pagarme'].filter(Boolean)
  : [];
if (CONFIG_DE_PRODUCAO_FALTANDO.length) {
  process.stderr.write(`[config] PRODUÇÃO SEM ${CONFIG_DE_PRODUCAO_FALTANDO.join(' e ')} — rotas de dinheiro em 503\n`);
}
const ROTA_DE_DINHEIRO = (caminho) => caminho === '/api/pay' || caminho === '/api/pay/stripe-intent'
  || caminho === '/api/house/load' || caminho === '/api/house/redeem'
  || caminho === '/api/dev/confirm' || caminho.startsWith('/api/webhooks/');

// PSP real por env (RACHA_PSP=pagarme + PAGARME_SECRET_KEY); mock é o
// default — demo e testes seguem idênticos. Stable webhook secret in prod
// (an instance-random secret would break verification across instances).
//
// BLINDAGEM (incidente 2026-07-21): a criação do PSP roda no LOAD do módulo.
// Uma PAGARME_SECRET_KEY malformada (ex.: colaram a pk_ no lugar da sk_) fazia
// createPagarmePsp() lançar na init e derrubava a API INTEIRA — /api/check,
// painel, tudo 500 (FUNCTION_INVOCATION_FAILED), não só pagamento. Agora a
// falha de config degrada: leitura segue de pé; SÓ as rotas de pagamento
// respondem 503 com motivo claro (nunca cai no mock em silêncio — dinheiro
// real jamais roteia pra um PSP de mentira).
function buildPsp() {
  if (RACHA_PSP === 'pagarme') {
    return require('../_lib/pay/pagarme-psp').createPagarmePsp({
      secretKey: process.env.PAGARME_SECRET_KEY,
      webhookBasicAuth: process.env.PAGARME_WEBHOOK_AUTH || null,
    });
  }
  return new MockPsp({ webhookSecret: process.env.PSP_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex') });
}
// A escolha do PSP — e o adaptador que recusa — moram em `pay/psp-indisponivel.js`,
// com o censo que confere que nenhum método chamado aqui fica de fora.
let motivoDaQuebra = CONFIG_DE_PRODUCAO_FALTANDO.length
  ? `produção sem ${CONFIG_DE_PRODUCAO_FALTANDO.join(' e ')}` : null;
const psp = escolherPsp(CONFIG_DE_PRODUCAO_FALTANDO, buildPsp, (err) => {
  process.stderr.write(`[psp] init FALHOU: ${err.message} — rotas de pagamento em 503, leitura segue\n`);
  motivoDaQuebra = `PSP não configurado (${err.message})`;
});

/**
 * A PLATAFORMA ESTÁ QUEBRADA? Pelo RESULTADO, não pela lista de entrada.
 *
 * O portão das rotas e o alarme do cron olhavam só `CONFIG_DE_PRODUCAO_FALTANDO`.
 * Produção com as duas envs certas e uma `PAGARME_SECRET_KEY` malformada (a `pk_`
 * colada no lugar da `sk_` — o incidente de 2026-07-21) caía no adaptador que
 * recusa com a lista VAZIA: nenhuma rota fechava pelo portão, o cron não
 * paginava, e o cliente via `internal` porque o `errorBody` apaga mensagem de
 * 5xx. Apagão de pagamento sem uma página sequer (segurança MEDIUM-2 de
 * ec86b37). Quem responde agora é o adaptador que de fato ficou na mão.
 */
const PLATAFORMA_QUEBRADA = () => CONFIG_DE_PRODUCAO_FALTANDO.length > 0 || psp.provider === 'unconfigured';

const charge = createChargeService({ store, psp });
const checkSvc = createCheckService({ store });
const houseSvc = createHouseService({ store, psp });
// Evento de dinheiro que não vira lançamento (cancelamento parcial, disputa,
// estorno falho): anomalia durável no razão + aviso. Ver `_lib/pay/non-ledger`.
const handleNonLedgerMoneyEvent = createNonLedgerHandler({
  // O QUARTO caminho até o avisador, e o único que não era uma chamada — é uma
  // LIGAÇÃO, então nenhum censo que olha expressão de chamada o vê.
  //
  // Os três sites de webhook ganharam o embrulho; este ficou no remetente cru,
  // e ele serve o trilho PIX. Hoje está seguro pelo motivo certo: o conjunto
  // que chega aqui é `NON_LEDGER_KINDS \ SEM_ALARDE`, e a invariante nova
  // garante que ele é subconjunto do que o avisador aceita. Mas isso é uma
  // defesa só, e o que a sustenta é que os três chamadores de
  // `handleNonLedgerMoneyEvent` são todos guardados por `NON_LEDGER_KINDS.has`
  // — forma "chamador esquecido": um quarto chamador sem guarda traz de volta o
  // 5xx eterno que derruba o endpoint. Embrulhar aqui dá o mesmo piso aos
  // quatro caminhos e rebaixa a invariante de defesa única pra defesa em
  // profundidade. Achado da revisão de segurança de 2026-09-12.
  store, notify: avisarEventoDeDinheiro,
});

const handleWebhook = createWebhookHandler({
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
  seenPspEvent: store.seenPspEvent.bind(store),
  getPayment: store.getPayment.bind(store),
  repairPaymentRow: store.repairPaymentRow.bind(store),
  psp,
  // txid that isn't a check charge → maybe a house-account load.
  fallback: (parsed) => houseSvc.confirmLoadFromWebhook(parsed),
});

// Active reconciliation: re-ask the PSP about pending charges and confirm the
// paid ones through the SAME core the webhook uses. The safety net for a
// missed/rejected webhook — money confirmation must never hinge on a POST
// arriving. Triggered on the diner's read (self-healing) and by a cron.
const confirmDeps = {
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
  seenPspEvent: store.seenPspEvent.bind(store),
  getPayment: store.getPayment.bind(store),
  repairPaymentRow: store.repairPaymentRow.bind(store),
  fallback: (parsed) => houseSvc.confirmLoadFromWebhook(parsed),
};

// Stripe = 2º rail (cartão / Apple Pay / Google Pay web via Connect). SÓ liga
// com STRIPE_SECRET_KEY setada; sem isso fica null e todo o caminho de cartão
// responde 503/inerte — o Pix (Pagar.me) fica 100% intacto. Deploy gated
// (conta Connect + onboarding por restaurante + jurídico, regra nº4).
let stripePsp = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    stripePsp = createStripePsp({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    });
  } catch (err) {
    process.stderr.write(`[stripe] init FALHOU: ${err.message} — rail de cartão inerte\n`);
    stripePsp = null;
  }
}

// A reconciliação re-pergunta ao PSP DONO da cobrança: pi_ → Stripe, o resto →
// o PSP principal (Pagar.me/mock). Um dispatcher de getCharge por prefixo de txid.
const reconcilePsp = {
  getCharge: async (txid) => {
    if (stripePsp && typeof txid === 'string' && /^pi_/.test(txid)) return stripePsp.getCharge(txid);
    return typeof psp.getCharge === 'function' ? psp.getCharge(txid) : null;
  },
};
const reconciler = createChargeReconciler({
  store, psp: reconcilePsp,
  confirm: (parsed) => applyConfirmedPayment(parsed, confirmDeps),
});

// DEMO ISOLADO (blindagem do go-live): a mesa pública de demonstração NUNCA
// toca o PSP real. Sem isso, ligar sk_live_ faria um lead pagando a "conta de
// mentira" (o link que a Olímpia manda) ou ser cobrado DE VERDADE, ou o demo
// quebrar (o recebedor de teste não existe em live). Aqui ele roda sempre num
// MockPsp próprio e se auto-confirma — independente de RACHA_PSP/live. É a única
// venue cujo dinheiro é fake por design.
const { DEMO_TOKEN, ensureDemoCheck, resetDemoCheck, isDemoVenue } = require('../_lib/demo');
const DEMO_TABLE_TOKEN = process.env.RACHA_DEMO_TABLE_TOKEN || DEMO_TOKEN;
const demoPsp = new MockPsp({ webhookSecret: process.env.PSP_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex') });
const demoCharge = createChargeService({ store, psp: demoPsp });
const demoWebhook = createWebhookHandler({
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
  seenPspEvent: store.seenPspEvent.bind(store),
  getPayment: store.getPayment.bind(store),
  repairPaymentRow: store.repairPaymentRow.bind(store),
  psp: demoPsp,
  fallback: (parsed) => houseSvc.confirmLoadFromWebhook(parsed),
});

// The simulate-confirmation affordance only exists when explicitly enabled
// (the deployed sales DEMO uses the mock PSP; a real deploy with a live PSP
// leaves this off so nobody can mark payments confirmed).
const { chargingAllowed, market, marketGate, pspCurrency, isMarket, DEFAULT_MARKET } = require('../_lib/markets');

const DEMO_MODE = process.env.RACHA_DEMO_MODE === 'true';

// Login COMPARTILHADO (opcional): a verificação de token pode apontar pra OUTRO
// projeto Supabase que não o de dados. Com AUTH_SUPABASE_URL/KEY = Seatable, o
// token vem do GoTrue do Seatable (então quem já tem conta no Seatable loga no
// Racha), enquanto os DADOS do Racha (venues/checks) ficam no projeto do Racha.
// Sem esses envs, cai no projeto do próprio Racha (comportamento antigo).
// getUser() só VERIFICA o JWT — a chave publicável/anon do projeto de auth basta
// (não precisa service-role pra isso). Requer soltar o FK venue_members→auth.users
// (migração 0008), já que os user_ids passam a vir de outro projeto.
const AUTH_SUPABASE_URL = process.env.AUTH_SUPABASE_URL || process.env.SUPABASE_URL;
const AUTH_SUPABASE_KEY = process.env.AUTH_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
let auth = null;
let authClient = null;
if (AUTH_SUPABASE_URL && AUTH_SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  authClient = createClient(AUTH_SUPABASE_URL, AUTH_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  auth = createAuth({ authClient, store });
}

/** Ordem de gravidade — pra cortar os achados pelo topo, não pela chegada. */
const RANK = { critical: 3, high: 2, info: 1 };

/**
 * OS ACHADOS QUE O PAINEL MOSTRA: por gravidade e, dentro da mesma gravidade,
 * o que tem PRAZO primeiro — um `dispute_evidence_due` perde dinheiro por
 * inação. E os `paid_after_close` viram UM (a soma, e quantos): cinco
 * pagamentos de um centavo depois de fechar enchiam as cinco vagas e
 * escondiam o prazo de uma disputa (segurança LOW-1 e compliance LOW-A de
 * 497bf87). Só código e centavos saem — ver o comentário na rota do painel.
 */
const PRIMEIRO_NA_GRAVIDADE = { dispute_evidence_overdue: 3, dispute_evidence_due: 2 };
const JUNTAR_NO_PAINEL = ['paid_after_close', 'paid_after_close_tip'];
function projetarAchados(findings) {
  // Os DOIS códigos do pago-depois-de-fechar se juntam, cada um no seu grupo:
  // depois de 48 h, cinco `paid_after_close_tip` critical enchiam as vagas e
  // escondiam um prazo de disputa (compliance LOW-D de 57c0d2e).
  const juntar = (code) => {
    const grupo = findings.filter((f) => f.code === code);
    return grupo.length <= 1 ? grupo : [{
      severity: grupo.some((f) => f.severity === 'critical') ? 'critical' : 'high',
      code,
      amountCents: grupo.reduce((soma, f) => soma + (f.amountCents || 0), 0),
      count: grupo.length,
    }];
  };
  return [...findings.filter((f) => !JUNTAR_NO_PAINEL.includes(f.code)), ...JUNTAR_NO_PAINEL.flatMap(juntar)]
    .sort((a, b) => ((RANK[b.severity] || 0) - (RANK[a.severity] || 0))
      || ((PRIMEIRO_NA_GRAVIDADE[b.code] || 0) - (PRIMEIRO_NA_GRAVIDADE[a.code] || 0)))
    .slice(0, 5)
    .map((f) => ({
      severity: f.severity, code: f.code,
      ...(f.overpaidCents !== undefined ? { overpaidCents: f.overpaidCents } : {}),
      ...(f.deltaCents !== undefined ? { deltaCents: f.deltaCents } : {}),
      ...(f.driftCents !== undefined ? { driftCents: f.driftCents } : {}),
      ...(f.amountCents !== undefined ? { amountCents: f.amountCents } : {}),
      ...(f.txid ? { txid: f.txid } : {}),
      ...(f.chargeId ? { chargeId: f.chargeId } : {}),
      ...(f.count ? { count: f.count } : {}),
    }));
}

function json(res, status, body, extra = null) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type,x-racha-signature',
    ...(extra || {}),
  });
  res.end(JSON.stringify(body));
}

/**
 * `Retry-After` quando a espera TEM prazo — e só aí.
 *
 * O cabeçalho sai de `vars.windowMinutes`, e só a recusa por CONTA de recarga o
 * manda: aquele balde só o dono da carteira enche, então quinze minutos é
 * verdade. A recusa do teto da mesa e a do teto de recargas da CASA não mandam,
 * porque ali quem tem o token repõe cada vaga ao vencer e a espera não tem fim —
 * a primeira versão deste docblock dizia que esperar era "o ÚNICO remédio", e o
 * cabeçalho prometia pelo protocolo o prazo que a tela já não prometia.
 * (Compliance, L2.)
 */
function cabecalhoDeEspera(err) {
  const min = err && err.vars && Number(err.vars.windowMinutes);
  if (!Number.isFinite(min) || min <= 0) return null;
  return { 'Retry-After': String(Math.ceil(min * 60)) };
}

/**
 * O TETO DISPAROU — alguém que pode agir tem que ficar sabendo, uma vez.
 *
 * Uma mesa legítima não chega ao teto (a conta está no `create-charge.js`), então
 * um 429 dele é ataque; e o remédio do dono (girar o QR, que começa um balde
 * novo) só existe se alguém souber. O mesmo pro teto de recargas da CASA.
 *
 * O QUE A PRIMEIRA VERSÃO DIZIA E NÃO ERA VERDADE: "não é um pager anônimo".
 * Era — pela DEMO. O token dela está no link da landing, ela cobra a partir de
 * um centavo e se confirma sozinha: duzentas cobranças de um centavo paginavam
 * o fundador, e o `/api/demo/reset` abria uma conta nova — e uma chave de alerta
 * nova — pra paginar de novo. Reproduzido; achado pelas duas revisões de
 * 2026-09-15. Agora:
 *
 *  · casa de DEMO não pagina. A decisão sai da CASA (`isDemoVenue`: casa de
 *    teste E recebedor mock, os dois), não do token do corpo — o token da demo
 *    é uma env, e um erro de digitação apontando pra mesa de verdade calaria os
 *    alertas DELA;
 *  · deduplicado NO BANCO por conta E geração do QR, uma vez a cada SEIS
 *    horas. Com quinze minutos, uma mesa mantida cheia re-paginava quatro vezes
 *    por hora e gastava os avisos do dia em três horas (as duas revisões de
 *    7a65e93). Pela geração porque girar o QR é o remédio: se o ataque volta na
 *    geração nova, isso é notícia, e pagina na hora;
 *  · no máximo TRÊS por casa por dia E POR TIPO — mesa e recarga têm orçamentos
 *    separados — e DOZE no total. Com um orçamento só por casa, um QR de mesa
 *    abria carteiras, gastava os três da casa em "RECARGAS PAUSADAS… a conta da
 *    mesa não é afetada" e então trancava a mesa, que ia só pro log
 *    (compliance MEDIUM-A de 3a10835);
 *  · orçamento cheio NUNCA é só log (#8): sai um aviso de SUSPENSÃO — da casa ou
 *    global —, repetido a cada seis horas enquanto houver disparo contido. E a
 *    vaga de deduplicação da conta VOLTA quando o orçamento recusa, pra que ela
 *    pagine assim que houver orçamento (segurança L-B de 3a10835);
 *  · toda vaga de alerta tomada VOLTA se o envio não sair — a ponte recusou OU
 *    uma reivindicação seguinte estourou —, cada uma no seu `try`, e esta
 *    instância recua: um minuto depois de falha, dez com o orçamento cheio, seis
 *    horas só depois de um envio que saiu (compliance LOW-A de 3a10835);
 *  · nomeia a CASA e a MESA, e avisa o custo do remédio. Nome e rótulo são
 *    TEXTO DO DONO indo pro pager crítico do fundador — ver `rotuloDoAviso`;
 *  · roda DEPOIS da resposta só quando a Vercel promete esperar — ver
 *    `responderEAvisar`.
 *
 * Pelo canal de alerta crítico do fundador, e não pelo de evento de dinheiro:
 * aquele rejeita `kind` desconhecido, e um evento próprio teria de ser aceito do
 * lado da Olímpia, na ponte — mudança em outro sistema que daqui não dá pra
 * verificar. Nunca lança.
 */
const ALERTAS_DE_TETO_POR_DIA = 12;
const ALERTAS_POR_CASA_POR_DIA = 3;
const JANELA_DO_AVISO_MS = 6 * 60 * 60 * 1000;
const RECUO_DO_AVISO_MS = 60 * 1000;
const RECUO_COM_ORCAMENTO_CHEIO_MS = 10 * 60 * 1000;
const UM_DIA_MS = 24 * 60 * 60 * 1000;
// Teto GLOBAL de avisos de suspensão por dia — ver o bloco da suspensão.
const SUSPENSOES_POR_DIA = 12;
const alertasRecentes = new Map(); // chave → "não tente antes de"; atalho local, não decisão

/**
 * TEXTO DO DONO no pager do fundador. Lista EXPLÍCITA: letras ASCII e as do
 * Latin-1 (português e espanhol cabem inteiros nela), dígitos ASCII, espaço e
 * `'&()#-`, depois de NFC, e quarenta caracteres; o `'?'` vem DEPOIS da
 * limpeza. A primeira versão aceitava qualquer letra do Unicode; a segunda,
 * qualquer letra da escrita latina — e a latina inteira ainda tem sósias:
 * ponto do meio (U+A78F), dois-pontos sobrescrito, `ǃ` e `ǀ`, letras de largura
 * cheia, numerais romanos. Uma varredura de pontos de código achou cada uma.
 * O que se confere são os ids, que vêm antes. (Segurança L3 de 7a65e93, L-C de
 * 3a10835, LOW-5 de 40d5c50.)
 */
function rotuloDoAviso(v) {
  const limpo = String(v == null ? '' : v).normalize('NFC')
    .replace(/[^A-Za-z0-9\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF '&()#-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...limpo].slice(0, 40).join('').trim() || '?';
}

async function devolverVagaDeAviso(claimId) {
  try {
    await store.releaseSlots(claimId);
  } catch (e) {
    process.stderr.write(`[teto] vaga de aviso não voltou: ${String(e && e.message).slice(0, 80)}\n`);
  }
}

/**
 * O QUE RODA DEPOIS DA RESPOSTA TEM DE PEDIR PRA VIVER. Na Vercel a função pode
 * ser congelada assim que a resposta termina; o `waitUntil` pede à plataforma
 * que espere a promessa, e o `return` deixa o chamador esperar também. (As duas
 * revisões de 7a65e93: segurança M1, compliance M2.)
 */
function depoisDaResposta(promessa) {
  waitUntil(promessa);
  return promessa;
}

/**
 * A VERCEL PROMETE ESPERAR? Ela publica o contexto da requisição — o `waitUntil`
 * dela — num símbolo global, e é dele que o `@vercel/functions` lê: sem ele, o
 * `waitUntil` do pacote não faz NADA, calado (`get-context.js` do pacote).
 *
 * SÓ o contexto decide. A versão anterior acreditava em `process.env.VERCEL`
 * primeiro: sem a variável, mandava a resposta antes e confiava no `waitUntil`
 * — que, sem contexto, é um no-op. Uma pré-condição opcional, e o ramo de
 * produção sem teste nenhum (segurança LOW-2 de 40d5c50). Fora da Vercel, sem
 * contexto, o aviso sai antes da resposta: só mais lento.
 */
function esperaDisponivel() {
  const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  return Boolean(ctx && typeof ctx.waitUntil === 'function');
}

/**
 * RESPONDE E AVISA, na ordem que entrega os dois. Com a espera garantida, a
 * recusa sai primeiro (esperar o aviso segurava o 429 até oito segundos) e o
 * aviso vive depois dela. SEM ela, na Vercel, "depois da resposta" é "talvez
 * nunca": o aviso vem ANTES, e uma linha diz por quê — lento e entregue vence
 * rápido e calado. Nada mostrava se o `waitUntil` roda em produção; esta linha
 * mostra quando ele não roda. (Segurança L-A de 3a10835.)
 */
let semEsperaAvisado = false;
async function responderEAvisar(enviar, err) {
  if (!esperaDisponivel()) {
    if (!semEsperaAvisado) {
      semEsperaAvisado = true;
      process.stderr.write('[teto] SEM waitUntil (sem contexto de requisição da Vercel): o aviso sai ANTES da resposta\n');
    }
    await avisarTetoDisparado(err);
    enviar();
    return;
  }
  enviar();
  await depoisDaResposta(avisarTetoDisparado(err));
}

async function avisarTetoDisparado(err) {
  if (!err) return;
  const tomadas = [];   // toda vaga de alerta reivindicada nesta chamada — volta se o envio não sair
  try {
    let chave; let tipo;
    if (err.code === 'too_many_pending_charges' && err.checkId) {
      chave = `alerta:check:${err.checkId}:${err.qrGeneration || '-'}`; tipo = 'mesa';
    } else if (err.code === 'too_many_pending_loads_venue' && err.venueId) {
      chave = `alerta:venue:${err.venueId}`; tipo = 'recarga';
    } else {
      return;
    }
    const agora = Date.now();
    if ((alertasRecentes.get(chave) || 0) > agora) return;
    if (alertasRecentes.size > 5000) alertasRecentes.clear();
    alertasRecentes.set(chave, agora + RECUO_DO_AVISO_MS);
    const venue = tipo === 'mesa'
      ? await store.getVenueForCheck(err.checkId)
      : await store.getVenue(err.venueId);
    if (isDemoVenue(venue)) return;
    const tomar = async (keys, limits, windowMs) => {
      const r = await store.claimSlots({ keys, limits, windowMs });
      if (r.claimId !== null) tomadas.push(r.claimId);
      return r;
    };
    const aviso = await tomar([chave], [1], JANELA_DO_AVISO_MS);
    if (aviso.claimId === null) return;
    const casaId = (venue && venue.id) || err.venueId || 'sem-casa';
    const doDia = await tomar([`alerta-dia:venue:${casaId}:${tipo}`, 'alerta-dia:global'],
      [ALERTAS_POR_CASA_POR_DIA, ALERTAS_DE_TETO_POR_DIA], UM_DIA_MS);
    // `nomeDaCasa`, e não o nome curto: um teste estrutural do app web acha a
    // emissão de `acceptsWallet` pela PRIMEIRA declaração da variável curta no
    // router, e a busca é por substring — este helper, mais acima, a sequestrava.
    const nomeDaCasa = rotuloDoAviso((venue && venue.name) || err.venueName);
    const rotuloDaMesa = rotuloDoAviso(err.tableLabel);
    let mensagem; let recuoAposEnvio = JANELA_DO_AVISO_MS;
    if (doDia.claimId !== null) {
      mensagem = tipo === 'mesa'
        ? `TETO DE COBRANÇAS DISPAROU — conta ${err.checkId} · casa ${nomeDaCasa} · mesa ${rotuloDaMesa}. Uma mesa legítima não chega a este número: provável script usando o QR dessa mesa. Remédio: girar o QR dessa mesa no painel — a geração nova tem teto próprio e o atacante perde o token. ANTES de girar: quem está no meio de um pagamento perde a tela de confirmação (o QR antigo para de responder), e cobranças abertas com o código antigo ainda podem cair — Pix por até 15 minutos, cartão ainda em confirmação talvez depois — e só aparecem no painel depois de confirmadas: antes de cobrar no caixa, espere esses 15 minutos ou pergunte na mesa se alguém já pagou. Feche a conta no Racha ANTES de cobrar o resto no caixa: pagamento que cair depois de a conta fechar fica marcado na mesa, no painel de pagamentos (/painel); se a mesa também pagou no caixa, é valor a devolver; se não, marque como resolvido. Enquanto a mesa estiver travada, ela paga no caixa.`
        : `RECARGAS PAUSADAS — casa ${casaId} · ${nomeDaCasa}: o teto de recargas da casa encheu, provável geração de contas de saldo em massa. A conta da mesa não é afetada.`;
    } else {
      // ORÇAMENTO CHEIO. A vaga da conta VOLTA — senão ela ficava calada seis
      // horas depois de o orçamento abrir — e esta instância recua dez minutos.
      await devolverVagaDeAviso(aviso.claimId);
      tomadas.splice(tomadas.indexOf(aviso.claimId), 1);
      alertasRecentes.set(chave, agora + RECUO_COM_ORCAMENTO_CHEIO_MS);
      recuoAposEnvio = RECUO_COM_ORCAMENTO_CHEIO_MS;
      const daCasa = doDia.fullIndex === 0;
      process.stderr.write(`[teto] aviso contido pelo orçamento ${daCasa ? `da casa (${ALERTAS_POR_CASA_POR_DIA}/dia de ${tipo})` : `global (${ALERTAS_DE_TETO_POR_DIA}/dia)`} — ${chave}\n`);
      // A SUSPENSÃO É DA CASA E DO TIPO, sempre — também quando quem recusou foi
      // o orçamento GLOBAL. Com uma chave global só, uma casa-isca tomava a vaga
      // de suspensão a cada seis horas e a casa atacada nunca era nomeada
      // (segurança LOW-1 de 40d5c50: 432 recusas em 72 h, zero páginas com o nome
      // dela). E por tipo porque uma suspensão de recarga calava a da mesa
      // (compliance MEDIUM-1 e segurança LOW-4 de 40d5c50).
      const suspensao = await tomar([`alerta:suprimido:venue:${casaId}:${tipo}`], [1], JANELA_DO_AVISO_MS);
      if (suspensao.claimId === null) return;
      // E um orçamento GLOBAL de suspensões. Por casa e tipo sem nada acima,
      // vinte casas criadas por quem se cadastra davam 160 páginas por dia no
      // canal do canário de conciliação (segurança MEDIUM-1 e compliance
      // MEDIUM-D de 497bf87). Esgotado, sai UM resumo a cada seis horas — ainda
      // nomeando a casa de agora — e o resto vai pro log.
      const doDiaSusp = await tomar(['alerta-dia:suspensoes'], [SUSPENSOES_POR_DIA], UM_DIA_MS);
      let resumo = false;
      if (doDiaSusp.claimId === null) {
        const doResumo = await tomar(['alerta:suprimido:resumo'], [1], JANELA_DO_AVISO_MS);
        if (doResumo.claimId === null) {
          process.stderr.write(`[teto] suspensão contida pelo orçamento de suspensões (${SUSPENSOES_POR_DIA}/dia) — ${chave}\n`);
          for (const v of tomadas) await devolverVagaDeAviso(v);
          return;
        }
        resumo = true;
      }
      const oQue = tipo === 'mesa' ? `conta ${err.checkId} · mesa ${rotuloDaMesa}` : 'recargas';
      const remedio = tipo === 'mesa'
        ? 'Remédio: girar no painel o QR de cada mesa travada; até lá, ela paga no caixa.'
        : 'As recargas da casa seguem pausadas; a conta da mesa não é afetada, e não há QR a girar.';
      mensagem = resumo
        ? `SUSPENSÕES EM MASSA — ${SUSPENSOES_POR_DIA} casas ou tipos de aviso já foram suspensos em 24 horas, e mais nenhuma suspensão por casa sai por aqui até a mais velha completar um dia. A de agora: casa ${casaId} · ${nomeDaCasa} (${oQue}). As outras aparecem nos logs da função, nas linhas "[teto]", e este resumo se repete a cada seis horas enquanto houver suspensão contida. Um volume assim é ataque coordenado, provavelmente com casas criadas pra isso.`
        : daCasa
        ? `AVISOS DA CASA SUSPENSOS — casa ${casaId} · ${nomeDaCasa}: ${ALERTAS_POR_CASA_POR_DIA} avisos de ${tipo} em 24 horas, e o teto disparou de novo (${oQue}). ${remedio} Os próximos desta casa só aparecem nos logs da função, nas linhas "[teto]", e este aviso se repete a cada seis horas enquanto houver disparo contido.`
        : `AVISOS DE TETO SUSPENSOS — casa ${casaId} · ${nomeDaCasa}: o orçamento GLOBAL de ${ALERTAS_DE_TETO_POR_DIA} avisos por dia acabou, e o teto desta casa disparou (${oQue}). ${remedio} Um volume assim é ataque em várias mesas ou casas ao mesmo tempo; os disparos contidos aparecem nos logs, nas linhas "[teto]", e este aviso se repete a cada seis horas por casa enquanto houver disparo contido.`;
    }
    const r = await notifyFounderReconcile({
      mensagem, venuesRed: 0, venuesChecked: 0, driftCents: 0, worstSeverity: 'critical',
    });
    if (r && r.ok === false) {
      for (const v of tomadas) await devolverVagaDeAviso(v);
      alertasRecentes.set(chave, agora + RECUO_DO_AVISO_MS);   // tenta de novo daqui a um minuto
      return;
    }
    alertasRecentes.set(chave, agora + recuoAposEnvio);
  } catch (e) {
    // Uma reivindicação SEGUINTE estourou: as anteriores voltam, senão a conta
    // ficava calada as seis horas da janela. (Compliance LOW-A de 3a10835.)
    for (const v of tomadas) await devolverVagaDeAviso(v);
    process.stderr.write(`[teto] aviso ao operador não saiu: ${String(e && e.message).slice(0, 80)}\n`);
  }
}

async function guardUser(req, res) {
  if (!auth) { json(res, 501, { success: false, error: 'auth não configurado' }); return null; }
  try { return await auth.requireUser(req); }
  catch (e) { json(res, e.statusCode || 401, { success: false, error: e.message }); return null; }
}

// Instance-local rate limit for the one public row-creating endpoint
// (house/open). Fluid Compute reuses instances, so this bites a scripted
// flood; the per-venue account cap in the service is the durable bound.
const openBuckets = new Map(); // ip → { count, resetAt }
// O PRIMEIRO elemento do X-Forwarded-For é escrito pelo cliente: `XFF: 1.2.3.<n>`
// dá um balde novo por request e o limite deixa de existir. O hop confiável é o
// ÚLTIMO (o proxy da Vercel), e x-real-ip quando presente (achado da revisão).
function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateLimitBucket(req, prefix, limit) {
  const key = `${prefix}:${clientIp(req)}`;
  const nowMs = Date.now();
  const b = openBuckets.get(key);
  if (!b || nowMs > b.resetAt) {
    openBuckets.set(key, { count: 1, resetAt: nowMs + 10 * 60 * 1000 });
    if (openBuckets.size > 10000) openBuckets.clear(); // memory bound
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}
/**
 * Texto vindo de fora, pronto pra uma linha de log.
 *
 * Sem controle nenhum, quem manda o corpo escreve o log: um `\n` no meio do
 * valor inventa uma linha inteira no rastro de auditoria do caminho do
 * dinheiro. Corta em 60 e joga fora tudo que não é caractere de nome de evento
 * (a Stripe e a Pagar.me usam `[a-z._]`), então nem escape nem tamanho passam.
 */
function sanitizeForLog(v) {
  return String(v).replace(/[^\w.:-]/g, '·').slice(0, 60);
}

function rateLimitOpen(req) {
  return rateLimitBucket(req, 'open', 10); // 10 wallet creations / 10 min / IP
}
/**
 * Balde PRÓPRIO pros crons.
 *
 * Os crons usavam o `rateLimitOpen`, que compartilha o prefixo 'open' com o
 * `/api/house/open`. Um salão inteiro é UM ip atrás do NAT do restaurante:
 * dez batidas sem auth em `/api/cron/reconcile-pending` daquele ip consumiam o
 * orçamento de abertura de carteira da casa por dez minutos. Um caminho não
 * autenticado derrubando outro. Achado pela revisão de segurança.
 */
function rateLimitCron(req) {
  return rateLimitBucket(req, 'cron', 20);
}
/**
 * Balde próprio pra demo pública.
 *
 * Mesmo problema dos crons: `/api/demo/beacon` e `/api/demo/reset` são sem
 * auth e batidas do mundo inteiro, e dividiam o prefixo 'open' com a abertura
 * de carteira. Alguém martelando a demo esgotava o orçamento de carteira de
 * um restaurante que por acaso saísse pelo mesmo ip.
 */
function rateLimitDemo(req) {
  return rateLimitBucket(req, 'demo', 30);
}
// A auto-cura da demo ESCREVE (venue/mesa/conta) numa rota sem auth. Em estado
// saudável é no-op; o limite existe pro estado degradado (achado MÉDIO).
/**
 * O `/api/check` NÃO tem limite de taxa. Tem TELEMETRIA de erro. A diferença é
 * o ponto inteiro, e a primeira versão disto errou nos dois lados.
 *
 * A rota é pública, sem autenticação, e o telefone na mesa a consulta a cada 4
 * segundos. A sugestão da revisão foi `('check', 240)`: 240 por 10 min por IP.
 * Faça a conta antes de aceitar. Um telefone a cada 4s são 15/min, 150 por
 * janela. **Dois telefones na mesma mesa estouram 240** — e um salão inteiro é
 * UM ip atrás do NAT do restaurante. Esse limite não protegeria nada que a
 * infra já não protege; ele fecharia a conta na cara do segundo cliente da
 * primeira mesa. É a mesma falha-fechada que quase mandou uma lista de origens
 * recusar toda mesa impressa, e por isso a aritmética fica escrita aqui: quem
 * for "endurecer" isto depois lê o número antes de mudar.
 *
 * A segunda versão contava ERRO em vez de requisição e devolvia 429 no 404
 * seguinte. Melhor, e ainda errado por três motivos que a revisão de segurança
 * mediu executando a rota:
 *
 *  1. **Não parava varredura nenhuma.** Trocar 404 por 429 é trocar um oráculo
 *     por outro: `200` continua significando "achei" e o atacante continua
 *     lendo a resposta. "A varredura para em 30" era uma frase sem teste.
 *  2. **Não poupava trabalho.** O `getCheckByQrToken` roda ANTES do balde, então
 *     a consulta acontecia de todo jeito. Nunca foi defesa de carga.
 *  3. **Era queimado por tráfego legítimo.** O app continuava consultando de 4
 *     em 4 segundos depois de a conta fechar, e todo poll virava MISS: um
 *     telefone esquecido na mesa gastava a cota em dois minutos, e atrás do
 *     CGNAT da operadora o próximo cliente lia "muitas tentativas" em vez de
 *     "conta não encontrada". A mesma falha-fechada que o balde existia pra
 *     evitar, pelo ramo do erro. (O app agora para o relógio no 404 — ver
 *     `App.tsx` —, mas isso conserta a causa, não o desenho.)
 *
 * E o motivo de fundo: `qr_token` é um uuid sem hífens, 122 bits de entropia
 * (migração 0001). Enumerar isso não é caro, é impossível. O controle defendia
 * de um ataque que não existe e cobrava o preço numa mesa de verdade.
 *
 * O que sobra é o que sempre foi útil: SABER. A resposta é idêntica — sempre
 * 404, sempre o mesmo corpo, nenhum sinal novo pra quem sonda — e o excesso
 * vira uma linha de log pra alertar. Medir não fecha porta nenhuma na cara de
 * ninguém.
 */
function registraMissDeCheck(req) {
  if (rateLimitBucket(req, 'checkmiss', 30)) return;
  // Passou de 30 erros em 10 min vindos do mesmo hop. Não muda a resposta.
  process.stderr.write(`[check-miss] ${sanitizeForLog(clientIp(req))} acima do esperado\n`);
}

function rateLimitDemoHeal(req) {
  return rateLimitBucket(req, 'demoheal', 6); // 6 auto-curas / 10 min / IP
}

/**
 * Cron sem CRON_SECRET = rota PÚBLICA (só rate limit por IP). Ler é inofensivo;
 * ENVIAR não é — um estranho poderia disparar WhatsApp/e-mail em rajada, pro
 * dono do restaurante ou pro fundador. Então o efeito colateral de saída exige
 * o segredo: sem ele o cron ainda calcula e responde, mas não manda nada.
 *
 * Lido a cada chamada (e não no load do módulo) pra que setar a env passe a
 * valer no próximo request, sem precisar de redeploy.
 */
function podeEnviarAviso() {
  return !!process.env.CRON_SECRET;
}


/** Compara `Authorization: Bearer <x>` com o segredo sem vazar tempo. */
function segredoConfere(header, secret) {
  const esperado = Buffer.from(`Bearer ${secret}`);
  const recebido = Buffer.from(String(header || ''));
  if (recebido.length !== esperado.length) return false;
  return crypto.timingSafeEqual(recebido, esperado);
}

// Confirm-on-read throttle: at most one PSP re-check per check per ~10s per
// instance (Fluid Compute reuse makes this bite). Stops a pending charge from
// firing a gateway call on every 4s diner poll while still healing fast.
const reconcileThrottle = new Map(); // checkId → nextAllowedMs
// O painel recarrega a cada 4s; conciliar o restaurante inteiro a cada recarga
// seria varrer o banco quinze vezes por minuto pra mostrar o mesmo verde. Uma
// vez por minuto por casa mantém o número honesto e o custo no chão.
const panelReconThrottle = new Map(); // venueId → { at, result }
function panelReconcileCached(venueId) {
  const hit = panelReconThrottle.get(venueId);
  if (hit && Date.now() - hit.at < 60_000) return hit.result;
  return null;
}
function panelReconcileStore(venueId, result) {
  if (panelReconThrottle.size > 500) panelReconThrottle.clear();
  panelReconThrottle.set(venueId, { at: Date.now(), result });
}
function shouldReconcileNow(checkId) {
  const now = Date.now();
  if (now < (reconcileThrottle.get(checkId) || 0)) return false;
  if (reconcileThrottle.size > 5000) reconcileThrottle.clear(); // memory bound
  reconcileThrottle.set(checkId, now + 10_000);
  return true;
}

async function writeBackToPos(checkId) {
  try {
    const venue = await store.getVenueForCheck(checkId);
    if (!venue) return;
    const adapter = resolvePosAdapter(venue);
    if (!adapter.capabilities.writeBack) return;
    await adapter.writeBackPayment({ venue, checkId });
  } catch (err) {
    process.stderr.write(`writeBackToPos(${checkId}) failed (non-fatal): ${err.message}\n`);
  }
}

/**
 * Avisa, e NUNCA derruba o webhook por contrato quebrado.
 *
 * `notifyFounderMoneyEvent` estoura num `kind` fora da lista — disciplina certa
 * pros call sites literais, onde um teste pega antes do deploy. Nos três sites
 * de WEBHOOK o `kind` vem do adaptador, então um evento novo estouraria em
 * produção: o registro durável já foi gravado, a requisição devolveria 500, o
 * adquirente reentregaria por dias e acabaria DESLIGANDO o endpoint — o que
 * para `payment_confirmed` de todas as mesas, não só o alerta perdido.
 *
 * Então só o erro MARCADO é engolido, e alto. Falha de entrega continua subindo
 * como antes: o silêncio que duas rodadas removeram não volta por aqui.
 */
async function avisarEventoDeDinheiro(evento) {
  try {
    return await notifyFounderMoneyEvent(evento);
  } catch (e) {
    if (e && e.code === 'kind_desconhecido') {
      process.stderr.write(`MONEY EVENT ALERT (kind desconhecido '${sanitizeForLog(evento.kind)}'): ${sanitizeForLog(evento.txid)}\n`);
      return { ok: false, skipped: 'kind_desconhecido' };
    }
    throw e;
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') return json(res, 200, {});
    if (PLATAFORMA_QUEBRADA() && ROTA_DE_DINHEIRO(url.pathname)) {
      return json(res, 503, { success: false, code: 'platform_misconfigured' });
    }

    // --- diner (public) ------------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/api/check') {
      const token = url.searchParams.get('t') || '';
      let data = await store.getCheckByQrToken(token);
      // A mesa da demo se auto-cura: sem mesa (ambiente novo) ou com a conta
      // fechada (alguém pagou tudo), reabre — o telefone da landing nunca mostra
      // "conta não encontrada". Só o token fixo da demo; nunca uma mesa real.
      if (!data && token === DEMO_TABLE_TOKEN && rateLimitDemoHeal(req)) {
        try { data = await ensureDemoCheck(store, token); } catch (e) {
          process.stderr.write(`[demo-ensure] ${String(e.message).slice(0, 120)}\n`);
        }
      }
      if (!data) {
        // Só o acerto sai daqui diferente. Ver `registraMissDeCheck`.
        registraMissDeCheck(req);
        return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
      }
      // Confirm-on-read: heal a missed webhook. If money is still owed, re-ask
      // the PSP about this check's pending charges (throttled per check,
      // best-effort — a slow/absent gateway must NEVER break the read). The
      // diner is already polling every 4s, so a dead webhook still resolves in
      // seconds. Demo self-confirms via its own mock → skip it.
      if (token !== DEMO_TABLE_TOKEN && data.state && data.state.paidCents < data.state.totalCents
          && shouldReconcileNow(data.check.id)) {
        try {
          const r = await reconciler.reconcile({ checkId: data.check.id });
          if (r.confirmed > 0) {
            data = (await store.getCheckByQrToken(token)) || data;
            // Curada AQUI → sai do conjunto pendente e o cron nunca mais a vê.
            // O write-back pro POS tem que sair deste caminho, senão o balcão
            // fica achando que a mesa ainda deve (review finding).
            await writeBackToPos(data.check.id);
          }
        } catch (e) {
          process.stderr.write(`[reconcile-on-read] ${String(e.message).slice(0, 100)}\n`);
        }
      }
      // Sinaliza pro diner se o restaurante aceita cartão/Apple Pay (tem conta
      // Stripe conectada). Só consulta o venue quando o Stripe está ligado — em
      // prod hoje stripePsp é null → nenhuma chamada extra, a flag fica ausente.
      // A mesa de demonstração se declara PRA UI: sem isto o rail de carteira
      // abre a folha OFICIAL do Google Pay (ambiente PRODUCTION, merchant real)
      // e pede CPF de verdade pra uma conta que não existe — autorização obtida
      // sob premissa falsa (CDC 6º III/37) e CPF sem base legal (LGPD).
      // Achado CRÍTICO da revisão de compliance.
      if (token === DEMO_TABLE_TOKEN) {
        data = { ...data, venue: { ...data.venue, demo: true } };
      }
      // UMA consulta pras duas bandeiras. Eram duas idênticas na mesma
      // requisição — e `/api/check` é público, sem limite de taxa, consultado a
      // cada 4 segundos por cada telefone da mesa. Amplificação constante de
      // trabalho já sem teto, no caminho crítico de quem está pagando.
      const casa = token !== DEMO_TABLE_TOKEN ? await store.getVenueForCheck(data.check.id) : null;
      if (stripePsp && casa && casa.stripeAccountId && /^acct_/.test(casa.stripeAccountId)) {
        data = { ...data, venue: { ...data.venue, acceptsCard: true } };
      }
      // A CARTEIRA (Google Pay) pelo mesmo contrato do cartão: quem declara é
      // o SERVIDOR, por casa.
      //
      // O cliente ligava a carteira só na chave de BUILD
      // (`VITE_PAGARME_PUBLIC_KEY`), que não é propriedade de casa nenhuma —
      // então TODA conta brasileira injetava `pay.google.com/gp/p/js/pay.js` e
      // chamava `isReadyToPay`, uma sondagem de aparelho, antes de a pessoa
      // escolher qualquer coisa. Duas linhas abaixo, no mesmo arquivo, o
      // cartão exigia chave de build E bandeira do servidor. A assimetria não
      // foi decidida: a Stripe ganhou o conserto do incidente de 2026-09-07 e
      // o Google Pay não. Achado das duas revisões de 2026-09-10.
      //
      // A carteira liquida pelo gateway `pagarme`, então a condição é a mesma
      // que permite cobrar: recebedor de verdade nesta casa.
      //
      // `r[ep]_`, não `re_`: é a MESMA forma que o `pagarme-psp.js` aceita pra
      // cobrar e que o `setupComplete` usa pra dizer que a casa está pronta.
      // A primeira versão desta linha divergiu pra `re_`, o que deixava uma
      // casa legada `rp_` cobrando normalmente e sem carteira — falha fechada,
      // então não era buraco, mas é a forma "cópia divergente" que aparece
      // depois como "o Google Pay parou de funcionar num restaurante só".
      if (casa && /^r[ep]_/.test(casa.pspRecipientId || '')) {
        data = { ...data, venue: { ...data.venue, acceptsWallet: true } };
      }
      // O estado sai PROJETADO. `/api/check` é público — quem tem o QR da mesa
      // lê, sem login — e devolvia o estado reduzido inteiro: motivo de disputa
      // vindo do esquema, prazo de prova, e a nota de texto livre que o dono
      // escreve pra encerrar uma pendência ("reembolsei o Pedro no Pix
      // 11 98765-4321"). Ver `_lib/checks/public-state`.
      return json(res, 200, { success: true, data: { ...data, state: publicCheckState(data.state) } });
    }
    if (req.method === 'POST' && url.pathname === '/api/pay') {
      const body = JSON.parse(await readBody(req) || '{}');
      // TOKEN É STRING. Um `["<tok>"]` a PostgREST resolve (ela monta o filtro com
      // interpolação) e o `Map` do gêmeo não — então os testes não viam: o pedido
      // achava a mesa em produção, a geração do QR saía nula e o teto caía na
      // chave sem geração, um SEGUNDO balde; na demo, desligava o `isDemo`.
      // (Segurança stand-in, LOW-1.)
      if (typeof body.token !== 'string') return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
      const view = await store.getCheckByQrToken(body.token);
      if (!view) return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
      // Demo isolado: a mesa de demonstração cobra pelo MockPsp próprio, nunca
      // pelo PSP real — dinheiro fake mesmo com o app em live.
      const isDemo = body.token === DEMO_TABLE_TOKEN;
      // A DEMO É PÚBLICA — o token está no link da landing — e cobra a partir de
      // um centavo. Sem limite, qualquer um enchia o teto dela e deixava a
      // demonstração de vendas respondendo 429. (Compliance e segurança, HIGH.)
      if (isDemo && !rateLimitDemo(req)) return json(res, 429, { success: false, code: 'demo_busy' });
      // O trilho pedido, e nada de conferir mercado AQUI: quem confere é o
      // `marketGate` dentro do `create-charge`, que é o portão de dinheiro
      // compartilhado — e os dois serviços (`charge` e `demoCharge`) saem da
      // mesma fábrica, então os dois passam por ele.
      //
      // Esta rota tinha uma cópia de DOIS dos quatro portões, e na ordem
      // errada: `supportsRail` antes do interruptor do mercado, então uma mesa
      // espanhola com a Espanha desligada respondia `rail_unsupported` — que
      // conta que o mercado existe e quais trilhos ele serve — em vez de
      // `market_not_live`. A cópia existia só porque o catch geral perdia o
      // `code`; agora não perde.
      const payRail = body.rail === 'bizum' ? 'bizum' : 'pix';
      let result;
      try {
        result = await (isDemo ? demoCharge : charge)({
          checkId: view.check.id, amountCents: body.amountCents,
          // O teto conta por conta E pela geração do QR — ver `geracaoDoQr`.
          qrGeneration: geracaoDoQr(body.token || ''),
          tipCents: body.tipCents ?? 0, payerLabel: body.payerLabel ?? null, rail: payRail,
          // Apple/Google Pay: tokenized card charge pelo mesmo portão de dinheiro.
          wallet: body.wallet ?? null, paymentToken: body.paymentToken ?? null,
          // CPF. O gateway exige `customer.document` no PIX TAMBÉM, não só em
          // cartão: a doc do Pagar.me lista name/email/document/phones como
          // obrigatórios pra criar a cobrança Pix (docs.pagar.me/reference/pix-2,
          // conferido 2026-09-07). O comentário antigo dizia "em cartão" e fez a
          // exigência parecer coleta excessiva numa revisão — é o mínimo pra
          // emitir a cobrança, que é a base legal do art. 6º III da LGPD
          // (necessidade, execução de contrato). O app não guarda o número:
          // `registerCharge` não persiste, e webhook com CPF passa por maskTaxId.
          payerDocument: body.payerDocument ?? null,
        });
      } catch (e) {
        // O aviso ao operador nomeia a CASA e a MESA — só um UUID obrigava a uma
        // consulta e um telefonema. (Compliance, M3.)
        if (e && e.code === 'too_many_pending_charges') {
          e.venueName = view.venue && view.venue.name; e.tableLabel = view.table && view.table.label;
        }
        throw e;
      }
      // O demo se auto-paga: sem Simulador nem webhook externo em live, o próprio
      // MockPsp assina a confirmação e o handler do demo credita o ledger — a
      // "conta de mentira" fecha na hora, sem tocar dinheiro real.
      if (isDemo && result.txid) {
        try {
          const { rawBody, signature } = demoPsp.buildConfirmationWebhook({
            txid: result.txid, amountCents: result.amountCents, tipCents: result.tipCents,
            payerName: body.payerLabel || 'Cliente Demo', payerCpf: '390.533.447-05',
            method: result.method,
          });
          await demoWebhook(rawBody, { 'x-racha-signature': signature });
        } catch (e) {
          process.stderr.write(`[demo] auto-confirm falhou: ${String(e.message).slice(0, 120)}\n`);
        }
      }
      return json(res, 200, { success: true, data: result });
    }

    // --- cartão / Apple Pay (Stripe, 2º rail) — cria o PaymentIntent ---------
    // Devolve o clientSecret; o front confirma com a carteira (Express Checkout
    // Element) e a confirmação chega pelo /api/webhooks/stripe. Inerte sem
    // STRIPE_SECRET_KEY (503) ou sem conta Stripe no venue (400). Mesmos portões
    // de dinheiro do Pix (espelha create-charge): nunca passa do que falta.
    if (req.method === 'POST' && url.pathname === '/api/pay/stripe-intent') {
      if (!stripePsp) return json(res, 503, { success: false, error: 'cartão/Apple Pay indisponível — Stripe não configurado' });
      const b = JSON.parse(await readBody(req) || '{}');
      if (typeof b.token !== 'string') return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
      if (b.token === DEMO_TABLE_TOKEN) return json(res, 400, { success: false, error: 'a demo não usa cartão' });
      const view = await store.getCheckByQrToken(b.token);
      if (!view) return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
      const venue = await store.getVenueForCheck(view.check.id);
      if (!venue || !venue.stripeAccountId || !/^acct_/.test(venue.stripeAccountId)) {
        return json(res, 400, { success: false, error: 'este restaurante ainda não aceita cartão', code: 'no_card' });
      }
      const amountCents = b.amountCents;
      const tipCents = b.tipCents ?? 0;
      if (!Number.isSafeInteger(amountCents) || amountCents < 0) return json(res, 400, { success: false, error: 'amountCents inválido', code: 'amount_invalid' });
      if (!Number.isSafeInteger(tipCents) || tipCents < 0) return json(res, 400, { success: false, error: 'tipCents inválido' });
      if (amountCents + tipCents === 0) return json(res, 400, { success: false, error: 'cobrança de valor zero', code: 'zero_charge' });
      // O RÓTULO É CONFERIDO ANTES DA VAGA E ANTES DA STRIPE. Só o
      // `registerCharge` conferia, e ele roda DEPOIS de a Stripe criar o
      // intent: um rótulo de 61 caracteres gastava uma vaga do teto e deixava
      // um PaymentIntent que o `payments` não conhece. Mesma regra da fábrica,
      // mesma função. Revisão de compliance de 2026-09-15 (MEDIUM-1).
      if (!payerLabelValido(b.payerLabel)) {
        // Só o código: quem traduz é o cliente. (Compliance LOW-4 de 7a65e93.)
        return json(res, 400, { success: false, code: 'payer_label_invalid' });
      }
      const state = reduce(await store.loadEvents(view.check.id));
      if (!state || state.status === 'fechada') return json(res, 400, { success: false, error: 'conta fechada', code: 'check_closed' });
      const remaining = remainingCents(state);
      if (amountCents > remaining) return json(res, 400, { success: false, error: `valor acima do que falta (${remaining} centavos)`,
        // Centavos crus, não texto formatado: quem escolhe "R$ 12,34" ou
        // "R$ 12.34" é o cliente, que sabe o idioma. Servidor não formata dinheiro.
        code: 'amount_over', vars: { leftCents: remaining } });
      // Qual trilho, e o MERCADO decide se ele é legal nesta mesa. Um Bizum
      // numa mesa brasileira cobraria em euro; um cartão pelo caminho do Bizum
      // usaria o Payment Element errado. O cliente pede, o servidor confere.
      const rail = b.rail === 'bizum' ? 'bizum' : 'card';
      // TODOS os portões do mercado, pela mesma função do `create-charge`.
      //
      // Esta rota tinha só DOIS deles — trilho e limites — e é a única que cria
      // cobrança de Bizum. Faltavam o interruptor da Espanha e o portão de
      // gorjeta, porque as regras estavam copiadas em dois lugares e um dos
      // dois ficou para trás (revisão de compliance, 2026-09-07).
      //
      // O que passava por aqui: com `STRIPE_SECRET_KEY` no ambiente, virar o
      // `market` de uma venue pra 'es' no banco fazia sair uma cobrança
      // espanhola DE VERDADE — antes do parecer sobre a retenção de disputa de
      // 120 dias e antes da papelada de transferência do GDPR. O teste que
      // provava o "falha fechado" só exercitava o `create-charge`, então o
      // buraco era invisível pro `npx jest`. Inegociável #7, na letra: a
      // guarda que nunca dispara no caminho que importa.
      const gate = marketGate(venue.market, { rail, amountCents, tipCents, venue });
      if (gate) {
        return json(res, 400, { success: false, error: `mercado ${venue.market}: ${gate.code}`, ...gate });
      }
      let devolverVaga = null;
      let pspChamado = false;
      try {
        // O TETO DE PENDENTES VIVAS, e ANTES da chamada ao adquirente. Esta
        // rota monta a cobrança sozinha — não passa pela fábrica —, então o
        // portão que mora lá não vale aqui por herança. É a mesma forma
        // "chamador esquecido" que já custou o portão de mercado e a validação
        // do `payerLabel` nesta exata rota; um teste estrutural exige o
        // emparelhamento. Ver `assertChargeSlot`.
        devolverVaga = await assertChargeSlot(store, view.check.id, geracaoDoQr(b.token));
        const chargeRef = `${view.check.id}:${state.paidCents}:${amountCents}:${tipCents}`;
        // Daqui em diante a Stripe pode ter criado um intent: a vaga fica.
        pspChamado = true;
        const charge = rail === 'bizum'
          ? await stripePsp.createBizumCharge({
            chargeRef, amountCents, tipCents,
            recipientId: venue.stripeAccountId,
          })
          : await stripePsp.createWalletCharge({
            chargeRef, amountCents, tipCents,
            recipientId: venue.stripeAccountId,
            wallet: b.wallet ?? null, payerDocument: b.payerDocument ?? null,
            // A moeda é do MERCADO — ver `createWalletCharge`. Faltava aqui e
            // no `create-charge`, e o padrão do adaptador cobria os dois.
            currency: pspCurrency(venue.market),
          });
        await store.registerCharge({
          checkId: view.check.id, txid: charge.txid, amountCents, tipCents,
          // Bizum NÃO é cartão: rotular errado aqui contamina o painel, a
          // ativação por método e a conciliação. É pagamento em tempo real,
          // como o Pix — mesma família, moeda diferente.
          payerLabel: b.payerLabel ?? null, method: rail === 'bizum' ? 'bizum' : 'card',
        });
        // O método na resposta é o TRILHO, não 'card' fixo. O `registerCharge`
        // logo acima já gravava 'bizum' certo, e a resposta dizia 'card' —
        // duas verdades sobre a mesma cobrança, e a tela lê a errada.
        return json(res, 200, { success: true, data: { txid: charge.txid, clientSecret: charge.clientSecret, amountCents, tipCents, method: rail === 'bizum' ? 'bizum' : 'card' } });
      } catch (e) {
        // A Stripe recusa fora dos limites do esquema com os SEUS códigos e uma
        // frase em INGLÊS — confirmado no sandbox: `amount_too_small` /
        // "Amount must be no less than 0.50 EUR". Se a nossa pré-checagem for
        // contornada (ou se a Stripe mudar os limites), o diner leria a frase
        // da Stripe crua. Traduz pro nosso código, que o cliente formata na
        // moeda dele.
        const mapped = e && e.code === 'amount_too_small' ? 'amount_under_min'
          : e && e.code === 'amount_too_large' ? 'amount_over_max'
          : null;
        if (mapped) {
          const lim = market(venue.market).charge;
          return json(res, 400, {
            success: false, error: e.message, code: mapped,
            vars: mapped === 'amount_under_min' ? { minCents: lim.minCents } : { maxCents: lim.maxCents },
          });
        }
        // CÓDIGO E `vars`, NÃO A FRASE INTERNA. Esta linha devolvia só
        // `e.message`, e o `errorBody` — que existe pra isto e diz no próprio
        // docblock que "com CÓDIGO a mensagem interna NÃO viaja" — nunca era
        // alcançado, porque esta rota tem catch próprio. O resultado, medido:
        // um cliente pagando no cartão em São Paulo, ou no Bizum em Madri,
        // lia `too many live pending charges for this check (20)` na tela de
        // pagamento — inglês interno, com a contagem de cobranças vivas dos
        // OUTROS na mesa. A chave `err.too_many_pending_charges` que o commit
        // do teto acrescentou não disparava em trilho nenhum além do Pix.
        // Achado pela revisão de compliance de 2026-09-15 (HIGH-2).
        if (e && e.code === 'too_many_pending_charges') {
          e.venueName = view.venue && view.venue.name; e.tableLabel = view.table && view.table.label;
        }
        // A recusa e o aviso, na ordem que entrega os dois — ver `responderEAvisar`.
        await responderEAvisar(() => json(res, errorStatus(e), errorBody(e), cabecalhoDeEspera(e)), e);
        return;
      } finally {
        // A vaga volta SÓ se a Stripe nem foi chamada — ver `assertChargeSlot`.
        if (devolverVaga && !pspChamado) await devolverVaga();
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/psp') {
      const raw = await readBody(req);
      // Toda chegada de webhook fica visível nos logs — diagnóstico de
      // entrega (Pagar.me chamou? com auth? qual evento?) sem adivinhação.
      // O tipo vem de corpo NÃO AUTENTICADO — este log é escrito ANTES da
      // verificação. Sem limpar, um `"type":"x\n[webhook] out status=appended"`
      // forja linhas de log no rastro de auditoria do caminho do dinheiro.
      // Achado pela revisão de segurança de 2026-09-08.
      let evtType = '?';
      try {
        const cru = JSON.parse(raw);
        evtType = sanitizeForLog(cru.type || cru.kind || '?');
      } catch { /* corpo opaco */ }
      process.stderr.write(`[webhook] in type=${evtType} auth=${req.headers.authorization ? 'sim' : 'não'} bytes=${raw.length}\n`);
      // Headers inteiros: o mock pega x-racha-signature, o Pagar.me valida o
      // Basic Auth do endpoint (e re-busca a cobrança na API de todo jeito).
      let result;
      try {
        result = await handleWebhook(raw, req.headers);
      } catch (err) {
        process.stderr.write(`[webhook] out threw=${err.name}: ${String(err.message).slice(0, 80)}\n`);
        throw err; // segue pro mapa de status do catch externo (401 etc.)
      }
      process.stderr.write(`[webhook] out status=${result.status}${result.reason ? ` reason=${sanitizeForLog(result.reason || '')}` : ''}\n`);
      if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
        await writeBackToPos(result.checkId);
      }
      /**
       * Cobrança que FALHOU: a linha sai de `pendente`, e só isso.
       *
       * `payment_failed` está em `NON_LEDGER_KINDS` porque nenhum dinheiro se
       * moveu — mas o despacho por conjunto logo abaixo o trataria como
       * "evento de dinheiro que o razão não sabe lançar" e deixaria uma
       * anomalia CRÍTICA numa conta onde nada está errado: um Pix que expirou
       * é rotina. A Pagar.me não emite este tipo hoje; a armadilha estava
       * armada pro dia em que emitir. Achado pela revisão de compliance de
       * 2026-09-08.
       */
      if (result.status === 'payment_failed' && result.txid) {
        const expirou = await store.expirePaymentIfPending(result.txid);
        return json(res, 200, {
          success: true,
          data: { status: result.status, txid: result.txid, expired: expirou },
        });
      }
      // Evento de dinheiro sem lançamento: anomalia no razão + aviso. Não
      // gravado NEM avisado é 503, pra Pagar.me reenviar — perder o evento em
      // silêncio é o que o inegociável #8 proíbe.
      if (NON_LEDGER_KINDS.has(result.status)) {
        const marca = await handleNonLedgerMoneyEvent(result, { psp: 'pagarme' });
        /**
         * Quem decide o reenvio é `needsRetry`, e ele mora num lugar só.
         *
         * A regra é: o que vale é o registro DURÁVEL, não o aviso — o aviso
         * degrada pra stderr sem `RACHA_NOTIFY_SECRET` e a anomalia não. Uma
         * falha de gravação costuma ser PERSISTENTE (um CHECK recusando o tipo
         * do evento, uma permissão), do jeito que a produção recusou três
         * tipos por doze dias — e nesse estado todo cancelamento parcial saía
         * 200, a Pagar.me nunca reenviava, e o único vestígio era uma mensagem
         * de chat com a conciliação verde por cima do dinheiro que saiu.
         *
         * Esta rota já tinha sido corrigida; a da Stripe ficou com a versão
         * antiga, e o teste que guardava a regra recortava o arquivo entre as
         * duas rotas, então era estruturalmente incapaz de ver a segunda
         * cópia. Agora é uma função e um censo.
         */
        if (needsRetry(marca)) {
          process.stderr.write(`[webhook] ${result.status} SEM registro e SEM aviso — devolvendo 503 pra reenvio\n`);
          return json(res, 503, {
            success: false, code: 'money_event_unrecorded',
            data: { status: result.status, txid: result.txid || null },
          });
        }
        // O eco vai MASCARADO: o corpo cru do Pagar.me traz documento do
        // pagador e payload do Pix, e `raw` saía inteiro na resposta.
        return json(res, 200, {
          success: true,
          data: { status: result.status, type: result.type || null, txid: result.txid || null },
        });
      }
      const status = result.status === 'rejected' ? 409 : 200;
      return json(res, status, { success: status === 200, data: result });
    }

    // --- webhook do Stripe (2º rail) — confirmação de cartão/Apple Pay --------
    // Verifica a assinatura Stripe (constructEvent, sobre os BYTES CRUS) e cai
    // no MESMO applyConfirmedPayment do Pix. Inerte sem STRIPE configurado.
    // ⚠️ Ao ligar em prod: garantir corpo CRU (Vercel bodyParser off nesta rota)
    // — o Stripe assina os bytes; um req.body re-serializado quebra a assinatura.
    if (req.method === 'POST' && url.pathname === '/api/webhooks/stripe') {
      if (!stripePsp) return json(res, 503, { success: false, error: 'stripe não configurado' });
      const raw = await readBody(req);
      process.stderr.write(`[stripe-webhook] in bytes=${raw.length} sig=${req.headers['stripe-signature'] ? 'sim' : 'não'}\n`);
      let result;
      try {
        const parsed = await stripePsp.verifyAndParseWebhook(raw, req.headers);
        // Evento válido que não move o nosso ledger: 200 e pronto. Não pode
        // virar 401 — a Stripe reenvia, depois desabilita o endpoint, e aí
        // perdemos os eventos que IMPORTAM junto com os que não importam.
        if (parsed.kind === 'ignored') {
          return json(res, 200, { success: true, data: { status: 'ignored', type: parsed.type } });
        }
        // O reembolso que FALHOU saiu daqui e virou lançamento.
        //
        // O comentário antigo dizia "é só alerta, porque o estorno não
        // aconteceu e inventar um evento seria mentir no razão". Isso está
        // certo pro caso síncrono e INVERTIDO pro assíncrono, que é o do
        // Bizum: a Stripe incrementa `amount_refunded` quando o estorno é
        // CRIADO, então o `charge.refunded` já entrou e o razão já diz
        // "estornado". Quando o `refund.failed` chega, o dinheiro voltou pro
        // restaurante e o cliente ficou sem — e não havia como desfazer.
        //
        // O resultado era o pior possível: cliente com dinheiro a receber, os
        // dois registros nossos dizendo que ele foi pago, e a conciliação
        // comparando um com o outro, concordando, e reportando VERDE. Agora
        // vira PAYMENT_REFUND_REVERSED pelo aplicador, com anomalia.
        //
        // Disputa continua aqui: ela não move saldo (o dinheiro é do
        // restaurante até o esquema decidir) mas É evento de razão pelo
        // inegociável #6 — sem ela no log, o estorno de noventa dias depois
        // não tem antecedente nenhum.
        if (parsed.kind === 'dispute_opened' || parsed.kind === 'refund_progress'
            || parsed.kind === 'unusable_money_event' || parsed.kind === 'dispute_updated'
            || parsed.kind === 'dispute_funds' || parsed.kind === 'account_alert') {
          const found = await store.findCheckByTxid(parsed.txid);
          let persistido = false;
          if (parsed.kind === 'dispute_opened' && found) {
            try {
              await appendValidated(store, found.id, 'PAYMENT_DISPUTED', {
                txid: parsed.txid, amountCents: parsed.amountCents, reason: parsed.reason || null,
                // O PRAZO DE PROVA vai pro log. 40 dias corridos no Bizum, e
                // perder o prazo é perder o dinheiro por inação — então ele
                // precisa estar num lugar que o job diário lê, não só num
                // alerta que degrada pra stderr sem `RACHA_NOTIFY_SECRET`.
                dueBy: parsed.dueBy || null, status: parsed.status || null,
              // O id do evento fecha a idempotência no append (migração 0018).
              // Sem ele, a reentrega de `charge.dispute.created` — que o 503
              // logo abaixo provoca de propósito — grava um segundo
              // PAYMENT_DISPUTED e DOBRA `disputedAmountCents`.
              }, parsed.eventId || null);
              persistido = true;
            } catch (e) {
              // NÃO engole. Gravar a disputa é gravar o PRAZO DE PROVA, e um
              // 200 aqui diz pra Stripe "recebido" sobre um prazo que se
              // perdeu — 40 dias que ninguém vai contar. `persistido` fica
              // falso e o 503 lá embaixo faz a Stripe tentar de novo.
              process.stderr.write(`[stripe-webhook] disputa não gravada: ${String(e.message).slice(0, 120)}\n`);
            }
          }
          // O prazo também chega em `dispute.updated` — a Stripe manda mudança
          // de prazo por lá, e persistir só na abertura fazia uma prorrogação
          // virar `dispute_evidence_overdue` crítico falso.
          if (parsed.kind === 'dispute_updated' && found && parsed.dueBy) {
            try {
              await appendValidated(store, found.id, 'PAYMENT_DISPUTED', {
                txid: parsed.txid, amountCents: 0, reason: parsed.reason || null,
                dueBy: parsed.dueBy, status: parsed.status || null,
              }, parsed.eventId || null);
              persistido = true;
            } catch (e) {
              process.stderr.write(`[stripe-webhook] prazo não atualizado: ${String(e.message).slice(0, 120)}\n`);
            }
          }
          /**
           * O que NÃO virou lançamento também deixa marca DURÁVEL no razão.
           *
           * `unusable_money_event`, `account_alert` e `dispute_funds` saíam
           * daqui só com alerta — e alerta degrada pra stderr sem
           * `RACHA_NOTIFY_SECRET`. É o mesmo defeito que o `non-ledger.js`
           * fechou no trilho do Pix, deixado de pé no outro. A abertura e a
           * atualização de disputa persistem acima com o PRAZO, que é o que
           * importa nelas — mas SÓ quando o txid resolve pra uma conta. Eu
           * tinha excluído as duas espécies daqui por causa disso, e assim um
           * chargeback aberto contra um txid que a gente não reconhece não
           * ganhava anomalia, nem linha de órfão, e saía 200: a única forma que
           * a migração 0024 existe pra fechar, deixada aberta no trilho onde
           * chargeback acontece de verdade. A gravação do órfão é idempotente
           * por `psp_event_id`, então passar por aqui de novo não duplica nada.
           * Achado pelas revisões de 2026-09-08.
           */
          let marcaNaoLancavel = null;
          if (!persistido) {
            marcaNaoLancavel = await handleNonLedgerMoneyEvent({
              status: parsed.kind, type: parsed.type || null, txid: parsed.txid || null,
              raw: parsed,
            }, { alert: false, psp: 'stripe' }); // o aviso sai abaixo, com a conta conectada
            persistido = marcaNaoLancavel.persisted;
          }
          if (parsed.kind !== 'refund_progress') {
            await avisarEventoDeDinheiro({
              kind: parsed.kind, txid: parsed.txid, checkId: found ? found.id : null,
              amountCents: parsed.amountCents,
              // O TIPO do evento vai no detalhe: `account_alert` cobre repasse
              // que falhou, capacidade virando inativa e aviso precoce de
              // fraude, e cada um pede uma ação diferente. Sem o tipo, o alerta
              // diz "algo de conta aconteceu".
              // O tipo E a conta conectada. `payout.failed` sem o nome do
              // restaurante não é acionável — "um repasse falhou" não diz de
              // quem. O `accountId` vem de `event.account`.
              detail: [parsed.type || parsed.reason || parsed.status || null,
                parsed.accountId ? `acct=${parsed.accountId}` : null]
                .filter(Boolean).join(' '),
            });
          }
          /**
           * Evento de dinheiro que não foi gravado NEM avisado é 503.
           *
           * O alerta do fundador degrada: sem `RACHA_NOTIFY_SECRET` devolve
           * `{skipped:true}` e escreve em stderr, e engole qualquer falha de
           * rede. Então uma variável de ambiente ausente transformava um
           * CHARGEBACK numa linha de log que a Stripe nunca reenvia — "um
           * canário vermelho pageia, nunca só loga" (inegociável #8),
           * invertido. Achado pela revisão de segurança de 2026-09-08.
           *
           * 503 faz a Stripe tentar de novo. Sim, reenvio repetido acaba
           * desabilitando o endpoint — mas isso é uma falha RUIDOSA, e a
           * alternativa é perder o evento em silêncio. Entre as duas, o
           * inegociável #8 escolhe o barulho.
           *
           * `refund_progress` fica fora: é estado intermediário de um estorno
           * que ainda vai terminar em `succeeded` ou `failed`, e os dois têm
           * tratamento próprio.
           */
          // A MESMA regra do trilho do Pix, pela mesma função: o que decide o
          // reenvio é o registro durável. Aqui estava `!persistido && !avisado`
          // — e com `RACHA_NOTIFY_SECRET` configurado, que é o estado
          // pretendido em produção, esse 503 nunca podia disparar. Um
          // chargeback que não conseguiu ser gravado saía 200 e a Stripe nunca
          // reenviava. Achado pela revisão de segurança de 2026-09-08.
          // `quieto` vem do TRATADOR, não de um literal aqui: a lista de
          // espécies silenciosas (`SEM_ALARDE`) é de lá, e uma espécie nova
          // acrescentada lá faria estas rotas devolverem 503 pra sempre por
          // algo que nem devia alertar.
          if (needsRetry({
            persisted: persistido,
            quieto: marcaNaoLancavel ? marcaNaoLancavel.quieto : SEM_ALARDE.has(parsed.kind),
          })) {
            process.stderr.write(`[stripe-webhook] ${parsed.kind} SEM registro durável — devolvendo 503 pra reenvio\n`);
            return json(res, 503, {
              success: false, code: 'money_event_unrecorded',
              data: { status: parsed.kind, txid: parsed.txid },
            });
          }
          return json(res, 200, { success: true, data: { status: parsed.kind, txid: parsed.txid } });
        }
        // Disputa PERDIDA: o dinheiro foi. Vira estorno E fecha a marca — as
        // duas coisas, porque o estorno explica o saldo e o fechamento tira a
        // conta da lista de pendências (o desfecho passou a estar no dinheiro).
        if (parsed.kind === 'dispute_lost') {
          result = await applyConfirmedPayment(parsed, confirmDeps);
          if (result.checkId) {
            try {
              // O MESMO `evt_` já gravou o estorno logo acima, e a chave de
              // idempotência é única no banco inteiro — reusá-la faria este
              // append virar no-op e a disputa nunca fechar. O sufixo diz qual
              // dos dois lançamentos daquele evento é este.
              await appendValidated(store, result.checkId, 'PAYMENT_DISPUTE_CLOSED', {
                txid: parsed.txid, outcome: 'lost',
              }, parsed.eventId ? `${parsed.eventId}:closed` : null);
            } catch (e) {
              // Sem o fecho, a conta guarda um `dispute_evidence_overdue`
              // crítico pra sempre — por uma disputa já resolvida. Não pode
              // sair daqui como sucesso.
              process.stderr.write(`[stripe-webhook] fecho de disputa não gravado: ${String(e.message).slice(0, 120)}\n`);
              return json(res, 503, {
                success: false, code: 'dispute_close_unrecorded',
                data: { status: parsed.kind, txid: parsed.txid },
              });
            }
          }
          await avisarEventoDeDinheiro({
            kind: parsed.kind, txid: parsed.txid, checkId: result.checkId || null,
            amountCents: parsed.amountCents, detail: parsed.reason || null,
          });
          /**
           * O PDV TAMBÉM PRECISA SABER. Estas duas saídas voltavam antes do
           * `writeBackToPos` genérico lá embaixo — uma assimetria não decidida,
           * herdada de quando elas eram só alerta.
           *
           * Uma reversão de estorno RESTAURA `paidCents` e pode devolver a conta
           * pra `paga`: sem a sinalização, o balcão segue achando que a mesa
           * deve, e alguém vai cobrá-la. O `writeBackPayment` só sinaliza com a
           * conta 100% paga, então numa disputa perdida (que reduz o pago) ele
           * sai calado sozinho — a chamada é segura nos dois casos, e a regra de
           * "quando sinalizar" fica num lugar só (segurança LOW-2 da rodada dez).
           */
          if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
            await writeBackToPos(result.checkId);
          }
          const st = result.status === 'rejected' ? 409 : 200;
          return json(res, st, { success: st === 200, data: result });
        }
        // Pagamento que FALHOU: a linha sai de `pendente` e nada mais.
        //
        // Nenhum dinheiro se moveu, então não há lançamento. E não alerta: uma
        // recusa no app do banco é rotina, não incidente — alertar em cada uma
        // treinaria o fundador a ignorar o canal. Quem precisa saber é a
        // conciliação, e ela lê o status da linha.
        if (parsed.kind === 'payment_failed') {
          // CONDICIONAL: `expirado` só pisa em `pendente` (migração 0020).
          //
          // Era um UPDATE cego que também escrevia `confirmed_at: null`. A
          // Stripe não garante ordem e reenvia o que levou 5xx, então o
          // `payment_failed` de uma recusa podia chegar DEPOIS do `succeeded`
          // da segunda tentativa no mesmo intent — e apagava um pagamento
          // confirmado do faturamento e da gorjeta. Achado pela revisão de
          // segurança de 2026-09-08.
          const expirou = await store.expirePaymentIfPending(parsed.txid);
          return json(res, 200, {
            success: true,
            data: { status: 'payment_failed', txid: parsed.txid, expired: expirou },
          });
        }
        // Estorno que falhou: vira lançamento de REVERSÃO e alerta. As duas
        // coisas — o razão volta a dizer a verdade, e alguém precisa saber que
        // há cliente com reembolso a receber por outro caminho.
        if (parsed.kind === 'refund_failed') {
          result = await applyConfirmedPayment(parsed, confirmDeps);
          // UMA falha, UM aviso. A Stripe entrega a mesma falha em dois eventos
          // (`refund.failed` e `refund.updated` com status `failed`), e o aviso
          // saía nos dois: dois "R$ X refund_failed" idênticos no canal do
          // canário, por evento normal. Canário que se repete é canário que se
          // aprende a ignorar (inegociável #8; segurança LOW-2 de 53c9ff0).
          if (result.status !== 'duplicate') {
            await avisarEventoDeDinheiro({
              kind: parsed.kind, txid: parsed.txid,
              checkId: result.checkId || null,
              amountCents: parsed.amountCents, detail: parsed.status || null,
            });
          }
          /**
           * O PDV TAMBÉM PRECISA SABER. Estas duas saídas voltavam antes do
           * `writeBackToPos` genérico lá embaixo — uma assimetria não decidida,
           * herdada de quando elas eram só alerta.
           *
           * Uma reversão de estorno RESTAURA `paidCents` e pode devolver a conta
           * pra `paga`: sem a sinalização, o balcão segue achando que a mesa
           * deve, e alguém vai cobrá-la. O `writeBackPayment` só sinaliza com a
           * conta 100% paga, então numa disputa perdida (que reduz o pago) ele
           * sai calado sozinho — a chamada é segura nos dois casos, e a regra de
           * "quando sinalizar" fica num lugar só (segurança LOW-2 da rodada dez).
           */
          if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
            await writeBackToPos(result.checkId);
          }
          const st = result.status === 'rejected' ? 409 : 200;
          return json(res, st, { success: st === 200, data: result });
        }
        result = await applyConfirmedPayment(parsed, confirmDeps);
      } catch (err) {
        process.stderr.write(`[stripe-webhook] threw=${err.name}: ${String(err.message).slice(0, 80)}\n`);
        throw err; // WebhookVerificationError → 401 no mapa de status do catch externo
      }
      if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
        await writeBackToPos(result.checkId);
      }
      const status = result.status === 'rejected' ? 409 : 200;
      return json(res, status, { success: status === 200, data: result });
    }

    // --- house accounts: diner (public; bearer credential = accountToken) ----
    if (req.method === 'GET' && url.pathname === '/api/house/config') {
      const data = await houseSvc.publicConfig(url.searchParams.get('t') || '');
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/house/open') {
      if (!rateLimitOpen(req)) {
        return json(res, 429, { success: false, error: 'Muitas tentativas — aguarde alguns minutos', code: 'rate_limited' });
      }
      const b = JSON.parse(await readBody(req) || '{}');
      // A carteira da casa coleta NOME e TELEFONE — o dado mais pessoal do
      // produto todo. Em Espanha isso entra direto no problema de residência
      // de dado que a revisão de compliance levantou (o banco está em São
      // Paulo; titular europeu precisa de cláusulas-padrão ou de um projeto na
      // UE). Então a carteira não abre em mercado que não está liberado, e o
      // primeiro cliente espanhol não existe antes da papelada.
      const houseVenue = await store.getVenueByTableToken(b.token || '');
      const houseLive = chargingAllowed(houseVenue && houseVenue.market);
      if (houseLive) {
        return json(res, 400, { success: false, error: 'carteira indisponível neste mercado', ...houseLive });
      }
      const data = await houseSvc.openAccount({
        tableQrToken: b.token, phone: b.phone, name: b.name,
      });
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'GET' && url.pathname === '/api/house/account') {
      const data = await houseSvc.wallet(url.searchParams.get('t') || '');
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/house/load') {
      const b = JSON.parse(await readBody(req) || '{}');
      const data = await houseSvc.createLoad({
        accountToken: b.accountToken, amountCents: b.amountCents,
      });
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/house/redeem') {
      const b = JSON.parse(await readBody(req) || '{}');
      const data = await houseSvc.redeem({
        accountToken: b.accountToken, tableQrToken: b.token, amountCents: b.amountCents,
        idempotencyKey: b.idempotencyKey ?? null,
      });
      await writeBackToPos(data.checkId);
      // O ESTADO DA CONTA sai pela projeção pública, como no `/api/check`. Saía
      // cru: txids reais, motivo e prazo de disputa e as notas livres do dono
      // ("reembolsei o Pedro no Pix 11 9…") pra quem tivesse uma carteira com a
      // carga mínima e o QR da mesa (auditoria de backend H2).
      const conta = data && data.check;
      return json(res, 200, {
        success: true,
        data: conta && conta.state ? { ...data, check: { ...conta, state: publicCheckState(conta.state) } } : data,
      });
    }

    // --- recebimento (PSP recipient) — o passo com latência do onboarding ----
    if (req.method === 'GET' && url.pathname === '/api/psp/recipient') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const venue = await store.getVenue(venueId);
      if (!venue) return json(res, 404, { success: false, code: 'venue_not_found' });
      if (!temRecebedorReal(venue)) {
        return json(res, 200, { success: true, data: { recipientId: venue.pspRecipientId || null, status: null } });
      }
      // UMA FALHA DO ADQUIRENTE NÃO É "RECEBEDOR INEXISTENTE" — ver
      // `_lib/pay/recebedor.js`. Sem este `try`, um 404 e um timeout saíam
      // iguais, e a tela mandava criar um recebedor novo por cima do ativo
      // (auditoria de onboarding, C3).
      let info = null;
      try {
        info = psp.getRecipient ? await psp.getRecipient(venue.pspRecipientId) : null;
      } catch (e) {
        const falha = classificarFalhaDoRecebedor(e);
        process.stderr.write(`[recebedor] leitura falhou venue=${venueId} http=${e && e.httpStatus}: ${String(e && e.message).slice(0, 120)}\n`);
        return json(res, falha.status, { success: false, code: falha.code });
      }
      return json(res, 200, { success: true, data: info || { recipientId: venue.pspRecipientId, status: 'desconhecido' } });
    }
    // Saldo do recebedor — a prova do repasse do split ("quanto já caiu").
    if (req.method === 'GET' && url.pathname === '/api/psp/recipient/balance') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const venue = await store.getVenue(venueId);
      if (!venue || !venue.pspRecipientId || !/^r[ep]_/.test(venue.pspRecipientId)) {
        return json(res, 404, { success: false, error: 'venue sem recebedor' });
      }
      if (!psp.getRecipientBalance) return json(res, 501, { success: false, error: 'PSP não expõe saldo' });
      const bal = await psp.getRecipientBalance(venue.pspRecipientId);
      return json(res, 200, { success: true, data: bal });
    }
    if (req.method === 'POST' && url.pathname === '/api/psp/recipient') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.venueId) return json(res, 400, { success: false, error: 'venueId é obrigatório' });
      try { await auth.requireVenueOwner(user, b.venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      if (!psp.createRecipient) return json(res, 501, { success: false, error: 'PSP atual não cria recebedor' });
      // ── O DOCUMENTO QUE DECIDE PRA ONDE O DINHEIRO VAI ───────────────────
      //
      // A REGRA mora em `decidirDocumentoDoRecebedor` (api/_lib/br/documento.js),
      // pura e testada por comportamento. Aqui ficou o transporte: inline, ela
      // só dava pra "testar" com grep, e o teste que a guardava sobrevivia a
      // trocar `!==` por `===`.
      const venueDoRecebedor = await store.getVenue(b.venueId);
      if (!venueDoRecebedor) return json(res, 404, { success: false, code: 'venue_not_found' });
      const docRec = decidirDocumentoDoRecebedor({ enviado: b.document, venue: venueDoRecebedor });
      if (!docRec.ok) return json(res, 400, { success: false, code: docRec.code });
      // SUBSTITUIR o recebedor de verdade exige pedido EXPLÍCITO (`replace:
      // true`) — ver `podeCriarRecebedor`. E a falha do adquirente sai com
      // código, não com o texto do gateway.
      const criacao = podeCriarRecebedor(venueDoRecebedor, b);
      if (!criacao.ok) return json(res, criacao.status, { success: false, code: criacao.code });
      let r;
      try {
        r = await psp.createRecipient({
          name: b.name, email: b.email ?? null, document: docRec.valor, bank: b.bank,
        });
      } catch (e) {
        const falha = classificarFalhaNaCriacao(e);
        process.stderr.write(`[recebedor] criação falhou venue=${b.venueId} http=${e && e.httpStatus}: ${String(e && e.message).slice(0, 160)}\n`);
        return json(res, falha.status, { success: false, code: falha.code });
      }
      if (criacao.substitui) {
        process.stderr.write(`[recebedor] SUBSTITUÍDO venue=${b.venueId}: ${venueDoRecebedor.pspRecipientId} → ${r.recipientId}\n`);
      }
      // Persiste o status inicial (registration) + os contatos do dono pro aviso
      // de KYC: o mesmo e-mail do form + o WhatsApp opcional (a Olímpia entrega).
      await store.setVenueRecipient(b.venueId, r.recipientId, {
        status: r.status || 'registration',
        // E A CASA PASSA A TER O DOCUMENTO, se ainda não tinha. É o que
        // impede o estado "portão desarmado pra sempre": sem isto, a casa sem
        // CNPJ nunca ganhava um, e a conferência de cima nunca tinha com o
        // que comparar. Agora o documento do comprovante e o do split são o
        // mesmo por CONSTRUÇÃO, não por alguém ter preenchido os dois iguais.
        cnpj: docRec.herdar ? docRec.valor : undefined,
        notifyEmail: b.email ?? undefined,
        notifyWhatsapp: b.notifyWhatsapp ? String(b.notifyWhatsapp).replace(/[^\d+]/g, '') : undefined,
      });
      return json(res, 200, { success: true, data: r });
    }

    // --- Stripe Connect (2º rail: cartão/Apple Pay) — onboarding do restaurante
    // Cria/reusa a conta conectada e devolve o link de onboarding (KYC na hosted
    // page da Stripe — dados bancários nunca passam por nós). Inerte sem Stripe.
    if (req.method === 'POST' && url.pathname === '/api/psp/stripe-connect') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.venueId) return json(res, 400, { success: false, error: 'venueId é obrigatório' });
      try { await auth.requireVenueOwner(user, b.venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      if (!stripePsp) return json(res, 503, { success: false, error: 'cartão/Apple Pay indisponível — Stripe não configurado' });
      const venue = await store.getVenue(b.venueId);
      if (!venue) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      try {
        let accountId = venue.stripeAccountId;
        if (!accountId || !/^acct_/.test(accountId)) {
          // O MERCADO decide o país da conta conectada e quais capacidades
          // pedir. Sem isto, `country: 'BR'` fixo criava conta brasileira pra
          // uma casa espanhola — e os business locations do Bizum não incluem o
          // Brasil, então a capacidade `bizum_payments` nunca era nem pedida.
          const acct = await stripePsp.createConnectedAccount({
            email: venue.notifyEmail || undefined,
            businessName: venue.name, cnpj: venue.cnpj || undefined,
            marketCode: venue.market,
          });
          accountId = acct.recipientId;
          await store.setVenueStripeAccount(b.venueId, accountId);
        }
        const base = process.env.CLIENT_URL || 'https://racha-gray.vercel.app';
        const link = await stripePsp.createAccountLink({
          accountId,
          refreshUrl: `${base}/admin?stripe=refresh&v=${b.venueId}`,
          returnUrl: `${base}/admin?stripe=done&v=${b.venueId}`,
        });
        return json(res, 200, { success: true, data: { accountId, onboardingUrl: link.url } });
      } catch (e) {
        // Código e `vars` pelo `errorBody`, nunca a frase interna. (Esta rota
        // é o onboarding da Stripe Connect: não cria cobrança e não levanta o
        // erro de teto — o comentário que estava aqui era o da rota de
        // pagamento, copiado por um `replace` sem âncora. Achado pela revisão
        // de compliance de 2026-09-15, L1.)
        return json(res, errorStatus(e), errorBody(e));
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/psp/stripe-connect') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const venue = await store.getVenue(venueId);
      if (!venue) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      // available=false → o Stripe nem está ligado no ambiente; a UI esconde a
      // seção inteira (nada de botão que só daria 503).
      if (!stripePsp) return json(res, 200, { success: true, data: { available: false, accountId: venue.stripeAccountId || null, status: null, chargesEnabled: false } });
      if (!venue.stripeAccountId) return json(res, 200, { success: true, data: { available: true, accountId: null, status: null, chargesEnabled: false } });
      const info = await stripePsp.getConnectedAccount(venue.stripeAccountId);
      return json(res, 200, { success: true, data: { available: true, ...(info || { accountId: venue.stripeAccountId, status: 'desconhecido', chargesEnabled: false }) } });
    }

    // --- house accounts: owner (gated) ---------------------------------------
    if (req.method === 'GET' && url.pathname === '/api/house/admin') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const data = await houseSvc.adminView(venueId);
      // The reconciliation canary RUNS here — it existed but had no callers
      // (review finding): partial redeem failures were permanently silent.
      const [houseRecon, checkRecon] = await Promise.all([
        reconcileVenueHouse(store, venueId),
        // `repair: false`: este é um GET. Ele passou a escrever em linha de
        // dinheiro sem querer, quando a conciliação ganhou o reparo de
        // projeção — sem teto, sem limite de taxa e no horário que o chamador
        // escolher. O dono do conserto é o cron, que roda uma vez, com prazo e
        // com testemunha no relatório (LOW-1 da revisão de 2026-09-09).
        reconcileVenue(store, venueId, { repair: false }),
      ]);
      data.reconcile = {
        ok: houseRecon.ok && checkRecon.checksFailed === 0,
        house: { failed: houseRecon.accountsFailed, findings: houseRecon.findings },
        checks: { failed: checkRecon.checksFailed, worst: checkRecon.worstSeverity },
      };
      for (const f of houseRecon.findings) {
        if (f.severity === 'critical') {
          process.stderr.write(`RECONCILE CRITICAL venue=${venueId} ${f.code}: ${f.message}\n`);
        }
      }
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'PATCH' && url.pathname === '/api/house/admin') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.venueId) return json(res, 400, { success: false, error: 'venueId é obrigatório' });
      try { await auth.requireVenueOwner(user, b.venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const data = await houseSvc.updateConfig(b.venueId, b.config || {});
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && (url.pathname === '/api/house/admin/rotate-token' || url.pathname === '/api/house/admin/refund')) {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.accountId) return json(res, 400, { success: false, error: 'accountId é obrigatório' });
      const venueId = await houseSvc.venueIdForAccount(b.accountId);
      if (!venueId) return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const data = url.pathname.endsWith('refund')
        ? await houseSvc.refundPrincipal({ accountId: b.accountId, amountCents: b.amountCents })
        : await houseSvc.rotateToken(b.accountId);
      return json(res, 200, { success: true, data });
    }

    /**
     * O dono declara que resolveu uma pendência de dinheiro.
     *
     * O caso concreto: o estorno falhou, o dinheiro voltou pro restaurante e o
     * cliente ficou sem. A conta fica marcada até alguém reembolsar por outro
     * caminho — Pix na mão, dinheiro, o que for. Sem esta rota a marca é
     * PERMANENTE, e uma casa que nunca fica verde é uma casa que para de olhar
     * (inegociável #8).
     *
     * Exige DONO da casa e exige o porquê: "resolvido" sem autor e sem motivo é
     * só a marca sumindo. O log fica íntegro — a falha do estorno continua lá.
     */
    if (req.method === 'POST' && url.pathname === '/api/checks/resolve-issue') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.checkId || !b.txid) {
        return json(res, 400, { success: false, code: 'resolve_failed' });
      }
      const issueVenue = await store.getVenueForCheck(b.checkId);
      if (!issueVenue) return json(res, 404, { success: false, code: 'check_not_found' });
      try { await auth.requireVenueOwner(user, issueVenue.id); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, code: 'forbidden' }); }
      // O PAYLOAD sai de `payloadDaResolucao` (`_lib/checks/restitution.js`):
      // resposta escopada com texto fixo, e o autor pelo id, não pelo e-mail.
      // Mora lá pra ser testado — esta rota era o único escritor da resposta
      // escopada, e tirar o `scope` daqui não quebrava teste nenhum
      // (segurança LOW-1 de 57c0d2e).
      const payload = payloadDaResolucao(b, user);
      if (payload.note.length < 3) {
        return json(res, 400, { success: false, code: 'note_required' });
      }
      try {
        const seq = await appendValidated(store, b.checkId, 'PAYMENT_ISSUE_RESOLVED', payload);
        return json(res, 200, { success: true, data: { seq } });
      } catch (e) {
        // Só o código: a mensagem do validador é texto interno. E uma falha do
        // BANCO não é erro de quem chamou: sai 500 e fica no log, em vez de um
        // 400 que parecia culpa do cliente (compliance LOW-E de 57c0d2e).
        if (!e.statusCode || e.statusCode >= 500) {
          process.stderr.write(`[resolve-issue] falhou: ${String(e && e.message).slice(0, 160)}\n`);
          return json(res, 500, { success: false, code: 'resolve_failed' });
        }
        return json(res, e.statusCode, { success: false, code: 'resolve_failed' });
      }
    }

    /**
     * Restituição feita POR FORA do trilho — registrada pelo dono.
     *
     * `overpaidCents` só cai quando um `PAYMENT_REFUNDED` entra, e o único
     * autor desse evento era o caminho do PSP. Mas o runbook prevê o caso duas
     * vezes, com razão: a devolução Pix tem prazo de 90 dias, e passado isso a
     * saída é transferência comum; e às vezes a casa devolve em dinheiro na
     * hora. Sem esta rota, o certo a fazer deixava a marca `critical` PRA
     * SEMPRE e o telefone do cliente dizendo que a casa ainda devia — o
     * canário que grita eternamente, instalado justo no caminho de dívida com
     * o consumidor. Achado pela revisão de compliance de 2026-09-08.
     *
     * É `PAYMENT_REFUNDED` mesmo, e não um tipo novo: o dinheiro VOLTOU. O que
     * muda é o meio, e o meio fica no evento (`offRail` + a referência), pra
     * uma auditoria distinguir depois. O rateio passa pela mesma
     * `alocarDevolucaoDoPagamento` do estorno do PSP — o excedente sai do
     * consumo, e o serviço devido de um atrasado sai da gorjeta, inteiro.
     */
    if (req.method === 'POST' && url.pathname === '/api/checks/record-restitution') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.checkId || !b.txid) {
        return json(res, 400, { success: false, code: 'amount_invalid' });
      }
      const restVenue = await store.getVenueForCheck(b.checkId);
      if (!restVenue) return json(res, 404, { success: false, code: 'check_not_found' });
      try { await auth.requireVenueOwner(user, restVenue.id); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, code: 'forbidden' }); }
      const valor = b.amountCents;
      if (!Number.isSafeInteger(valor) || valor <= 0) {
        return json(res, 400, { success: false, code: 'amount_invalid' });
      }
      // A REFERÊNCIA não é enfeite: é o que prova a devolução se o cliente
      // abrir um MED depois, e o que evita a casa pagar duas vezes.
      /**
       * A REFERÊNCIA, NORMALIZADA AQUI — uma vez, antes de virar chave.
       *
       * Ela é a chave de idempotência da 0034, e os dois lados normalizavam
       * diferente: o `trim()` do JS tira toda espécie de espaço em branco, o
       * `btrim` do Postgres tira só o espaço ASCII. Uma referência terminada em
       * tabulação era duplicata pro dublê e entrava de novo em produção — e o
       * `.trim().slice(120)` anterior conseguia até CRIAR esse caso, cortando
       * no meio do espaço (segurança LOW-1 de d7f2683). Colapsando o branco
       * antes, os dois lados passam a ver a mesma string.
       *
       * `NFC` e corte por PONTO DE CÓDIGO pelo mesmo motivo: `slice(120)` corta
       * no meio de um par substituto, e `jsonb` recusa substituto solitário
       * (22P05) — a referência ficaria impossível de registrar pra sempre.
       *
       * O QUE FICA: o dobramento de caixa é feito dos dois lados
       * (`toLowerCase()` do JS contra `lower()` do Postgres) e eles divergem em
       * grego (sigma final) — o dublê agrupa onde o banco não agrupa. Pra
       * referência brasileira ou espanhola (id E2E do Pix, texto latino) as duas
       * concordam; fechar isso de vez pede uma coluna de CHAVE guardada, que é
       * mudança de esquema e vai com a próxima migração.
       */
      const ref = [...String(b.reference || '').normalize('NFC').replace(/\s+/g, ' ').trim()]
        .slice(0, 120).join('').trim();
      if (ref.length < 3) {
        return json(res, 400, { success: false, code: 'reference_required' });
      }
      // O RAZÃO QUE VAI SER CONFERIDO, e o `seq` em que ele estava. É esta
      // leitura — e não outra — que autoriza o lançamento lá embaixo: o
      // `appendEventIfUnchanged` recusa se o razão tiver andado no meio.
      const eventosAntes = await store.loadEvents(b.checkId);
      const seqEsperado = eventosAntes.length ? eventosAntes[eventosAntes.length - 1].seq : 0;
      const estado = reduce(eventosAntes);
      const pg = estado && estado.payments[String(b.txid)];
      if (!pg) return json(res, 404, { success: false, code: 'txid_unknown' });
      /**
       * O TETO é o que este pagamento DEVE, não o que ele tem.
       *
       * Era o saldo devolvível inteiro — então o dono podia registrar a
       * "devolução" de um pagamento cheio numa conta quitada: `paidCents` caía,
       * a conta voltava pra `parcial`, o telefone do cliente passava a mostrar
       * saldo devido e a mesa podia ser cobrada de novo (CDC art. 42 caput e
       * § único). E, sem excedente, o rateio cai no proporcional e leva uma
       * fatia da gorjeta — base da folha encolhida por atestação do dono, sem
       * testemunha do adquirente (Lei 13.419 + STJ Tema 1102).
       *
       * Devolução que não é restituição de excedente vai pelo TRILHO, onde o
       * adquirente é testemunha. Achado pela revisão de compliance de
       * 2026-09-08.
       */
      /**
       * O teto é o MENOR entre o excedente deste pagamento e o que a CONTA
       * ainda deve — porque `excessCents` é derivado uma vez, na confirmação,
       * e não é redevirado quando o total muda.
       *
       * O caso: paga-se 120,00 numa conta de 100,00 (excedente 20,00), a mesa
       * pede mais, `ADJUSTED` leva o total a 120,00 e `overpaidCents` vira
       * ZERO — ninguém deve nada a ninguém. Mas o excedente do pagamento
       * seguia 20,00, e a rota aceitava "restituir" isso: `paidCents` caía
       * abaixo do total, a conta voltava pra `parcial`, e uma cobrança nova
       * podia ser emitida contra quem não deve — CDC art. 42 caput e § único.
       * Medido antes de consertar: teto da rota 2000¢, devido 0¢.
       *
       * O teto da CONTA entra aqui e NÃO no `alocarDevolucao` — lá a recusa de
       * um teto por conta está certa por outro motivo: naquele caminho o
       * adquirente já testemunhou o estorno e a única pergunta é como ratear
       * entre consumo e gorjeta. Aqui a pergunta é de AUTORIZAÇÃO: quanto um
       * dono pode afirmar, sem testemunha, e com isso reduzir `paidCents`. O
       * teto por pagamento fica, então a justiça entre pagadores se mantém.
       *
       * Achado pela revisão de compliance de 2026-09-09 (R-1).
       */
      // O teto sai de `tetoDaRestituicao` (`_lib/checks/restitution.js`): o
      // excedente devido — a regra acima — E a marca do pago-depois-de-fechar
      // deste pagamento. Sem ela, um atrasado cujo estorno falhou, ou um Pix além
      // dos 90 dias da devolução, não tinha jeito verdadeiro de fechar
      // (compliance MEDIUM-A de 57c0d2e).
      // A DATA da confirmação decide o prazo do Pix (90 dias) — ver
      // `tetoDaRestituicao`.
      const linhaDoPagamento = await store.getPayment(String(b.txid)).catch(() => null);
      const limites = tetoDaRestituicao(estado, String(b.txid), {
        confirmedAt: linhaDoPagamento && linhaDoPagamento.confirmedAt,
        method: linhaDoPagamento && linhaDoPagamento.method,
      });
      const aDevolver = limites.teto;
      if (aDevolver === 0) {
        // Qual "não há" é este? A regra mora em `restitution.js` e é testada
        // sem HTTP (segurança LOW-3 de ec86b37).
        const recusa = codigoDaRecusa(estado, String(b.txid), limites);
        // Não saber a idade do pagamento é indisponibilidade, não pedido errado.
        if (recusa === 'payment_age_unknown') {
          return json(res, 503, { success: false, code: recusa });
        }
        return json(res, 400, {
          success: false,
          code: recusa,
        });
      }
      if (valor > aDevolver) {
        return json(res, 400, {
          success: false, code: 'amount_over',
          vars: { leftCents: aDevolver },
        });
      }
      /**
       * O LANÇAMENTO e a PROJEÇÃO são dois passos, e só o primeiro decide a
       * resposta.
       *
       * Estavam no mesmo `try`. Quando a projeção falhava — um 5xx do Supabase,
       * uma conexão cortada — o `catch` devolvia **400** com o texto interno do
       * PostgREST, e o dono lia "não foi possível registrar a devolução" sobre
       * um lançamento que JÁ ESTAVA no razão. Ele tentava de novo, o teto agora
       * calculava zero, e a segunda resposta era `nothing_to_restitute`: dois
       * erros contraditórios e nenhum caminho de saída.
       *
       * E o estado que ficava era pior que o de antes de existir projeção: o
       * razão dizia 9000 estornados, a linha zero, e a conciliação acusava
       * `refund_mismatch` + `ledger_drift` CRÍTICOS pra sempre — medido — por
       * uma dívida corretamente quitada. Antes da projeção, a mesma falha só
       * significava "restituição não registrada". Um conserto cujo caminho de
       * erro é pior que a ausência dele não é conserto.
       *
       * Agora: assim que o `appendValidated` devolve `seq`, a chamada deu
       * certo. A projeção é melhor-esforço e sai como aviso, nunca como falha —
       * e a conciliação passou a REPARAR essa linha (ver `reconcileCheck`), que
       * é o dono durável que faltava.
       * Achado pela revisão de segurança de 2026-09-09 (HIGH-1).
       */
      /**
       * E O LANÇAMENTO É CONDICIONAL (migração 0034).
       *
       * O teto era LIDO e depois GRAVADO, sem nada entre as duas coisas. A
       * revisão de segurança de ec86b37 mediu contra o store: duas chamadas
       * simultâneas, cada uma no teto de R$ 50, gravaram R$ 100 contra um
       * direito de R$ 50 — `paidCents` abaixo do total, a conta PAGA voltando a
       * 'parcial', o telefone de quem já pagou dizendo que a mesa deve, e uma
       * cobrança nova podendo sair contra quem não deve nada (CDC art. 42).
       * Idêntico com um `curl` repetido, porque a rota é operada à mão pelo
       * runbook e não tinha chave de idempotência.
       *
       * Agora conferir e gravar são um passo só, e o erro é CHECADO
       * (inegociável #7): `40001` = o razão mudou, refaça a conta; `23505` = esta
       * mesma devolução (conta + cobrança + referência) já está registrada, e aí
       * a resposta é a MESMA da primeira vez, que é o que um retry merece.
       */
      let seq;
      try {
        // A TESTEMUNHA vai junto: quando a devolução por fora existe porque um
        // estorno falhou, quem diz o que era consumo e o que era serviço é o
        // adquirente, não o proporcional (compliance HIGH-2 de a95e15c).
        const partes = alocarDevolucaoDoPagamento(estado, String(b.txid), pg, valor,
          limites.testemunha ? { testemunha: limites.testemunha } : {});
        seq = await appendValidated(store, b.checkId, 'PAYMENT_REFUNDED', {
          txid: String(b.txid),
          amountCents: partes.amountCents,
          tipCents: partes.tipCents,
          offRail: true,
          // POR QUE saiu do trilho — `refund_reversed` (o adquirente é
          // testemunha) ou `pix_90d`/`card_180d` (só a palavra do dono). Sem
          // isto, uma auditoria trabalhista lê o razão e não distingue as duas
          // (compliance MEDIUM-5 de ec86b37). `null` quando a devolução é de
          // SOBRA, que nunca precisou de trilho impossível.
          railImpossible: limites.motivo,
          ...(limites.revertidoEmAberto ? { reversedOpenCents: limites.revertidoEmAberto } : {}),
          reference: ref,
          by: autorDoRegistro(user),
        }, null, seqEsperado);
        var partesGravadas = partes;
      } catch (e) {
        // QUEM CLASSIFICA SQLSTATE é o `desfechoDoLancamento`, junto da lista
        // branca e do motivo dela — nunca esta rota (censo em `sql-contract`).
        const desfecho = desfechoDoLancamento(e);
        // O RAZÃO ANDOU entre a conta e o lançamento: nada foi gravado, e a
        // conta que autorizou o valor não vale mais.
        if (desfecho === 'conflito') {
          process.stderr.write(`[restituicao] conflito: o razão de ${b.checkId} mudou\n`);
          return json(res, 409, { success: false, code: 'restitution_conflict' });
        }
        /**
         * JÁ REGISTRADA? Quem responde é o RAZÃO, não o nome da restrição.
         *
         * A classificação por SQLSTATE + nome de índice é corroboração; o nome
         * vem de uma mensagem LOCALIZÁVEL (`lc_messages` é config de projeto),
         * e sem inglês o extrator devolve nulo, o desfecho vira `recusado` e a
         * rota dizia ao operador que o razão não recebeu nada — sobre uma
         * devolução que ESTÁ lá. Ele então troca a referência ("pix e2e123 (2)"),
         * ganha uma chave nova, e um SEGUNDO lançamento entra: `paidCents` cai
         * duas vezes, a conta paga volta a `parcial` e a casa paga o cliente de
         * novo (segurança MEDIUM-1 de 089e8a2). Numa chave de idempotência de
         * movimento manual de dinheiro, "recusado" não é o lado conservador.
         *
         * Então: em QUALQUER 23505, procura no razão. Achou, é reentrega.
         */
        const mesmaReferencia = (evento) => evento.type === 'PAYMENT_REFUNDED'
          && evento.payload && evento.payload.offRail === true
          && String(evento.payload.txid) === String(b.txid)
          && String(evento.payload.reference || '').replace(/\s+/g, ' ').trim().toLowerCase() === ref.toLowerCase();
        if (desfecho === 'duplicado' || podeSerReentrega(e)) {
          const jaGravado = (await store.loadEvents(b.checkId).catch(() => []))
            .filter(mesmaReferencia)
            // O QUE JÁ ESTÁ NO RAZÃO, não só "ok": quem repetiu com o valor
            // trocado por engano precisa ver que o registrado é outro número
            // (compliance LOW-2 de d7f2683).
            .map((evento) => ({ seq: evento.seq, amountCents: evento.payload.amountCents, tipCents: evento.payload.tipCents }))
            .pop() || null;
          if (jaGravado || desfecho === 'duplicado') {
            process.stderr.write(`[restituicao] reentrega da mesma referência em ${b.checkId}\n`);
            return json(res, 200, { success: true, data: { duplicate: true, recorded: jaGravado } });
          }
        }
        // AQUI sim é falha: o razão não recebeu nada. E o MESMO ponto do
        // `resolve-issue` (compliance LOW-E de 57c0d2e, agora aqui): banco fora
        // do ar não é erro de quem chamou. Um 400 dizendo "confira o valor"
        // manda conferir um valor que estava certo — e some com a única pista
        // de que a devolução pode não ter sido registrada.
        process.stderr.write(`[restituicao] lançamento recusado: ${String(e.message).slice(0, 160)}\n`);
        if (!e.statusCode || e.statusCode >= 500) {
          return json(res, 500, { success: false, code: 'restitution_unavailable' });
        }
        return json(res, e.statusCode, { success: false, code: 'restitution_failed' });
      }

      /**
       * A linha, projetada do razão. Melhor esforço, com claim condicional
       * (migração 0023) — e a conciliação repara o que não pousar aqui.
       */
      let projetada = false;
      try {
        const depois = reduce(await store.loadEvents(b.checkId));
        const pgDepois = depois && depois.payments[String(b.txid)];
        const linha = await store.getPayment(String(b.txid));
        if (pgDepois && linha) {
          const total = pgDepois.refundedAmountCents === pgDepois.amountCents
            && pgDepois.refundedTipCents === pgDepois.tipCents;
          projetada = await store.repairPaymentRow({
            txid: String(b.txid),
            expectedStatus: linha.status,
            expectedRefundedAmountCents: linha.refundedAmountCents || 0,
            expectedRefundedTipCents: linha.refundedTipCents || 0,
            status: total ? 'devolvido' : 'confirmado',
            confirmedAmountCents: pgDepois.amountCents,
            confirmedTipCents: pgDepois.tipCents,
            refundedAmountCents: pgDepois.refundedAmountCents,
            refundedTipCents: pgDepois.refundedTipCents,
            // Procedência pro log de reparo (migração 0029): a devolução fora do trilho, pedida por um dono logado.
            source: 'owner_offrail_refund',
          });
        }
      } catch (e) {
        process.stderr.write(`[restituicao] linha não projetada (a conciliação repara): ${String(e.message).slice(0, 160)}\n`);
      }
      if (!projetada) {
        process.stderr.write(`[restituicao] linha ${b.txid} pendente de projeção — a conciliação repara na varredura\n`);
      }
      return json(res, 200, {
        success: true,
        data: { seq, ...partesGravadas, rowProjectionPending: !projetada },
      });
    }

    // --- owner (gated) -------------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/api/panel') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const data = await store.getPanelView(venueId);
      if (!data) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      // A conciliação vive AQUI, no painel do restaurante, e não só na página de
      // conta-corrente: quem precisa saber que o dinheiro bate é quem recebe o
      // dinheiro. Cacheada por 60s (o painel recarrega a cada 4s).
      let recon = panelReconcileCached(venueId);
      if (!recon) {
        // `repair: false`: ESTE é o GET que importa. O painel recarrega a cada
        // 4s e o cache de 60s é um Map em processo — por instância quente e por
        // partida fria, não "uma vez por minuto" no mundo. A rota escrevia em
        // linha de dinheiro (inclusive `confirmed_tip_cents`, base da folha),
        // autenticada como dono, no horário que o chamador escolhesse, sem
        // prazo, e MOSTRAVA "tudo bate" na mesma carga — o achado do reparo é
        // `info` e o painel só desenha achado quando está vermelho.
        //
        // Eu tinha consertado o `/api/house/admin` e afirmado que "o cron é o
        // único que repara". Era falso: esta é a rota que os donos abrem.
        // Achado pela revisão de compliance de 2026-09-09 (CRITICAL-1).
        const r = await reconcileOneVenue(store, { id: venueId, name: data.venue.name }, { repair: false });
        recon = {
          severity: r.severity,
          driftCents: r.driftCents,
          checksChecked: r.checksChecked,
          accountsChecked: r.accountsChecked,
          /**
           * Os CENTAVOS vão junto, e os achados vêm ORDENADOS.
           *
           * A projeção mandava só `severity`, `code` e `message` — e o painel
           * traduz pelo código formatando os centavos, então toda frase com
           * `{amount}` saía LITERAL na tela do dono: "{amount} desta cobrança
           * foram para uma conta que não é a do restaurante". Um parâmetro
           * adicionado com padrão e nunca passado, entre dois arquivos que os
           * testes conferem cada um por si.
           *
           * E o corte pegava os cinco PRIMEIROS: `log_anomaly` (muitas vezes
           * `info`) é empilhado antes de todo achado de dinheiro, então cinco
           * informativos escondiam um `ledger_drift`. Ordena por gravidade
           * antes de cortar.
           *
           * `message` sai: é texto do servidor com centavos crus, e o painel
           * não o renderiza mais. Achado pela revisão de segurança de
           * 2026-09-08.
           */
          findings: projetarAchados(r.findings),
          at: new Date().toISOString(),
        };
        panelReconcileStore(venueId, recon);
      }
      data.reconcile = recon;
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/checks') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.tableId) return json(res, 400, { success: false, error: 'tableId é obrigatório' });
      try { await auth.requireTableOwner(user, b.tableId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const r = await checkSvc.openCheck({ tableId: b.tableId, items: b.items, totalCents: b.totalCents });
        return json(res, 200, { success: true, data: r });
      } catch (e) { return json(res, e.statusCode || 400, { success: false, error: e.message }); }
    }
    if (req.method === 'POST' && (url.pathname === '/api/checks/adjust' || url.pathname === '/api/checks/close')) {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.checkId) return json(res, 400, { success: false, error: 'checkId é obrigatório' });
      const venue = await store.getVenueForCheck(b.checkId);
      if (!venue) return json(res, 404, { success: false, error: 'conta não encontrada', code: 'check_not_found' });
      try { await auth.requireVenueOwner(user, venue.id); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const r = url.pathname.endsWith('close')
          ? await checkSvc.closeCheck({ checkId: b.checkId })
          : await checkSvc.adjustCheck({ checkId: b.checkId, items: b.items, totalCents: b.totalCents });
        return json(res, 200, { success: true, data: r });
      } catch (e) { return json(res, e.statusCode || 400, { success: false, error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = await guardUser(req, res); if (!user) return;
      const venues = await store.listVenuesForOwner(user.id);
      return json(res, 200, { success: true, data: { user: { id: user.id, email: user.email }, venues } });
    }
    if (req.method === 'POST' && url.pathname === '/api/venues') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.name || !String(b.name).trim()) return json(res, 400, { success: false, error: 'Nome é obrigatório' });
      // O DOCUMENTO DA CASA É CONFERIDO AQUI, no caminho de ESCRITA.
      //
      // Era `b.cnpj ?? null`: sem tipo, sem tamanho, sem dígito verificador —
      // enquanto o `Admin.tsx` mascarava e desarmava o botão. Cliente
      // validando e servidor não é o par clássico, e aqui ele tinha alcance:
      // o valor guardado sai no `/api/check` pra todo cliente NÃO
      // autenticado, e agora também passa pelo formatador do recibo, que é
      // quem lhe dá a aparência de conferido. Achado pela revisão de
      // segurança de 2026-09-13.
      // O MERCADO decide a FORMA do documento, então ele é lido antes e o
      // mesmo valor vai pro validador e pro store. Antes o mercado não era
      // lido aqui e o validador supunha Brasil: uma casa espanhola não
      // conseguia ser criada com documento nenhum, porque todo NIF começa ou
      // termina em letra e o portão só aceitava dígitos. Achado pela revisão
      // de compliance de 2026-09-13.
      const mkt = isMarket(b.market) ? b.market : DEFAULT_MARKET;
      const doc = normalizarDocumentoDaCasa(b.cnpj, mkt);
      // Sem frase: o servidor manda CÓDIGO e o cliente escolhe a língua
      // (CLAUDE.md). `err.tax_id_invalid` já existe nos três idiomas.
      if (!doc.ok) return json(res, 400, { success: false, code: doc.code });
      const venue = await store.createVenue({
        name: b.name, cnpj: doc.valor, city: b.city ?? null, market: mkt,
        servicoBp: Number.isInteger(b.servicoBp) ? b.servicoBp : 1000,
      });
      await store.addVenueMember(venue.id, user.id, 'owner');
      return json(res, 200, { success: true, data: venue });
    }
    if (req.method === 'GET' && url.pathname === '/api/tables') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const venue = await store.getVenue(venueId);
      if (!venue) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      // O MESMO PREDICADO DO PORTÃO, calculado aqui e não adivinhado na tela.
      // O painel perguntava `!venue.cnpj`, e o portão pergunta
      // `documentoPublicavelDaCasa` — então uma casa com CPF, com dígito
      // trocado ou com um typo de treze dígitos não via aviso nenhum e
      // continuava sem arrecadar. Exatamente a população pra que o aviso
      // existe. Dois predicados pra uma pergunta divergem; um só, não.
      const podeCobrarServico = !!documentoPublicavelDaCasa(venue.market, venue.cnpj, true);
      return json(res, 200, {
        success: true,
        data: { venue: { ...venue, podeCobrarServico }, tables: await store.listTables(venue.id) },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.venueId) return json(res, 400, { success: false, error: 'venueId é obrigatório' });
      if (!b.label || !String(b.label).trim()) return json(res, 400, { success: false, error: 'Rótulo da mesa é obrigatório' });
      try { await auth.requireVenueOwner(user, b.venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const t = await store.createTable(b.venueId, b.label);
        return json(res, 200, { success: true, data: t });
      } catch (e) {
        const dup = /duplicate/.test(e.message);
        return json(res, dup ? 409 : 400, { success: false, error: dup ? 'Já existe uma mesa com esse nome' : e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/tables/rotate') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.tableId) return json(res, 400, { success: false, error: 'tableId é obrigatório' });
      try { await auth.requireTableOwner(user, b.tableId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const r = await store.rotateTableQr(b.tableId);
      return json(res, 200, { success: true, data: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables/training') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.tableId || typeof b.training !== 'boolean') return json(res, 400, { success: false, error: 'tableId e training são obrigatórios' });
      try { await auth.requireTableOwner(user, b.tableId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const r = await store.setTableTraining(b.tableId, b.training);
      return json(res, 200, { success: true, data: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables/active') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.tableId || typeof b.active !== 'boolean') return json(res, 400, { success: false, error: 'tableId e active são obrigatórios' });
      try { await auth.requireTableOwner(user, b.tableId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const r = await store.setTableActive(b.tableId, b.active);
        return json(res, 200, { success: true, data: r });
      } catch (e) { return json(res, 409, { success: false, error: e.message }); }
    }

    // --- demo pública: beacon de abertura/pagamento pro radar da Olímpia -----
    // Sem auth de propósito: o `pl` é um token HMAC que a Olímpia cunhou e só
    // ela verifica — aqui é opaco, só se repassa (ver notifyPreviaBeacon). O
    // pior abuso com um pl vazado é a reação que a abertura real já dispararia.
    /**
     * "Alguém ABRIU a conta nesta mesa" — o primeiro degrau do funil.
     *
     * O portão de adoção do CLAUDE.md governa o roteiro, e sete semanas depois
     * da primeira casa o banco não sabia dizer quantas PESSOAS viram a tela: só
     * quantas contas o restaurante digitou e quantas foram pagas. Com isso,
     * "40 escanearam e 1 pagou" (problema de produto) e "ninguém escaneou"
     * (problema de distribuição) produziam o mesmo relatório — e pedem
     * correções opostas.
     *
     * A telemetria que existia media outra coisa: `sendBeacon` só dispara com
     * `?pl=` na URL, o token de prospecção da Olímpia. Serve pro radar de
     * vendas; o cliente na mesa de verdade não gerava nada.
     *
     * Sem dado pessoal: `session` é aleatório do navegador, não IP nem
     * impressão digital, e existe só pra não contar o mesmo telefone a cada
     * consulta de 4 segundos. Limite de taxa pelo balde da demo pública, e
     * SEMPRE 200 — telemetria jamais pode atrapalhar quem está pagando.
     */
    if (req.method === 'POST' && url.pathname === '/api/check/opened') {
      if (!rateLimitDemo(req)) return json(res, 200, { success: true, data: { skipped: 'rate' } });
      let contada = false;
      try {
        const b = JSON.parse(await readBody(req) || '{}');
        const sessao = String(b.session || '').slice(0, 64);
        if (sessao.length >= 8 && b.token) {
          const view = await store.getCheckByQrToken(String(b.token));
          const mesa = await store.getVenueByTableToken(String(b.token));
          if (view && mesa && mesa.venue) {
            contada = await store.recordCheckView({
              checkId: view.check.id,
              venueId: mesa.venue.id,
              tableId: mesa.table ? mesa.table.id : null,
              sessionHash: sessao,
            });
          }
        }
      } catch (e) {
        process.stderr.write(`[funil] abertura não registrada: ${String(e.message).slice(0, 120)}\n`);
      }
      return json(res, 200, { success: true, data: { counted: contada } });
    }

    if (req.method === 'POST' && url.pathname === '/api/demo/beacon') {
      if (!rateLimitDemo(req)) return json(res, 429, { success: false, error: 'calma lá' });
      const b = JSON.parse(await readBody(req) || '{}');
      const ev = b.event === 'paid' || b.event === 'opened' ? b.event : null;
      const pl = typeof b.pl === 'string' && b.pl.length >= 40 && b.pl.length <= 400 ? b.pl : null;
      if (!ev || !pl) return json(res, 400, { success: false, error: 'pl e event são obrigatórios' });
      await notifyPreviaBeacon({ pl, event: ev });
      // Sempre 200 pro front: beacon é best-effort, o demo nunca espelha falha daqui.
      return json(res, 200, { success: true });
    }

    // --- demo pública: reset da mesa demoracha (cron diário + on-demand) -----
    // Sem auth de propósito: só toca a mesa fixa da demonstração, é
    // idempotente e rate-limited — o pior abuso possível é... resetar a demo.
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/demo/reset') {
      if (!rateLimitDemo(req)) return json(res, 429, { success: false, error: 'calma lá' });
      const data = await resetDemoCheck(store, DEMO_TABLE_TOKEN);
      return json(res, 200, { success: true, data });
    }

    // --- cron diário: detecta a virada do KYC do recebedor e avisa o dono -----
    // Varre recebedores em 'registration', refetcha o status vivo e, na virada
    // (active/refused/suspended), persiste + dispara o aviso via Olímpia. Uma vez
    // por transição — o status persistido é a idempotência. EXIGE CRON_SECRET:
    // ver a nota dentro da rota (esta linha dizia "senão rate-limit", que era a
    // forma aberta que o censo de crons pegou).
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/recipient-status') {
      // ESCREVE (`setVenueRecipientStatus`) e chama o PSP uma vez por casa
      // pendente. Degradava aberta: sem `CRON_SECRET`, um `curl` anônimo fazia
      // a plataforma inteira bater no adquirente e recebia de volta os ids das
      // casas com KYC pendente. Mesma forma que a rota da retenção nasceu com,
      // e que o `reconcile` já tinha corrigido — achado pelo censo de crons
      // escrito depois da revisão de 2026-09-12.
      if (!process.env.CRON_SECRET) {
        process.stderr.write('[recipient-status] BLOQUEADO: CRON_SECRET não configurado\n');
        return json(res, 503, { success: false, error: 'cron indisponível', code: 'cron_secret_missing' });
      }
      // Comparação em tempo CONSTANTE: `!==` sai no primeiro byte diferente
      // e vaza o prefixo do segredo pro relógio de quem chama.
      if (!segredoConfere(req.headers.authorization, process.env.CRON_SECRET)) {
        return json(res, 401, { success: false, error: 'unauthorized' });
      }
      if (!psp.getRecipient) return json(res, 200, { success: true, data: { checked: 0, transitions: 0, note: 'PSP sem getRecipient' } });
      const pending = await store.listVenuesPendingRecipient();
      const detail = [];
      /**
       * QUEM FOI PERGUNTADO, e quantos RESPONDERAM — não quantos falharam.
       *
       * A comparação `falharam === pending.length` era furável por uma linha
       * velha: `getRecipient` devolve `null` SEM chamar ninguém quando o id não
       * é `r*_` (ver `pagarme-psp`), e o `continue` não deixava entrada no
       * `detail`. Uma casa marcada `pending` antes de ter recebedor ficava lá
       * pra sempre e desligava o canário — adquirente inteiro fora do ar, três
       * de quatro consultas com erro, cron 200 VERDE (segurança MEDIUM-1 de
       * d7f2683).
       *
       * Contar aquele `null` como "o adquirente respondeu" refazia o buraco
       * pelo outro lado. Uma chamada que nunca saiu não é sucesso nem falha: a
       * casa sem recebedor de verdade não é PERGUNTADA, aparece no relatório, e
       * o 503 olha só quem foi.
       */
      let consultadas = 0;
      let responderam = 0;
      for (const v of pending) {
        if (!temRecebedorReal(v)) {
          detail.push({ venue: v.id, note: 'pendente sem recebedor de verdade' });
          continue;
        }
        consultadas += 1;
        let info;
        try { info = await psp.getRecipient(v.pspRecipientId); }
        catch (e) { detail.push({ venue: v.id, error: String(e.message).slice(0, 120) }); continue; }
        responderam += 1;
        const live = info && info.status ? info.status : null;
        // O `null` VISÍVEL: a casa sem recebedor de verdade some do relatório e
        // é ela que sustenta a lista pendente pra sempre.
        if (!live) { detail.push({ venue: v.id, note: 'sem status vivo' }); continue; }
        if (live === v.pspRecipientStatus) continue; // sem mudança
        if (isTerminalRecipientStatus(live)) {
          // Status que interessa ao dono (active/refused/…): avisa. Só grava DEPOIS
          // que o aviso saiu — se falhar (endpoint fora), não consome a transição
          // e o próximo tick retenta (aviso perdido é pior que status 1 dia velho).
          //
          // EXCEÇÃO: aviso DESLIGADO (sem CRON_SECRET) não é falha temporária —
          // é config. Segurar a gravação aí congelaria o status pra sempre: o
          // radar mostraria "em análise" pra um recebedor já aprovado e o
          // fundador ficaria cobrando um KYC que já saiu. Então grava e marca.
          if (!podeEnviarAviso()) {
            await store.setVenueRecipientStatus(v.id, live);
            detail.push({ venue: v.id, from: v.pspRecipientStatus, to: live, notify: 'skipped_sem_secret' });
            continue;
          }
          const n = await notifyOwnerRecipientStatus({ venue: v, status: live, previousStatus: v.pspRecipientStatus });
          if (n.ok) {
            await store.setVenueRecipientStatus(v.id, live);
            detail.push({ venue: v.id, from: v.pspRecipientStatus, to: live, notify: 'sent' });
          } else {
            detail.push({ venue: v.id, from: v.pspRecipientStatus, to: live, notify: n.skipped ? 'skipped' : 'failed_retry' });
          }
        } else {
          // Intermediário (registration → affiliation → …): rastreia, sem avisar.
          await store.setVenueRecipientStatus(v.id, live);
          detail.push({ venue: v.id, from: v.pspRecipientStatus, to: live, note: 'intermediario' });
        }
      }
      const notified = detail.filter((d) => d.notify === 'sent').length;
      // TODAS as perguntas ao adquirente falharam? Isso é 503, não sucesso.
      // Com o adaptador que recusa (produção mal configurada) ou numa queda do
      // Pagar.me, o cron ficava VERDE no painel da Vercel com `checked` cheio, e
      // o único sinal era um `detail` que ninguém lê — enquanto o cron irmão,
      // quarenta linhas abaixo, devolve 503 justamente pra pintar de vermelho
      // (inegociável #8; segurança MEDIUM-1 de ec86b37).
      if (consultadas > 0 && responderam === 0) {
        process.stderr.write(`[recipient-status] o adquirente não respondeu NENHUMA das ${consultadas} consultas\n`);
        return json(res, 503, { success: false, code: 'psp_unavailable' });
      }
      return json(res, 200, { success: true, data: { checked: pending.length, notified, detail } });
    }

    // --- cron: reconciliação ativa de cobranças pendentes --------------------
    // Rede de segurança do webhook. Varre cobranças Pix/cartão ainda pendentes
    // (fora da janela de graça, dentro da janela de validade), re-pergunta ao
    // PSP e confirma as PAGAS pelo MESMO caminho do webhook (idempotente). O
    // confirm-on-read já cura a mesa que o diner está olhando; este cron pega
    // as contas que ninguém está vendo (app fechado) e escreve de volta no POS.
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/reconcile-pending') {
      // O CRON QUE MAIS ESCREVE DESTE ARQUIVO, e era o mais aberto.
      //
      // Ele varre até 200 cobranças pendentes de TODAS as casas, chama o
      // adquirente uma vez por cobrança, acrescenta `PAYMENT_CONFIRMED` ao
      // razão e escreve a baixa no PDV do restaurante — e devolvia
      // `result.details` com `txid` e `checkId` de cada uma. Sem `CRON_SECRET`
      // isso era `curl` anônimo: divulgação cross-tenant, amplificação contra o
      // adquirente, e escrita no razão. O `public-state.js` já registra por que
      // id de cobrança não pode chegar a quem não está autenticado.
      //
      // Não foi achado por revisão nenhuma: foi o censo de crons que eu escrevi
      // pra pegar OUTRA rota — e ele classificou esta como leitura, porque ela
      // escreve através de `reconciler.reconcile(...)` e não de `store.*`. Ver
      // `cron-fail-closed.test.js`, que agora presume ESCRITA por padrão.
      if (!process.env.CRON_SECRET) {
        process.stderr.write('[reconcile-pending] BLOQUEADO: CRON_SECRET não configurado\n');
        return json(res, 503, { success: false, error: 'cron indisponível', code: 'cron_secret_missing' });
      }
      // Comparação em tempo CONSTANTE: `!==` sai no primeiro byte diferente
      // e vaza o prefixo do segredo pro relógio de quem chama.
      if (!segredoConfere(req.headers.authorization, process.env.CRON_SECRET)) {
        return json(res, 401, { success: false, error: 'unauthorized' });
      }
      // O CANÁRIO DO TETO EM PRODUÇÃO. O `deploy.mjs` barra a ordem errada, mas
      // não vê um deploy que não passe por ele, nem uma migração revertida
      // depois. Sondava `release_slots`, que a 0033 anterior também tinha — um
      // banco com a versão velha passava. Agora compara a IMPRESSÃO DIGITAL das
      // funções do teto com a que este código espera (segurança M2 de
      // 7a65e93). Sem a função, todo pagamento devolve 500; com outra versão,
      // os pagamentos passam e o expurgo e as guardas são os de antes. Pagina a
      // cada quinze minutos enquanto for verdade.
      // DUAS sondas antes de chamar de erro: uma falha passageira da PostgREST
      // paginava "ninguém consegue pagar". E a DIVERGÊNCIA pagina uma vez por
      // hora por valor, não a cada quinze minutos — noventa e seis páginas por
      // dia no canal do canário de conciliação ensinam a silenciar o canal
      // (#8). O ERRO não deduplica: pode ser "ninguém paga", e o banco que
      // deduplicaria é o que falhou. (Segurança L-D e compliance LOW-D de 3a10835.)
      let impressao = null; let erroDaSonda = null;
      for (let tentativa = 0; tentativa < 2; tentativa += 1) {
        try {
          impressao = await store.slotsFingerprint(); erroDaSonda = null; break;
        } catch (e) {
          erroDaSonda = e;
          if (tentativa === 0) await new Promise((ok) => setTimeout(ok, 1000));
        }
      }
      if (impressao !== IMPRESSAO_0033) {
        const detalhe = erroDaSonda
          ? `erro: ${String(erroDaSonda && erroDaSonda.message).slice(0, 160)}`
          : `impressão ${String(impressao).slice(0, 32)}, esperada ${IMPRESSAO_0033}`;
        process.stderr.write(`[reconcile-pending] a 0033 em produção não é a deste código — ${detalhe}\n`);
        let paginar = true; let vagaDoAviso = null;
        if (!erroDaSonda) {
          try {
            const r = await store.claimSlots({ keys: [`alerta:impressao:${String(impressao).slice(0, 32)}`], limits: [1], windowMs: 60 * 60 * 1000 });
            paginar = r.claimId !== null; vagaDoAviso = r.claimId;
          } catch { paginar = true; }   // sem como deduplicar, pagina
        }
        if (paginar) {
          const envio = await notifyFounderReconcile({
            mensagem: erroDaSonda
              ? `A SONDA DO TETO FALHOU DUAS VEZES em produção — se a migração 0033 não estiver aplicada, NINGUÉM CONSEGUE PAGAR: todo /api/pay, /api/pay/stripe-intent e /api/house/load devolve 500. Aplicar supabase/migrations/0033_charge_slots.sql com psql -f. ${detalhe}`
              : `A 0033 EM PRODUÇÃO NÃO É A DESTE DEPLOY: as funções do teto instaladas diferem das que o código espera (${detalhe}). Os pagamentos passam, mas o expurgo e as guardas são os de outra versão. Reaplicar supabase/migrations/0033_charge_slots.sql pelo arquivo, com psql -f — o supabase db push pula uma versão já registrada, e esta migração foi editada no lugar; um editor que mexe em espaço em branco também muda a impressão. Este aviso se repete a cada hora enquanto for verdade.`,
            venuesRed: 0, venuesChecked: 0, driftCents: 0, worstSeverity: 'critical',
          });
          // A PONTE FALHOU: a vaga da hora VOLTA, senão uma falha passageira da
          // ponte atrasava a página em até uma hora — o `avisarTetoDisparado` já
          // devolvia as dele, e os dois caminhos discordavam (segurança LOW-3 de
          // 40d5c50).
          if (envio && envio.ok === false && vagaDoAviso) {
            try { await store.releaseSlots(vagaDoAviso); } catch { /* fica: a janela é de uma hora */ }
          }
        }
      }
      if (PLATAFORMA_QUEBRADA()) {
        process.stderr.write(`[reconcile-pending] plataforma quebrada: ${motivoDaQuebra}\n`);
        // UMA VEZ POR HORA, não a cada quinze minutos: noventa e seis páginas
        // por dia no canal do canário ensinam a silenciar o canal (segurança
        // LOW-2 de 3eea5f3). Sem como deduplicar, pagina.
        let vagaDaConfig = null; let paginarConfig = true;
        try {
          const r = await store.claimSlots({ keys: ['alerta:config-producao'], limits: [1], windowMs: 60 * 60 * 1000 });
          vagaDaConfig = r.claimId; paginarConfig = r.claimId !== null;
        } catch { paginarConfig = true; }   // sem como deduplicar, pagina
        if (paginarConfig) {
          const envioDaConfig = await notifyFounderReconcile({
            mensagem: `PLATAFORMA DE PAGAMENTO FORA (${motivoDaQuebra}): as rotas de pagamento estão recusando (503) em vez de cobrar. Configurar na Vercel e refazer o deploy.`,
            venuesRed: 0, venuesChecked: 0, driftCents: 0, worstSeverity: 'critical',
          });
          if (envioDaConfig && envioDaConfig.ok === false && vagaDaConfig) {
            try { await store.releaseSlots(vagaDaConfig); } catch { /* fica a hora */ }
          }
        }
        // E NÃO VARRE. Com o adaptador recusando, a varredura só produziria
        // erro por cobrança — e o 503 pinta o cron de vermelho no painel da
        // Vercel, que é um segundo sinal independente do aviso ao fundador
        // (inegociável #8: canário vermelho pagina, não só registra).
        return json(res, 503, { success: false, code: 'platform_misconfigured' });
      }
      // ?hours= amplia a janela pra uma varredura profunda manual (curar um
      // straggler antigo); sem ele, usa a janela padrão do reconciliador.
      const hours = Number(url.searchParams.get('hours'));
      const windowMs = Number.isFinite(hours) && hours > 0 ? hours * 3600 * 1000 : undefined;
      const result = await reconciler.reconcile({ limit: 200, ...(windowMs ? { windowMs } : {}) });
      for (const d of result.details) {
        if (d.checkId && (d.status === 'appended' || d.status === 'divergent_appended')) {
          await writeBackToPos(d.checkId);
        }
      }
      // `terminal` entra na linha de log: são cobranças MORTAS (canceladas,
      // recusadas, autorizações abandonadas). Sem isto o cron ficava mudo
      // sobre a única coisa que ele descobriu naquela varredura.
      if (result.confirmed > 0 || result.errors > 0 || result.terminal > 0) {
        process.stderr.write(`[reconcile-cron] confirmed=${result.confirmed} terminal=${result.terminal} checked=${result.checked} errors=${result.errors}\n`);
      }
      return json(res, 200, { success: true, data: result });
    }

    // --- cron: conciliação diária --------------------------------------------
    // A regra #8 do CLAUDE.md: "Conciliação desde o dia 1. Job diário: razão do
    // PSP vs nossos splits, por restaurante, ao centavo. Drift ≥ R$0,01 alerta
    // alto. Um canário vermelho PAGINA; nunca só loga."
    //
    // O canário existia e era testado, mas o único caller era GET /api/house/admin
    // — ou seja, rodava só se o dono de uma casa com conta-corrente abrisse
    // aquela página. Isto é o job.
    //
    // ?dry=1 devolve o relatório sem avisar ninguém (inspeção sem acordar
    // ninguém); ?test=1 inclui restaurantes de teste.
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/reconcile') {
      // Fecha por padrão, ao contrário dos outros crons: o corpo desta rota é o
      // retrato financeiro da PLATAFORMA inteira (nome de cada casa, drift em
      // centavos, checkId/txid/accountId). Degradar aberta era divulgação
      // cross-tenant sem auth — achado ALTO das duas revisões.
      if (!process.env.CRON_SECRET) {
        // FECHA, GRITA NO LOG, E NÃO MANDA NADA PRA FORA.
        //
        // A versão anterior PAGINAVA daqui, com um throttle de 1×/h — e este é,
        // por definição, o ramo em que não há autenticação nenhuma: é o ramo do
        // segredo ausente. O throttle era `let` de módulo numa função
        // serverless, então todo cold start o zerava: N requisições
        // concorrentes forçam N instâncias e rendem N avisos. Mais um `fetch`
        // de 8s segurado por requisição. A rota pública virava o megafone que o
        // comentário dizia estar impedindo, e o `podeEnviarAviso()` — que existe
        // pra ser o dono deste invariante — é FALSO exatamente aqui e não era
        // consultado. Achado pela revisão de segurança de 2026-09-14.
        //
        // O canário não sumiu, mudou de dono: quem sabe que a env não está
        // setada é o DEPLOY (`scripts/deploy.mjs` lê as envs do projeto pela
        // API da Vercel e falha alto), e isso não é acionável por ninguém de
        // fora. As duas rotas de cron irmãs já faziam só isto aqui.
        process.stderr.write('[reconcile-cron] BLOQUEADO: CRON_SECRET não configurado — a conciliação diária NÃO está rodando\n');
        return json(res, 503, { success: false, error: 'cron indisponível', code: 'cron_secret_missing' });
      }
      if (!segredoConfere(req.headers.authorization, process.env.CRON_SECRET)) {
        return json(res, 401, { success: false, error: 'unauthorized' });
      }
      // Canário morto ≠ canário verde (#8 + #7). Se a varredura EXPLODE, ninguém
      // saberia: sem isto o catch-all devolvia 500 e o silêncio lia como "tudo
      // bate". Estourar é o pior estado possível, então pagina como crítico.
      let report;
      try {
        /**
         * A TERCEIRA PERNA, com interruptor.
         *
         * A regra #8 diz "razão do PSP vs nossos splits", e até aqui o job
         * comparava só os nossos dois — que não são independentes, porque um é
         * projeção do outro, escrita na mesma chamada. Passar o adaptador liga
         * a conferência dos RECEBÍVEIS: pra quem o dinheiro de cada cobrança
         * foi de fato, segundo a Pagar.me.
         *
         * Janela de 24h e teto por casa porque cada cobrança é uma chamada de
         * API. E `RACHA_PAYABLES_LEG=off` desliga sem deploy: é a única coisa
         * desta série que faz I/O externo dentro do cron, e o modo de falha
         * dela é a varredura inteira morrer calada. Varredura morta não conta
         * nada a ninguém — um caminho que pode emudecer o canário precisa de um
         * jeito de desligar mais rápido que um deploy.
         */
        report = await reconcileAllVenues(store, {
          includeTest: url.searchParams.get('test') === '1',
          /**
           * SECO QUER DIZER SECO.
           *
           * `?dry=1` é documentado logo acima como "devolve o relatório sem
           * avisar ninguém (inspeção)", e só era consultado nas duas chamadas
           * de aviso — então uma inspeção RODAVA a varredura de reparo inteira
           * e depois calava o alerta sobre as escritas que acabara de fazer.
           * A testemunha que o HIGH-3 instalou era desligada exatamente pelo
           * caminho que alguém usa pra "só dar uma olhada primeiro" — e é o
           * primeiro movimento natural ao apontar `?since=` pras cobranças de
           * julho. Achado, independentemente, pelas duas revisões de
           * 2026-09-09 (compliance HIGH-A, segurança MEDIUM-2).
           */
          repair: url.searchParams.get('dry') !== '1',
          // Desligada, ela DIZ que está desligada: o relatório saía idêntico a
          // uma noite saudável e o `custody_leak` simplesmente não existia.
          ...(process.env.RACHA_PAYABLES_LEG === 'off' ? { legDisabled: true } : {
            psp,
            /**
             * A JANELA dá pra apontar pra trás — senão a perna nunca foi
             * medida contra dado real.
             *
             * Era 24h fixas, e as 7 cobranças reais são todas de 2026-07-20:
             * a conferência de custódia rodaria contra NADA e reportaria ok,
             * pra sempre, até a primeira mesa de verdade. Todas as
             * propriedades dela (que `custody_leak` dispara num recebedor
             * estranho, que cobrança sadia volta verde, que
             * `payable_shape_invalid` é raro e não constante) seriam lidas do
             * fonte, nunca observadas.
             *
             * `?since=` transforma quatro suposições em quatro observações, e
             * a rota já é fechada por `CRON_SECRET` e já tem `?dry=1`. Teto de
             * 90 dias porque cada cobrança é uma chamada de API — janela
             * aberta é varredura que não termina.
             */
            sinceIso: (() => {
              const pedido = url.searchParams.get('since');
              const t = pedido ? Date.parse(pedido) : NaN;
              const teto = Date.now() - 90 * 24 * 3600 * 1000;
              if (Number.isFinite(t) && t >= teto && t <= Date.now()) return new Date(t).toISOString();
              return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
            })(),
            limit: 25,
          }),
        });
      } catch (e) {
        const falha = `Conciliação NÃO RODOU: ${String(e && e.message).slice(0, 200)}`;
        process.stderr.write(`[reconcile-cron] EXPLODIU: ${falha}\n`);
        await notifyFounderReconcile({
          mensagem: falha, venuesRed: 0, venuesChecked: 0, driftCents: 0, worstSeverity: 'critical',
        });
        return json(res, 500, { success: false, error: 'reconcile falhou', code: 'reconcile_threw' });
      }
      /**
       * A RETENÇÃO NÃO RODA HÁ QUANTO TEMPO.
       *
       * Pendurada neste cron porque ele já roda todo dia. A retenção tem o
       * problema inverso do dinheiro: ela FALA todo dia, e em regime diz zero —
       * então quem detecta que ela parou não pode ser um humano lendo a
       * ausência de uma mensagem chata.
       *
       * Ler, decidir E AVISAR moram juntos em `_lib/checks/retention-watch.js`.
       * Tinham ficado separados: a decisão saiu pra lá e a linha que age sobre
       * ela ficou aqui, coberta só por `toMatch(/kind: 'retention_late'/)` — e
       * `if (false && retencao.atrasada)` passava com 677 verdes. O guarda
       * mudou de lugar e o buraco andou uma linha.
       */
      const retencao = await vigiarRetencao(store, notifyFounderMoneyEvent, {
        seco: url.searchParams.get('dry') === '1',
      });

      // A retenção atrasada NÃO pode apagar a batida noturna.
      //
      // A primeira versão somava a linha ao `mensagem`, e como `mensagem`
      // não-vazio manda pro ramo de alerta, uma noite verde com retenção
      // atrasada deixava de mandar `reconcile_heartbeat`. Do outro lado a
      // ausência da batida significa "a conciliação morreu" — então um problema
      // de higiene fabricava um alarme de dinheiro. São dois sinais e viajam
      // separados. Achado da revisão de segurança.
      const mensagem = formatReconcileAlert(report);
      let envio = null;
      if (mensagem && url.searchParams.get('dry') !== '1') {
        envio = await notifyFounderReconcile({
          mensagem,
          venuesRed: report.venuesRed,
          venuesChecked: report.venuesChecked,
          driftCents: report.totalDriftCents,
          worstSeverity: report.worstSeverity,
          rowsRepaired: report.rowsRepaired,
          rowsRepairAckLost: report.rowsRepairAckLost,
          rowsRepairRaced: report.rowsRepairRaced,
          rowsRepairRejected: report.rowsRepairRejected,
          infoCodes: report.infoCodes,
        });
      } else if (!mensagem && url.searchParams.get('dry') !== '1') {
        // Batimento: verde também fala. Do lado da Olímpia, a AUSÊNCIA da batida
        // noturna é o alarme — que é o único jeito de detectar cron desligado.
        envio = await notifyFounderReconcile({
          // A batida LEVA TEXTO: o campo estruturado sozinho não é leitura.
          // SEM a linha da retenção: ela viaja como `retention_late`, evento
          // próprio. Eu tinha reportado esta interpolação como morta e ela não
          // era — numa noite verde `mensagem` é null, o ramo da batida roda, e
          // a linha ia junto. O aviso saía em dois canais enquanto o comentário
          // acima dizia que os sinais viajam separados. Linha viva acreditada
          // morta é como o próximo leitor raciocina errado.
          mensagem: formatReconcileHeartbeat(report), heartbeat: true,
          venuesRed: 0, venuesChecked: report.venuesChecked,
          driftCents: report.totalDriftCents, worstSeverity: report.worstSeverity,
          rowsRepaired: report.rowsRepaired, rowsRepairAckLost: report.rowsRepairAckLost,
          rowsRepairRaced: report.rowsRepairRaced, rowsRepairRejected: report.rowsRepairRejected,
          infoCodes: report.infoCodes,
        });
      }
      // Verde também sai no log: um canário que só fala quando está ruim é
      // indistinguível de um canário quebrado.
      process.stderr.write(
        `[reconcile-cron] casas=${report.venuesChecked} vermelhas=${report.venuesRed} `
        + `pior=${report.worstSeverity} drift=${report.totalDriftCents}¢ `
        + `reparadas=${report.rowsRepaired || 0} sem_resposta=${report.rowsRepairAckLost || 0} `
        + `corridas=${report.rowsRepairRaced || 0} recusadas=${report.rowsRepairRejected || 0} `
        + `info=${(report.infoCodes || []).join(',') || '-'}\n`);
      return json(res, 200, { success: true, data: { ...report, mensagem, envio } });
    }

    // --- cron: radar de ativação ---------------------------------------------
    // Cadastrar não é ativar. Em 25/jul/2026 havia 3 restaurantes cadastrados e
    // ZERO uso real — dois travados havia dias (um sem recebedor, outro sem
    // nunca abrir conta) e nada avisava o fundador. Este cron olha o funil todo
    // dia e manda SÓ quem precisa de ação, com a ação junto.
    //
    // ?dry=1 devolve o radar sem enviar (inspeção sem incomodar ninguém).
    /**
     * A retenção, uma vez por dia.
     *
     * Fecha a lacuna 1 do mapa de dados: até 2026-09-12 nada expirava e nada
     * apagava. Anonimiza em vez de apagar — o razão é event-sourced e imutável,
     * e destruir um pagamento destruiria a contabilidade da casa. Sai o dado
     * pessoal, fica o fato de que houve pagamento. Prazos e o porquê de cada um
     * em `docs/compliance/retencao.md`.
     */
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/retention') {
      // A forma do `reconcile`, NÃO a do `activation-radar`.
      //
      // Eu tinha copiado a do radar: sem `CRON_SECRET`, cai pro `rateLimitCron`
      // e roda. O radar só LÊ; esta rota ESCREVE — e o commit `4930caa` já tinha
      // reescrito o `reconcile` exatamente pra parar de degradar aberta. Sem
      // segredo, isto virava `curl` anônimo disparando um UPDATE de tabela
      // inteira sem índice, e devolvendo a contagem de sessões de cliente da
      // plataforma toda pra quem chamasse. Achado da revisão de segurança.
      if (!process.env.CRON_SECRET) {
        // MESMA CORREÇÃO DA `/api/cron/reconcile`, e esta rota não estava no
        // relatório: quem a achou foi o censo `nenhum ramo SEM autenticação
        // manda nada pra fora`, escrito pra fechar a classe em vez do caso.
        // O ramo é o do segredo AUSENTE — não há autenticação nenhuma nele —,
        // o throttle é `let` de módulo numa função serverless (todo cold start
        // zera), e o efeito é um `fetch` de 8s por requisição. Quem sabe que a
        // env não está setada é o deploy, e é lá que o canário mora agora.
        process.stderr.write('[retencao] BLOQUEADO: CRON_SECRET não configurado — a retenção NÃO está rodando\n');
        return json(res, 503, { success: false, error: 'cron indisponível', code: 'cron_secret_missing' });
      }
      if (!segredoConfere(req.headers.authorization, process.env.CRON_SECRET)) {
        return json(res, 401, { success: false, error: 'unauthorized' });
      }
      // 501, não `200 {skipped}`. Um store sem o método num ambiente publicado é
      // DEFEITO, não configuração — e cron verde num store que não sabe
      // expurgar é sucesso silencioso enquanto a tela promete exclusão.
      if (typeof store.purgeExpiredPersonalData !== 'function') {
        process.stderr.write('[retencao] store sem purgeExpiredPersonalData — a retenção NÃO está rodando\n');
        return json(res, 501, { success: false, code: 'retention_unavailable' });
      }
      // `?dry=1` AQUI NÃO É SECO, e isso agora engana o relógio.
      //
      // Na rota da conciliação `dry` só cala o aviso; aqui a purga executa de
      // qualquer jeito E grava uma linha de `purge`, que zera o contador de 48h
      // do vigia. Uma inspeção manual passa a ser indistinguível de uma noite
      // saudável. Como não há expurgo "a seco" (a função escreve), a resposta
      // honesta é recusar: quem quer olhar consulta o registro.
      if (url.searchParams.get('dry') === '1') {
        return json(res, 400, { success: false, code: 'retention_no_dry_run' });
      }
      const purga = await store.purgeExpiredPersonalData();
      process.stderr.write(
        `[retencao] payer_labels=${purga.payerLabels} hints=${purga.payerHints} `
        + `carteiras=${purga.houseAccounts} aberturas=${purga.checkViews}\n`,
      );
      // BATIDA DIÁRIA, sempre — inclusive com tudo zero.
      //
      // Guardar "último sucesso" numa variável de módulo seria mentira: as
      // instâncias são efêmeras e a leitura viria de outra que nunca rodou. O
      // padrão que este repositório já usa é o oposto e é o certo: a batida sai
      // todo dia e a AUSÊNCIA dela é o alarme, do lado de quem recebe.
      //
      // Isto importa mais aqui do que na conciliação: enquanto a tela da conta
      // promete ao cliente que o nome dele sai em 90 dias, o cron parar não é
      // incidente de operação — é uma frase falsa dita a um consumidor no
      // momento de pagar (CDC art. 6º III). Zero muitos dias seguidos é sinal de
      // que parou, não de que não havia o que apagar.
      const dry = url.searchParams.get('dry') === '1';
      if (!dry) {
        await notifyFounderMoneyEvent({
          kind: 'retention_ok',
          detail: `Retenção ${new Date().toISOString().slice(0, 10)}: nomes ${purga.payerLabels}`
            + ` · rastros ${purga.payerHints} · carteiras ${purga.houseAccounts}`
            + ` · aberturas ${purga.checkViews}`,
        });
      }
      return json(res, 200, { success: true, data: purga });
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/activation-radar') {
      if (process.env.CRON_SECRET) {
        // Comparação em tempo CONSTANTE: `!==` sai no primeiro byte diferente
        // e vaza o prefixo do segredo pro relógio de quem chama. Havia três
        // call sites e só um usava `segredoConfere`.
        if (!segredoConfere(req.headers.authorization, process.env.CRON_SECRET)) {
          return json(res, 401, { success: false, error: 'unauthorized' });
        }
      } else if (!rateLimitCron(req)) {
        return json(res, 429, { success: false, error: 'calma lá' });
      }
      if (typeof store.listVenueActivation !== 'function') {
        return json(res, 200, { success: true, data: { skipped: 'store sem listVenueActivation' } });
      }
      const radar = montarRadar(await store.listVenueActivation(), Date.now());
      const dry = url.searchParams.get('dry') === '1';
      // Silêncio é feature: digest que chega todo dia sem novidade para de ser
      // lido. Sem alerta, não envia — e o cron ainda responde o retrato.
      let envio = { skipped: dry ? 'dry-run' : 'sem alertas' };
      if (!dry && radar.precisaEnviar && !podeEnviarAviso()) {
        envio = { skipped: 'sem CRON_SECRET — rota pública não dispara aviso' };
      } else if (!dry && radar.precisaEnviar) {
        envio = await notifyFounderActivationRadar({
          mensagem: radar.mensagem, alertas: radar.alertas.length,
          total: radar.total, ativos: radar.ativos,
        });
      }
      process.stderr.write(`[radar] total=${radar.total} ativos=${radar.ativos} alertas=${radar.alertas.length}\n`);
      return json(res, 200, {
        success: true,
        data: {
          total: radar.total, ativos: radar.ativos, porEstagio: radar.porEstagio,
          alertas: radar.alertas.map((a) => ({ name: a.name, estagio: a.estagio, acao: a.acao })),
          mensagem: radar.mensagem, envio,
        },
      });
    }

    // --- demo-only: simulate the bank confirming the Pix ---------------------
    if (DEMO_MODE && req.method === 'POST' && url.pathname === '/api/dev/confirm') {
      // Só o mock forja webhook assinado. Com o adapter real (Pagar.me test),
      // a confirmação vem do Simulador/webhook de verdade — o botão de simular
      // some (404 → o front esconde) e NUNCA há como "confirmar" uma cobrança
      // real na mão (fecha o buraco de dev/confirm em prod com dinheiro real).
      if (typeof psp.buildConfirmationWebhook !== 'function') {
        return json(res, 404, { success: false, error: 'confirmação simulada indisponível — a cobrança confirma pelo provedor' });
      }
      const body = JSON.parse(await readBody(req) || '{}');
      const payment = await store.getPayment(body.txid || '');
      const houseLoad = payment ? null : await store.findHouseLoadByTxid(body.txid || '');
      if (!payment && !houseLoad) return json(res, 404, { success: false, error: 'txid desconhecido' });
      const wh = psp.buildConfirmationWebhook(payment
        ? {
            txid: payment.txid, amountCents: payment.amountCents, tipCents: payment.tipCents,
            payerName: payment.payerLabel || 'Cliente Demo', payerCpf: '390.533.447-05',
            method: payment.method === 'card' ? 'card' : 'pix', // wallet money must not be mislabeled pix
          }
        : { txid: houseLoad.txid, amountCents: houseLoad.amountCents, tipCents: 0, payerName: 'Cliente Demo' });
      const result = await handleWebhook(wh.rawBody, wh.signature);
      if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
        await writeBackToPos(result.checkId);
      }
      /**
       * Evento de DINHEIRO que o portão não soube lançar tem que gritar.
       *
       * O adaptador do Pagar.me devolve `unusable_money_event` num
       * cancelamento PARCIAL — dinheiro saiu e não sabemos quanto — com um
       * comentário dizendo "pro chamador alertar e persistir". O chamador é
       * ESTA rota, e ela não alertava nada: a linha ficava `confirmado`, o
       * razão ficava confirmado, os dois registros concordavam, e a conciliação
       * diária reportava VERDE.
       *
       * É o mesmo estado "cliente lesado e canário calado" que acabei de fechar
       * no `refund.failed`, ainda aberto no trilho que está em produção de
       * verdade. Achado pela revisão de compliance de 2026-09-08.
       *
       * 200 continua: a Pagar.me não pode desabilitar o endpoint por causa
       * disto. O que muda é que alguém fica sabendo.
       */
      if (NON_LEDGER_KINDS.has(result.status)) {
        await handleNonLedgerMoneyEvent(result, { psp: 'mock' });
      }
      return json(res, 200, { success: true, data: result });
    }

    return json(res, 404, { success: false, error: 'not found' });
  } catch (err) {
    // A FORMA do erro mora em `_lib/http-error.js`, testada lá. Aqui só o log.
    const status = errorStatus(err);
    if (status >= 500) {
      process.stderr.write(`[500] ${url.pathname} ${String(err && err.message).slice(0, 300)}\n`);
    }
    // O `Retry-After` sai TAMBÉM daqui, e este é o caminho que importa: as duas
    // rotas que de fato devolvem 429 — `/api/pay` e `/api/house/load` — não têm
    // catch próprio e saem por este. A primeira versão do cabeçalho foi parar
    // nos dois sítios que TÊM catch local, e num deles é código inalcançável
    // (a rota de account-link nunca levanta erro com `windowMinutes`). O
    // remédio pra "uma recusa que não diz por quanto tempo" estava vivo em zero
    // dos dois caminhos que recusam. Achado pela revisão de segurança de
    // 2026-09-15 (MEDIUM-4).
    // A recusa e o aviso, na ordem que entrega os dois — ver `responderEAvisar`.
    await responderEAvisar(() => json(res, status, errorBody(err, status), cabecalhoDeEspera(err)), err);
  }
}

// `registraMissDeCheck` e `clientIp` saem pro teste: a garantia que importa —
// a resposta do 404 é SEMPRE a mesma, e o primeiro hop do XFF não é confiável —
// é de COMPORTAMENTO, e censo de fonte não prova comportamento.
module.exports = { rotuloDoAviso, avisarTetoDisparado, projetarAchados, route, store, psp, authClient, useSupabase, DEMO_MODE, registraMissDeCheck, clientIp };
