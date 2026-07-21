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
const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
const { createChargeService } = require('../_lib/pay/create-charge');
const { createCheckService } = require('../_lib/checks/check-service');
const { createHouseService } = require('../_lib/house/house-service');
const { reconcileVenue, reconcileVenueHouse } = require('../_lib/checks/reconcile');
const { resolvePosAdapter } = require('../_lib/pos/adapter');
const { createAuth } = require('../_lib/auth');

const useSupabase = process.env.RACHA_STORE === 'supabase';
const store = useSupabase
  ? require('../_lib/store/supabase').createSupabaseStore()
  : createMemoryStore();

// PSP real por env (RACHA_PSP=pagarme + PAGARME_SECRET_KEY); mock é o
// default — demo e testes seguem idênticos. Stable webhook secret in prod
// (an instance-random secret would break verification across instances).
const psp = process.env.RACHA_PSP === 'pagarme'
  ? require('../_lib/pay/pagarme-psp').createPagarmePsp({
      secretKey: process.env.PAGARME_SECRET_KEY,
      webhookBasicAuth: process.env.PAGARME_WEBHOOK_AUTH || null,
    })
  : new MockPsp({ webhookSecret: process.env.PSP_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex') });
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

// The simulate-confirmation affordance only exists when explicitly enabled
// (the deployed sales DEMO uses the mock PSP; a real deploy with a live PSP
// leaves this off so nobody can mark payments confirmed).
const DEMO_MODE = process.env.RACHA_DEMO_MODE === 'true';

let auth = null;
let authClient = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
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
function rateLimitOpen(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  const nowMs = Date.now();
  const b = openBuckets.get(ip);
  if (!b || nowMs > b.resetAt) {
    openBuckets.set(ip, { count: 1, resetAt: nowMs + 10 * 60 * 1000 });
    if (openBuckets.size > 10000) openBuckets.clear(); // memory bound
    return true;
  }
  b.count += 1;
  return b.count <= 10; // 10 wallet creations / 10 min / IP
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
      const data = await store.getCheckByQrToken(url.searchParams.get('t') || '');
      if (!data) return json(res, 404, { success: false, error: 'Conta não encontrada' });
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/pay') {
      const body = JSON.parse(await readBody(req) || '{}');
      const view = await store.getCheckByQrToken(body.token || '');
      if (!view) return json(res, 404, { success: false, error: 'Conta não encontrada' });
      const result = await charge({
        checkId: view.check.id, amountCents: body.amountCents,
        tipCents: body.tipCents ?? 0, payerLabel: body.payerLabel ?? null,
        // Apple/Google Pay: tokenized card charge pelo mesmo portão de dinheiro.
        wallet: body.wallet ?? null, paymentToken: body.paymentToken ?? null,
        payerDocument: body.payerDocument ?? null, // CPF — adquirente exige em cartão
      });
      return json(res, 200, { success: true, data: result });
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

    // --- house accounts: diner (public; bearer credential = accountToken) ----
    if (req.method === 'GET' && url.pathname === '/api/house/config') {
      const data = await houseSvc.publicConfig(url.searchParams.get('t') || '');
      return json(res, 200, { success: true, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/house/open') {
      if (!rateLimitOpen(req)) {
        return json(res, 429, { success: false, error: 'Muitas tentativas — aguarde alguns minutos' });
      }
      const b = JSON.parse(await readBody(req) || '{}');
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
      await store.setVenueRecipient(b.venueId, r.recipientId);
      return json(res, 200, { success: true, data: r });
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
      if (!venueId) return json(res, 404, { success: false, error: 'Conta não encontrada' });
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
      if (!venue) return json(res, 404, { success: false, error: 'conta não encontrada' });
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

    // --- demo pública: reset da mesa demoracha (cron diário + on-demand) -----
    // Sem auth de propósito: só toca a mesa fixa da demonstração, é
    // idempotente e rate-limited — o pior abuso possível é... resetar a demo.
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/demo/reset') {
      if (!rateLimitOpen(req)) return json(res, 429, { success: false, error: 'calma lá' });
      const view = await store.getCheckByQrToken('demoracha');
      if (view && view.state.paidCents === 0 && view.state.totalCents === 21310) {
        return json(res, 200, { success: true, data: { status: 'já fresca' } });
      }
      if (view) await store.appendEvent(view.check.id, 'CLOSED', {});
      const hit = await store.getVenueByTableToken('demoracha');
      if (!hit) return json(res, 404, { success: false, error: 'demo não existe neste ambiente' });
      await store.openCheck('demoracha', [
        { id: 'i1', name: 'Picanha na chapa', priceCents: 8990 },
        { id: 'i2', name: 'Chopp artesanal (4x)', priceCents: 5560 },
        { id: 'i3', name: 'Batata rústica', priceCents: 3290 },
        { id: 'i4', name: 'Refrigerante (2x)', priceCents: 1580 },
        { id: 'i5', name: 'Pudim da casa', priceCents: 1890 },
      ]);
      return json(res, 200, { success: true, data: { status: 'resetada', totalCents: 21310 } });
    }

    // --- demo-only: simulate the bank confirming the Pix ---------------------
    if (DEMO_MODE && req.method === 'POST' && url.pathname === '/api/dev/confirm') {
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
    const status = err.statusCode || (err.name === 'WebhookVerificationError' ? 401 : 500);
    return json(res, status, { success: false, error: err.message });
  }
}

module.exports = { route, store, authClient, useSupabase, DEMO_MODE };
