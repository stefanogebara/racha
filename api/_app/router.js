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
const { MockPsp } = require('../_lib/pay/mock-psp');
const { createWebhookHandler, applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
const { createChargeReconciler } = require('../_lib/checks/reconcile-charges');
const { createStripePsp } = require('../_lib/pay/stripe-psp');
const { reduce, remainingCents } = require('../_lib/checks/check-state');
const { createChargeService } = require('../_lib/pay/create-charge');
const { errorStatus, errorBody } = require('../_lib/http-error');
const { notifyOwnerRecipientStatus, notifyFounderActivationRadar, notifyPreviaBeacon,
        notifyFounderReconcile, notifyFounderMoneyEvent } = require('../_lib/notify');
const { montarRadar } = require('../_lib/activation/radar');
const { isTerminalRecipientStatus } = require('../_lib/recipient-status');
const { createCheckService } = require('../_lib/checks/check-service');
const { createHouseService } = require('../_lib/house/house-service');
const { reconcileVenue, reconcileVenueHouse } = require('../_lib/checks/reconcile');
const { reconcileAllVenues, reconcileOneVenue, formatReconcileAlert } = require('../_lib/checks/reconcile-daily');
const { resolvePosAdapter } = require('../_lib/pos/adapter');
const { createAuth } = require('../_lib/auth');

const useSupabase = process.env.RACHA_STORE === 'supabase';
const store = useSupabase
  ? require('../_lib/store/supabase').createSupabaseStore()
  : createMemoryStore();

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
  if (process.env.RACHA_PSP === 'pagarme') {
    return require('../_lib/pay/pagarme-psp').createPagarmePsp({
      secretKey: process.env.PAGARME_SECRET_KEY,
      webhookBasicAuth: process.env.PAGARME_WEBHOOK_AUTH || null,
    });
  }
  return new MockPsp({ webhookSecret: process.env.PSP_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex') });
}
let psp;
try {
  psp = buildPsp();
} catch (err) {
  process.stderr.write(`[psp] init FALHOU: ${err.message} — rotas de pagamento em 503, leitura segue\n`);
  const indisponivel = () => {
    const e = new Error(`pagamento indisponível: PSP não configurado (${err.message})`);
    e.statusCode = 503;
    throw e;
  };
  psp = {
    provider: 'unconfigured',
    createPixCharge: indisponivel,
    createWalletCharge: indisponivel,
    createRecipient: indisponivel,
    verifyAndParseWebhook: indisponivel,
    getRecipient: async () => null,
    getRecipientBalance: async () => null,
  };
}
const charge = createChargeService({ store, psp });
const checkSvc = createCheckService({ store });
const houseSvc = createHouseService({ store, psp });
const handleWebhook = createWebhookHandler({
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
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
const { DEMO_TOKEN, ensureDemoCheck, resetDemoCheck } = require('../_lib/demo');
const DEMO_TABLE_TOKEN = process.env.RACHA_DEMO_TABLE_TOKEN || DEMO_TOKEN;
const demoPsp = new MockPsp({ webhookSecret: process.env.PSP_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex') });
const demoCharge = createChargeService({ store, psp: demoPsp });
const demoWebhook = createWebhookHandler({
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
  psp: demoPsp,
  fallback: (parsed) => houseSvc.confirmLoadFromWebhook(parsed),
});

// The simulate-confirmation affordance only exists when explicitly enabled
// (the deployed sales DEMO uses the mock PSP; a real deploy with a live PSP
// leaves this off so nobody can mark payments confirmed).
const { chargingAllowed, market, marketGate, pspCurrency } = require('../_lib/markets');

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

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type,x-racha-signature',
  });
  res.end(JSON.stringify(body));
}

// Defensive: the serverless runtime may pre-populate req.body; otherwise read
// the raw stream (needed for the webhook HMAC).
function readBody(req) {
  if (req.body != null) {
    return Promise.resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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
function rateLimitOpen(req) {
  return rateLimitBucket(req, 'open', 10); // 10 wallet creations / 10 min / IP
}
// A auto-cura da demo ESCREVE (venue/mesa/conta) numa rota sem auth. Em estado
// saudável é no-op; o limite existe pro estado degradado (achado MÉDIO).
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

// Throttle do aviso "CRON_SECRET não configurado" (1×/h por instância).
let avisoCronSecretAte = 0;

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

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') return json(res, 200, {});

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
      if (!data) return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
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
      if (stripePsp && token !== DEMO_TABLE_TOKEN) {
        const v = await store.getVenueForCheck(data.check.id);
        if (v && v.stripeAccountId && /^acct_/.test(v.stripeAccountId)) {
          data = { ...data, venue: { ...data.venue, acceptsCard: true } };
        }
      }
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/pay') {
      const body = JSON.parse(await readBody(req) || '{}');
      const view = await store.getCheckByQrToken(body.token || '');
      if (!view) return json(res, 404, { success: false, error: 'Conta não encontrada', code: 'check_not_found' });
      // Demo isolado: a mesa de demonstração cobra pelo MockPsp próprio, nunca
      // pelo PSP real — dinheiro fake mesmo com o app em live.
      const isDemo = (body.token || '') === DEMO_TABLE_TOKEN;
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
      const result = await (isDemo ? demoCharge : charge)({
        checkId: view.check.id, amountCents: body.amountCents,
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
      if ((b.token || '') === DEMO_TABLE_TOKEN) return json(res, 400, { success: false, error: 'a demo não usa cartão' });
      const view = await store.getCheckByQrToken(b.token || '');
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
      const gate = marketGate(venue.market, { rail, amountCents, tipCents });
      if (gate) {
        return json(res, 400, { success: false, error: `mercado ${venue.market}: ${gate.code}`, ...gate });
      }
      try {
        const chargeRef = `${view.check.id}:${state.paidCents}:${amountCents}:${tipCents}`;
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
        return json(res, e.statusCode || 502, { success: false, error: e.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/psp') {
      const raw = await readBody(req);
      // Toda chegada de webhook fica visível nos logs — diagnóstico de
      // entrega (Pagar.me chamou? com auth? qual evento?) sem adivinhação.
      let evtType = '?';
      try { evtType = JSON.parse(raw).type || JSON.parse(raw).kind || '?'; } catch { /* corpo opaco */ }
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
      process.stderr.write(`[webhook] out status=${result.status}${result.reason ? ` reason=${result.reason.slice(0, 80)}` : ''}\n`);
      if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
        await writeBackToPos(result.checkId);
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
        // Disputa aberta e reembolso que falhou: não movem saldo, mas ninguém
        // descobre sozinho. A disputa vira EVENTO de ledger (o inegociável #6
        // — se ela não entra no log, o estorno de noventa dias depois não tem
        // antecedente); o reembolso falho é só alerta, porque o estorno não
        // aconteceu e inventar um evento seria mentir no razão.
        if (parsed.kind === 'dispute_opened' || parsed.kind === 'refund_failed'
            || parsed.kind === 'refund_progress') {
          const found = await store.findCheckByTxid(parsed.txid);
          if (parsed.kind === 'dispute_opened' && found) {
            try {
              await store.appendEvent(found.id, 'PAYMENT_DISPUTED', {
                txid: parsed.txid, amountCents: parsed.amountCents, reason: parsed.reason || null,
              });
            } catch (e) {
              process.stderr.write(`[stripe-webhook] disputa não gravada: ${String(e.message).slice(0, 120)}\n`);
            }
          }
          if (parsed.kind !== 'refund_progress') {
            await notifyFounderMoneyEvent({
              kind: parsed.kind, txid: parsed.txid, checkId: found ? found.id : null,
              amountCents: parsed.amountCents, detail: parsed.reason || parsed.status || null,
            });
          }
          return json(res, 200, { success: true, data: { status: parsed.kind, txid: parsed.txid } });
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
      return json(res, 200, { success: true, data });
    }

    // --- recebimento (PSP recipient) — o passo com latência do onboarding ----
    if (req.method === 'GET' && url.pathname === '/api/psp/recipient') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const venue = await store.getVenue(venueId);
      if (!venue) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      if (!venue.pspRecipientId || !/^r[ep]_/.test(venue.pspRecipientId)) {
        return json(res, 200, { success: true, data: { recipientId: venue.pspRecipientId || null, status: null } });
      }
      const info = psp.getRecipient ? await psp.getRecipient(venue.pspRecipientId) : null;
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
      const r = await psp.createRecipient({
        name: b.name, email: b.email ?? null, document: b.document, bank: b.bank,
      });
      // Persiste o status inicial (registration) + os contatos do dono pro aviso
      // de KYC: o mesmo e-mail do form + o WhatsApp opcional (a Olímpia entrega).
      await store.setVenueRecipient(b.venueId, r.recipientId, {
        status: r.status || 'registration',
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
        return json(res, e.statusCode || 502, { success: false, error: e.message });
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
        reconcileVenue(store, venueId),
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
        const r = await reconcileOneVenue(store, { id: venueId, name: data.venue.name });
        recon = {
          severity: r.severity,
          driftCents: r.driftCents,
          checksChecked: r.checksChecked,
          accountsChecked: r.accountsChecked,
          findings: r.findings.slice(0, 5).map((f) => ({
            severity: f.severity, code: f.code, message: f.message,
          })),
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
      const venue = await store.createVenue({
        name: b.name, cnpj: b.cnpj ?? null, city: b.city ?? null,
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
      return json(res, 200, { success: true, data: { venue, tables: await store.listTables(venue.id) } });
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
    if (req.method === 'POST' && url.pathname === '/api/demo/beacon') {
      if (!rateLimitOpen(req)) return json(res, 429, { success: false, error: 'calma lá' });
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
      if (!rateLimitOpen(req)) return json(res, 429, { success: false, error: 'calma lá' });
      const data = await resetDemoCheck(store, DEMO_TABLE_TOKEN);
      return json(res, 200, { success: true, data });
    }

    // --- cron diário: detecta a virada do KYC do recebedor e avisa o dono -----
    // Varre recebedores em 'registration', refetcha o status vivo e, na virada
    // (active/refused/suspended), persiste + dispara o aviso via Olímpia. Uma vez
    // por transição — o status persistido é a idempotência. Guarda por CRON_SECRET
    // quando setado; senão rate-limit (o processo é idempotente de todo jeito).
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/recipient-status') {
      if (process.env.CRON_SECRET) {
        if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
          return json(res, 401, { success: false, error: 'unauthorized' });
        }
      } else if (!rateLimitOpen(req)) {
        return json(res, 429, { success: false, error: 'calma lá' });
      }
      if (!psp.getRecipient) return json(res, 200, { success: true, data: { checked: 0, transitions: 0, note: 'PSP sem getRecipient' } });
      const pending = await store.listVenuesPendingRecipient();
      const detail = [];
      for (const v of pending) {
        let info;
        try { info = await psp.getRecipient(v.pspRecipientId); }
        catch (e) { detail.push({ venue: v.id, error: String(e.message).slice(0, 120) }); continue; }
        const live = info && info.status ? info.status : null;
        if (!live || live === v.pspRecipientStatus) continue; // sem mudança
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
      return json(res, 200, { success: true, data: { checked: pending.length, notified, detail } });
    }

    // --- cron: reconciliação ativa de cobranças pendentes --------------------
    // Rede de segurança do webhook. Varre cobranças Pix/cartão ainda pendentes
    // (fora da janela de graça, dentro da janela de validade), re-pergunta ao
    // PSP e confirma as PAGAS pelo MESMO caminho do webhook (idempotente). O
    // confirm-on-read já cura a mesa que o diner está olhando; este cron pega
    // as contas que ninguém está vendo (app fechado) e escreve de volta no POS.
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/reconcile-pending') {
      if (process.env.CRON_SECRET) {
        if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
          return json(res, 401, { success: false, error: 'unauthorized' });
        }
      } else if (!rateLimitOpen(req)) {
        return json(res, 429, { success: false, error: 'calma lá' });
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
      if (result.confirmed > 0 || result.errors > 0) {
        process.stderr.write(`[reconcile-cron] confirmed=${result.confirmed} checked=${result.checked} errors=${result.errors}\n`);
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
        // Fechar por padrão criaria um canário DESLIGADO em silêncio — trocar um
        // vazamento por um silêncio é o modo de falha #7 outra vez. Então o
        // estado "não configurado" PAGINA (no máximo 1×/h por instância, senão
        // a própria rota pública vira o megafone de quem quiser).
        process.stderr.write('[reconcile-cron] BLOQUEADO: CRON_SECRET não configurado — a conciliação diária NÃO está rodando\n');
        if (Date.now() > avisoCronSecretAte) {
          avisoCronSecretAte = Date.now() + 60 * 60 * 1000;
          await notifyFounderReconcile({
            mensagem: 'Conciliação diária BLOQUEADA: CRON_SECRET não está configurado na Vercel. '
              + 'A varredura não roda até setar a env (e a rota ficaria pública sem ela).',
            venuesRed: 0, venuesChecked: 0, driftCents: 0, worstSeverity: 'critical',
          });
        }
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
        report = await reconcileAllVenues(store, { includeTest: url.searchParams.get('test') === '1' });
      } catch (e) {
        const falha = `Conciliação NÃO RODOU: ${String(e && e.message).slice(0, 200)}`;
        process.stderr.write(`[reconcile-cron] EXPLODIU: ${falha}\n`);
        await notifyFounderReconcile({
          mensagem: falha, venuesRed: 0, venuesChecked: 0, driftCents: 0, worstSeverity: 'critical',
        });
        return json(res, 500, { success: false, error: 'reconcile falhou', code: 'reconcile_threw' });
      }
      const mensagem = formatReconcileAlert(report);
      let envio = null;
      if (mensagem && url.searchParams.get('dry') !== '1') {
        envio = await notifyFounderReconcile({
          mensagem,
          venuesRed: report.venuesRed,
          venuesChecked: report.venuesChecked,
          driftCents: report.totalDriftCents,
          worstSeverity: report.worstSeverity,
        });
      } else if (!mensagem && url.searchParams.get('dry') !== '1') {
        // Batimento: verde também fala. Do lado da Olímpia, a AUSÊNCIA da batida
        // noturna é o alarme — que é o único jeito de detectar cron desligado.
        envio = await notifyFounderReconcile({
          mensagem: null, heartbeat: true,
          venuesRed: 0, venuesChecked: report.venuesChecked,
          driftCents: report.totalDriftCents, worstSeverity: report.worstSeverity,
        });
      }
      // Verde também sai no log: um canário que só fala quando está ruim é
      // indistinguível de um canário quebrado.
      process.stderr.write(
        `[reconcile-cron] casas=${report.venuesChecked} vermelhas=${report.venuesRed} `
        + `pior=${report.worstSeverity} drift=${report.totalDriftCents}¢\n`);
      return json(res, 200, { success: true, data: { ...report, mensagem, envio } });
    }

    // --- cron: radar de ativação ---------------------------------------------
    // Cadastrar não é ativar. Em 25/jul/2026 havia 3 restaurantes cadastrados e
    // ZERO uso real — dois travados havia dias (um sem recebedor, outro sem
    // nunca abrir conta) e nada avisava o fundador. Este cron olha o funil todo
    // dia e manda SÓ quem precisa de ação, com a ação junto.
    //
    // ?dry=1 devolve o radar sem enviar (inspeção sem incomodar ninguém).
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/cron/activation-radar') {
      if (process.env.CRON_SECRET) {
        if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
          return json(res, 401, { success: false, error: 'unauthorized' });
        }
      } else if (!rateLimitOpen(req)) {
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
      return json(res, 200, { success: true, data: result });
    }

    return json(res, 404, { success: false, error: 'not found' });
  } catch (err) {
    // A FORMA do erro mora em `_lib/http-error.js`, testada lá. Aqui só o log.
    const status = errorStatus(err);
    if (status >= 500) {
      process.stderr.write(`[500] ${url.pathname} ${String(err && err.message).slice(0, 300)}\n`);
    }
    return json(res, status, errorBody(err, status));
  }
}

module.exports = { route, store, authClient, useSupabase, DEMO_MODE };
