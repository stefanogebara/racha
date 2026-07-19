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
const { resolvePosAdapter } = require('../_lib/pos/adapter');
const { createAuth } = require('../_lib/auth');

const useSupabase = process.env.RACHA_STORE === 'supabase';
const store = useSupabase
  ? require('../_lib/store/supabase').createSupabaseStore()
  : createMemoryStore();

// Stable webhook secret in prod (an instance-random secret would break
// verification across scaled instances). Random fallback for a bare local run.
const psp = new MockPsp({ webhookSecret: process.env.PSP_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex') });
const charge = createChargeService({ store, psp });
const checkSvc = createCheckService({ store });
const handleWebhook = createWebhookHandler({
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
  psp,
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
      });
      return json(res, 200, { success: true, data: result });
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/psp') {
      const raw = await readBody(req);
      const result = await handleWebhook(raw, req.headers['x-racha-signature']);
      if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
        await writeBackToPos(result.checkId);
      }
      const status = result.status === 'rejected' ? 409 : 200;
      return json(res, status, { success: status === 200, data: result });
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

    // --- demo-only: simulate the bank confirming the Pix ---------------------
    if (DEMO_MODE && req.method === 'POST' && url.pathname === '/api/dev/confirm') {
      const body = JSON.parse(await readBody(req) || '{}');
      const payment = await store.getPayment(body.txid || '');
      if (!payment) return json(res, 404, { success: false, error: 'txid desconhecido' });
      const wh = psp.buildConfirmationWebhook({
        txid: payment.txid, amountCents: payment.amountCents, tipCents: payment.tipCents,
        payerName: payment.payerLabel || 'Cliente Demo', payerCpf: '390.533.447-05',
      });
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
